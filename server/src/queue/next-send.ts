import { limitActive } from '../restart/boot.js'
import type { TerminalStateRow } from '../restart/terminal-state.js'
import type { SlotContext } from './operator-queue.js'

/**
 * O árbitro do "próximo envio" de um terminal: quando a sessão fica livre, um
 * único lugar decide o que vai a seguir, na ordem combinada entre as trilhas:
 *
 *   1. auto-compactação e 2. retomada do Claudinei: não passam por aqui (ocupam
 *      a sessão por conta própria; o árbitro só entrega a uma sessão livre);
 *   3. o próximo item da fila do operador;
 *   4. o aviso de resultado de tarefa delegada (integração);
 *   5. a tarefa de outro agente (fila do orchestrator);
 *   6. o "continue rumo ao objetivo" (integração), sempre por último.
 *
 * Com aviso aberto esperando o operador, os lugares 3 a 6 seguram. Fila pausada
 * não é aviso: ela só faz o lugar 3 recusar, e os outros seguem.
 */

/** Um lugar da ordem. `offer` devolve true se mandou algo (a sessão ficou ocupada). */
export interface NextSendProvider { name: string; slot: number; offer(ctx: SlotContext): boolean }

/**
 * Aviso aberto no terminal, o mesmo que o operador vê: o trabalho interrompido
 * pelo reinício esperando o operador (ou a retomada), o limite de uso ativo e o
 * aviso do limite que segue na tela depois da reabertura (ação `none`: só sai
 * pelo operador). Sem isto, o primeiro "livre" depois da reabertura mandaria um
 * item cujo turno bom zeraria o limite em silêncio. O adiado não mostra aviso.
 */
export function holdsForNotice(row: TerminalStateRow, now: number = Date.now()): boolean {
  return row.interruptedAt != null || limitActive(row, now) ||
    (row.limitHitAt != null && row.limitAction !== 'snoozed')
}

/**
 * O aviso que segura o agendador, mais estreito que o `holdsForNotice`: o
 * trabalho interrompido pelo reinício esperando, ou a janela do limite ainda
 * fechada (ou com a retomada armada). O aviso do limite que segue na tela
 * depois da reabertura não segura: o turno bom do agendamento é que o tira
 * (o próprio agendamento pode ter batido no limite, e ninguém o armou).
 */
export function holdsForSchedule(row: TerminalStateRow, now: number = Date.now()): boolean {
  return row.interruptedAt != null || limitActive(row, now)
}

export function createNextSend(deps: {
  /** Ordenados por lugar aqui dentro; a integração acrescenta os lugares 4 e 6 por `register`. */
  providers: NextSendProvider[]
  holds: (projectId: number, engine: string) => boolean
  /** Sessão viva e não ocupada: starting, idle ou needs_attention (o mesmo do hasFreeSession). */
  isFree: (localId: string) => boolean
  liveLocalId: (projectId: number, engine: string) => string | null
  log?: (m: string) => void
}) {
  const log = deps.log ?? ((m: string) => console.error(m))
  // Cópia ordenada: o sort é estável, então lugares iguais ficam na ordem de chegada.
  const providers = [...deps.providers].sort((a, b) => a.slot - b.slot)

  function onSessionAvailable(ctx: SlotContext): void {
    if (deps.holds(ctx.projectId, ctx.engine)) return
    for (const p of providers) {
      // Reconfere antes de cada oferta: dois "livre" no mesmo tique, ou um lugar
      // que ocupou a sessão e devolveu false, não podem mandar duas coisas.
      if (!deps.isFree(ctx.localId)) return
      try {
        if (p.offer(ctx)) return
      } catch (err) {
        // Um lugar que quebra não pode segurar os seguintes.
        log(`[próximo envio] ${p.name} falhou em ${ctx.projectId}/${ctx.engine}: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  return {
    onSessionAvailable,

    /** Algo mudou fora do fim de turno (o aviso saiu, por exemplo): tenta a sessão viva livre do terminal. */
    poke(projectId: number, engine: string): void {
      const localId = deps.liveLocalId(projectId, engine)
      if (!localId || !deps.isFree(localId)) return
      onSessionAvailable({ projectId, engine, localId })
    },

    /** Gancho da integração: entra depois dos de lugar menor ou igual. */
    register(p: NextSendProvider): void {
      const at = providers.findIndex((q) => q.slot > p.slot)
      if (at === -1) providers.push(p)
      else providers.splice(at, 0, p)
    },
  }
}

export type NextSend = ReturnType<typeof createNextSend>
