import type { SessionManager } from '../claude/manager.js'
import type { NextSendProvider } from '../queue/next-send.js'
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
 * - no limite (`DELIVERY_LIMIT_MS`), uma última tentativa se a trava já
 *   soltou (um cutucão perdido); senão desiste;
 * - desistência ou envio que falha por outro motivo: cada texto vai ao chat
 *   do terminal como `message_error` (o mesmo aviso de "mensagem pendente" do
 *   Codex), para o operador copiar e mandar de novo. Nunca some em silêncio.
 */

/** Quanto a entrega espera o desfazer soltar o terminal antes de desistir. */
export const DELIVERY_LIMIT_MS = 2 * 60_000

/** Um texto a entregar: o pacote vai como mensagem do Claudinei; as do operador, como dele (com eco). */
export interface DeliveryItem { text: string; as: 'claudinei' | 'operator' }

export interface BranchDelivery {
  /** Entrega na ordem; o que a trava segura espera (ver o topo do arquivo). */
  deliver(localId: string, projectId: number, engine: string, items: DeliveryItem[]): void
  /** O lugar 2 do árbitro do próximo envio: entrega o que esperava a trava soltar. */
  provider: NextSendProvider
  /** Encerramento: solta os relógios; o que ainda esperava vai ao log. */
  dispose(): void
}

/** As recusas do rastreador enquanto o desfazer segura o terminal (ver undo/service.ts e undo/rewind.ts). */
const HOLD_CODES = new Set(['undo_writing', 'rewind_in_progress'])
const isHold = (err: unknown): boolean => err instanceof UserError && HOLD_CODES.has(err.code)

interface Waiting { projectId: number; engine: string; items: DeliveryItem[]; timer: ReturnType<typeof setTimeout> }

export function createBranchDelivery(deps: {
  manager: Pick<SessionManager, 'send' | 'sendAsClaudinei'>
  /** O desfazer segura o terminal (o `holds` do desfazer: escrita na pasta ou volta da conversa). */
  holds: (projectId: number, engine: string) => boolean
  broadcast: (m: object) => void
  log?: (m: string) => void
}): BranchDelivery {
  const log = deps.log ?? ((m: string) => console.error(`[ramo] ${m}`))
  const waiting = new Map<string, Waiting>()

  /** O texto que não saiu, no chat do terminal, com o motivo. */
  const surface = (localId: string, items: DeliveryItem[], reason: string): void => {
    for (const it of items) {
      log(`mensagem não entregue a ${localId}: ${reason}`)
      const message = `Mensagem não entregue (${reason}). Copie o texto abaixo e mande de novo se precisar:\n\n${it.text}`
      try {
        deps.broadcast({ type: 'session_event', localId, event: { kind: 'system', subtype: 'message_error', raw: { message } } })
      } catch (err) {
        log(`aviso da mensagem não entregue a ${localId} falhou: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const forget = (localId: string): void => {
    const w = waiting.get(localId)
    if (!w) return
    clearTimeout(w.timer)
    waiting.delete(localId)
  }

  /** No limite: manda se a trava já soltou (cutucão perdido), senão desiste com o texto no chat. */
  const expire = (localId: string): void => {
    const w = waiting.get(localId)
    if (!w) return
    forget(localId)
    if (deps.holds(w.projectId, w.engine)) {
      surface(localId, w.items, 'o desfazer segurou o terminal por tempo demais')
      return
    }
    send(localId, w.projectId, w.engine, w.items, { park: false })
  }

  const park = (localId: string, projectId: number, engine: string, items: DeliveryItem[]): void => {
    const timer = setTimeout(() => expire(localId), DELIVERY_LIMIT_MS)
    timer.unref?.()
    waiting.set(localId, { projectId, engine, items, timer })
  }

  /**
   * Manda na ordem. A recusa do rastreador no meio (a trava pegou entre a
   * conferência e o envio) guarda o resto (`park`) ou, já no limite, desiste.
   * Devolve true se algo saiu (a sessão ficou ocupada).
   */
  const send = (localId: string, projectId: number, engine: string, items: DeliveryItem[], opts: { park: boolean }): boolean => {
    let sent = false
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      try {
        if (it.as === 'claudinei') deps.manager.sendAsClaudinei(localId, it.text)
        else deps.manager.send(localId, it.text, { echo: true })
        sent = true
      } catch (err) {
        const rest = items.slice(i)
        if (isHold(err) && opts.park) park(localId, projectId, engine, rest)
        else surface(localId, rest, err instanceof Error ? err.message : String(err))
        return sent
      }
    }
    return sent
  }

  return {
    deliver(localId, projectId, engine, items) {
      if (items.length === 0) return
      // Já há o que esperar nesta sessão: vai atrás, para não passar na frente.
      const w = waiting.get(localId)
      if (w) { w.items.push(...items); return }
      if (deps.holds(projectId, engine)) { park(localId, projectId, engine, [...items]); return }
      send(localId, projectId, engine, items, { park: true })
    },

    provider: {
      name: 'branch-delivery',
      slot: 2,
      // O árbitro só oferece com a sessão livre e sem trava.
      offer(ctx) {
        const w = waiting.get(ctx.localId)
        if (!w) return false
        forget(ctx.localId)
        return send(ctx.localId, w.projectId, w.engine, w.items, { park: true })
      },
    },

    dispose() {
      for (const [localId, w] of waiting) {
        clearTimeout(w.timer)
        log(`encerrando com ${w.items.length} mensagem(ns) esperando o desfazer em ${localId}`)
      }
      waiting.clear()
    },
  }
}
