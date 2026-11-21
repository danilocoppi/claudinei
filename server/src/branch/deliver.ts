import type { SessionManager } from '../claude/manager.js'
import type { NextSendProvider } from '../queue/next-send.js'
import { getEngine } from '../engine/index.js'
import { UserError } from '../user-error.js'

/**
 * A entrega do que o ramificar manda sozinho a uma sessão: o pacote da ⇄, o
 * pacote do `/fork` no Kimi e, na cópia recusada, o pacote mais as mensagens
 * do operador que a recusa levou.
 *
 * O desfazer segura o terminal (escrevendo arquivos na pasta, ou voltando a
 * conversa) e o rastreador recusa qualquer mensagem nesse intervalo. Mandar
 * direto perderia o conteúdo (a recusa ficava só no log). Aqui:
 * - sem trava, sai na hora, como antes (no mesmo passo síncrono de quem chama);
 * - com trava (ou a recusa do rastreador no meio do envio), o resto espera.
 *   Quem solta a trava já cutuca o árbitro do próximo envio dos terminais dela
 *   (o fim da escrita cutuca os terminais do repositório; o fim da volta, o
 *   terminal voltado). A espera é o lugar 2 do árbitro: sai antes da fila do
 *   operador (lugar 3), como sairia se tivesse ido na hora;
 * - num motor sem mensagem no meio do turno (Kimi, OpenCode recusam com
 *   "turno em andamento"), sai um texto por turno: depois do primeiro envio
 *   aceito, o resto volta à espera e sai no fim do turno, pelo mesmo lugar 2
 *   (antes da fila do operador). Com a sessão trabalhando, nem o primeiro sai;
 * - no limite (`DELIVERY_LIMIT_MS`), sem trava e com a sessão livre (um cutucão
 *   perdido), não manda direto: cutuca o árbitro, que só oferece o lugar 2 se
 *   nada mais segura o terminal (o encerramento, o aviso do limite de uso ou do
 *   trabalho interrompido, a auto-compactação pendente), e arma o relógio de
 *   novo. Mandar direto passaria por cima desses avisos: no meio do limite de
 *   uso, a mensagem falharia e seria consumida. Sem trava e com a sessão
 *   ocupada, continua esperando o fim do turno, sem prazo. Só desiste se a
 *   trava do desfazer ainda segura: na espera que já começou por ela, no
 *   primeiro limite; na espera do fim do turno, só se a trava segura em dois
 *   limites seguidos (o aviso do árbitro não faz desistir: ele sai pelo
 *   operador, que cutuca o árbitro);
 * - o terminal que termina durante a espera (fechado, apagado, morto) não
 *   espera o limite: o texto sai na hora (ver `ended`); o desligamento também;
 * - desistência ou envio que falha por outro motivo: as mensagens do operador
 *   voltam à fila gravada dele (`requeue`, pausada, para ele decidir), e o
 *   pacote (ou a mensagem que a fila não aceita) vai ao chat do terminal como
 *   `message_error` (o mesmo aviso de "mensagem pendente" do Codex), para o
 *   operador copiar e mandar de novo. Nunca some em silêncio.
 */

/** Quanto a entrega espera o desfazer soltar o terminal antes de desistir (e o intervalo entre as conferências). */
export const DELIVERY_LIMIT_MS = 2 * 60_000

/** Um texto a entregar: o pacote vai como mensagem do Claudinei; as do operador, como dele (com eco). */
export interface DeliveryItem { text: string; as: 'claudinei' | 'operator' }

export interface BranchDelivery {
  /** Entrega na ordem; o que a trava ou o turno em curso segura espera (ver o topo do arquivo). */
  deliver(localId: string, projectId: number, engine: string, items: DeliveryItem[]): void
  /** O lugar 2 do árbitro do próximo envio: entrega o que esperava a trava soltar (ou o fim do turno). */
  provider: NextSendProvider
  /** A sessão terminou (fechada, apagada ou morta; o relaunch da volta não chega aqui): o que esperava sai na hora. */
  ended(localId: string): void
  /** Mostra um aviso no chat do terminal (o pacote que não pôde ser montado, por exemplo). */
  notice(localId: string, message: string): void
  /** Encerramento: o que ainda esperava vai à fila do operador e ao chat; solta os relógios. */
  dispose(): void
}

/** As recusas do rastreador enquanto o desfazer segura o terminal (ver undo/service.ts e undo/rewind.ts). */
const HOLD_CODES = new Set(['undo_writing', 'rewind_in_progress'])
const isHold = (err: unknown): boolean => err instanceof UserError && HOLD_CODES.has(err.code)

/** Sessão de pé (o mesmo ACTIVE do manager) e, dentre elas, as que recebem agora. */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])
const FREE = new Set(['starting', 'idle', 'needs_attention'])

/**
 * `heldSeen`: a trava já segurava na última conferência (ou a espera começou
 * por ela). O limite só desiste com a trava vista duas vezes seguidas: a espera
 * do fim do turno não desiste por uma trava que acabou de pegar.
 */
interface Waiting { projectId: number; engine: string; items: DeliveryItem[]; timer: ReturnType<typeof setTimeout>; heldSeen: boolean }

export function createBranchDelivery(deps: {
  manager: Pick<SessionManager, 'send' | 'sendAsClaudinei' | 'get'>
  /** O desfazer segura o terminal (o `holds` do desfazer: escrita na pasta ou volta da conversa). */
  holds: (projectId: number, engine: string) => boolean
  broadcast: (m: object) => void
  /** O motor aceita mensagem no meio do turno (EngineCapabilities.midTurnInput). */
  acceptsMidTurn?: (engine: string) => boolean
  /**
   * Devolve à fila gravada do operador, na frente e pausada, as mensagens dele
   * que não chegaram à sessão. Lança se não pôde (terminal apagado): aí elas
   * vão ao chat como o pacote.
   */
  requeue?: (projectId: number, engine: string, texts: string[]) => void
  /**
   * Cutuca o árbitro do próximo envio do terminal (o `poke` dele). No limite,
   * com a sessão livre e sem trava, a espera passa por ele em vez de mandar
   * direto, para respeitar o que só o árbitro confere (ver o topo do arquivo).
   */
  poke: (projectId: number, engine: string) => void
  log?: (m: string) => void
}): BranchDelivery {
  const log = deps.log ?? ((m: string) => console.error(`[ramo] ${m}`))
  const acceptsMidTurn = deps.acceptsMidTurn ?? ((engine: string) => !!getEngine(engine).capabilities().midTurnInput)
  const waiting = new Map<string, Waiting>()
  const statusOf = (localId: string): string => deps.manager.get(localId)?.status ?? ''

  const notice = (localId: string, message: string): void => {
    try {
      deps.broadcast({ type: 'session_event', localId, event: { kind: 'system', subtype: 'message_error', raw: { message } } })
    } catch (err) {
      log(`aviso a ${localId} falhou: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** O texto que não saiu, no chat do terminal, com o motivo. */
  const surface = (localId: string, items: DeliveryItem[], reason: string): void => {
    for (const it of items) {
      log(`mensagem não entregue a ${localId}: ${reason}`)
      notice(localId, `Mensagem não entregue (${reason}). Copie o texto abaixo e mande de novo se precisar:\n\n${it.text}`)
    }
  }

  /**
   * Desiste do que não saiu: as mensagens do operador voltam à fila gravada
   * dele (sobrevivem ao reinício e ele decide quando mandar); o pacote, e as
   * mensagens que a fila não aceitou, vão ao chat.
   */
  const drop = (localId: string, projectId: number, engine: string, items: DeliveryItem[], reason: string): void => {
    let rest = items
    const ops = items.filter((it) => it.as === 'operator').map((it) => it.text)
    if (ops.length > 0 && deps.requeue) {
      try {
        deps.requeue(projectId, engine, ops)
        log(`${ops.length} mensagem(ns) do operador de volta à fila de ${projectId}/${engine}: ${reason}`)
        rest = items.filter((it) => it.as !== 'operator')
      } catch (err) {
        log(`a fila de ${projectId}/${engine} não aceitou de volta: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    surface(localId, rest, reason)
  }

  const forget = (localId: string): Waiting | undefined => {
    const w = waiting.get(localId)
    if (!w) return undefined
    clearTimeout(w.timer)
    waiting.delete(localId)
    return w
  }

  const arm = (localId: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => expire(localId), DELIVERY_LIMIT_MS)
    timer.unref?.()
    return timer
  }

  /** Guarda o resto. `hold`: a espera começa pela trava (o primeiro limite com ela ainda segurando desiste). */
  const park = (localId: string, projectId: number, engine: string, items: DeliveryItem[], hold: boolean): void => {
    waiting.set(localId, { projectId, engine, items, timer: arm(localId), heldSeen: hold })
  }

  /**
   * No limite: com a trava segurando (vista também na conferência anterior),
   * desiste; sem trava e com a sessão livre (cutucão perdido), cutuca o árbitro
   * (o lugar 2 recebe a vez se nenhum aviso segura) e continua esperando; com
   * a sessão ocupada, continua esperando o fim do turno (o lugar 2 oferece).
   * Um relógio por espera e um cutucão por limite: sem laço quente.
   */
  const expire = (localId: string): void => {
    const w = waiting.get(localId)
    if (!w) return
    if (deps.holds(w.projectId, w.engine)) {
      if (w.heldSeen) {
        forget(localId)
        drop(localId, w.projectId, w.engine, w.items, 'o desfazer segurou o terminal por tempo demais')
        return
      }
      w.heldSeen = true
      w.timer = arm(localId)
      return
    }
    w.heldSeen = false
    const status = statusOf(localId)
    if (!ACTIVE.has(status)) {
      // Fora do ar sem o aviso do fim (não deveria acontecer): não espera para sempre.
      forget(localId)
      drop(localId, w.projectId, w.engine, w.items, 'o terminal não está ativo')
      return
    }
    // Arma antes de cutucar: a oferta, no mesmo passo, esquece a espera (e o
    // relógio) se entrega, ou a guarda de novo com relógio próprio.
    w.timer = arm(localId)
    if (FREE.has(status)) {
      try {
        deps.poke(w.projectId, w.engine)
      } catch (err) {
        log(`cutucar o árbitro de ${w.projectId}/${w.engine} falhou: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * Manda na ordem. A recusa do rastreador no meio (a trava pegou entre a
   * conferência e o envio) guarda o resto; num motor sem mensagem no meio do
   * turno, o que vem depois do primeiro envio aceito espera o fim do turno.
   * Devolve true se algo saiu (a sessão ficou ocupada).
   */
  const send = (localId: string, projectId: number, engine: string, items: DeliveryItem[]): boolean => {
    const oneByTurn = !acceptsMidTurn(engine)
    for (let i = 0; i < items.length; i++) {
      const rest = items.slice(i)
      // Kimi e OpenCode recusariam ("turno em andamento"): o resto sai no fim do turno.
      if (oneByTurn && statusOf(localId) === 'working') {
        park(localId, projectId, engine, rest, false)
        return i > 0
      }
      const it = items[i]
      try {
        if (it.as === 'claudinei') deps.manager.sendAsClaudinei(localId, it.text)
        else deps.manager.send(localId, it.text, { echo: true })
      } catch (err) {
        if (isHold(err)) park(localId, projectId, engine, rest, true)
        else drop(localId, projectId, engine, rest, err instanceof Error ? err.message : String(err))
        return i > 0
      }
    }
    return items.length > 0
  }

  return {
    deliver(localId, projectId, engine, items) {
      if (items.length === 0) return
      // Já há o que esperar nesta sessão: vai atrás, para não passar na frente.
      const w = waiting.get(localId)
      if (w) { w.items.push(...items); return }
      // A sessão não está de pé (o revive da cópia recusada falhou): não há o que esperar.
      if (!ACTIVE.has(statusOf(localId))) {
        drop(localId, projectId, engine, [...items], 'o terminal não está ativo')
        return
      }
      if (deps.holds(projectId, engine)) { park(localId, projectId, engine, [...items], true); return }
      send(localId, projectId, engine, items)
    },

    provider: {
      name: 'branch-delivery',
      slot: 2,
      // O árbitro só oferece com a sessão livre e sem trava.
      offer(ctx) {
        const w = forget(ctx.localId)
        if (!w) return false
        return send(ctx.localId, w.projectId, w.engine, w.items)
      },
    },

    ended(localId) {
      const w = forget(localId)
      if (w) drop(localId, w.projectId, w.engine, w.items, 'o terminal foi encerrado')
    },

    notice,

    dispose() {
      for (const localId of [...waiting.keys()]) {
        const w = forget(localId)!
        log(`encerrando com ${w.items.length} mensagem(ns) esperando em ${localId}`)
        drop(localId, w.projectId, w.engine, w.items, 'o Claudinei foi encerrado')
      }
    },
  }
}
