import type { TerminalState } from './types'

/** Limite sem reabertura conhecida: ativo até 5 h depois de gravado (o mesmo teto do servidor). */
const UNKNOWN_RESET_ACTIVE_MS = 5 * 60 * 60 * 1000

/**
 * Data do servidor em epoch ms. O SQLite grava "AAAA-MM-DD HH:MM:SS" em UTC e
 * sem fuso; um ISO com fuso também é aceito. Ilegível dá NaN.
 */
const serverMs = (s: string): number =>
  Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`)

/**
 * A fila segura enquanto o terminal tem aviso aberto: espelha `holdsForNotice`
 * (server/src/queue/next-send.ts) com `limitActive` (server/src/restart/boot.ts).
 *
 * Segura com o trabalho interrompido pelo reinício, com o aviso do limite na
 * tela (qualquer ação menos o adiado, mesmo depois da reabertura: só sai pelo
 * operador) e com o limite ainda ativo (armado; reabertura no futuro; ou, sem
 * reabertura conhecida, até 5 h depois de gravado). O adiado só segura enquanto
 * o limite está ativo. Segurar não é pausar: a fila não perde a vez, só espera.
 */
export function queueHeld(state: TerminalState | undefined, now: number = Date.now()): boolean {
  if (!state) return false
  if (state.interruption != null) return true
  const limit = state.usageLimit
  if (!limit) return false
  if (limit.action !== 'snoozed') return true
  // Daqui em diante só o adiado: segura enquanto o limite está ativo.
  if (limit.resetsAt == null) return serverMs(limit.hitAt) + UNKNOWN_RESET_ACTIVE_MS > now
  return limit.resetsAt * 1000 > now
}
