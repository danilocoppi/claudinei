import { limitActive } from '../queueHold'
import type { EngineMeta, OperatorQueue, SessionInfo, TerminalState } from '../types'

/**
 * ⇄ Continuar noutro motor, a parte pura: os destinos do menu (estado e
 * pendências de cada um) e a leitura do cabeçalho do pacote de contexto que
 * chega ao destino. Sem importar o store: o `applyEvent` usa o parse, e o store
 * importa o `applyEvent`.
 */

/** Selo do pacote de contexto (cópia de `HANDOFF_PREFIX` em server/src/branch/handoff.ts). */
export const HANDOFF_PREFIX = '[Claudinei: context handoff]'

/**
 * Cabeçalho do pacote, verbatim do `cabecalho` de server/src/branch/handoff.ts,
 * seguido de uma linha em branco e das mensagens. O `withRequest` acrescenta
 * `\n\n=== request ===\n<pedido do operador>` no fim.
 */
const HEADER = new RegExp(
  `^${HANDOFF_PREFIX.replace(/[[\]]/g, '\\$&')}: This conversation continues one held with (.+?) in this same folder\\. `
  + 'Below are its (\\d+) most recent messages, whole, oldest first \\(about (\\d+) tokens\\)\\. '
  + 'The full conversation is at [\\s\\S]+?; read it only if you need something older\\. '
  + 'If no request follows, reply with one short line confirming you have the context\\.(?:\\n\\n([\\s\\S]*))?$',
)
const REQUEST_SEP = '\n\n=== request ===\n'

export interface HandoffHeader {
  engineLabel: string
  messages: number
  tokens: number
  /** As mensagens do pacote, sem o cabeçalho e sem o pedido. */
  body: string
  request?: string
}

/**
 * Lê o pacote (o texto inteiro, com o selo no começo): o motor de origem, N
 * mensagens, T tokens, o corpo e o pedido do operador, quando há. O pedido é o
 * que vem depois do ÚLTIMO `=== request ===`: o corpo pode citar um pacote
 * antigo, o pedido é o texto recém-digitado. Fora do formato, null.
 */
export function parseHandoffHeader(text: string): HandoffHeader | null {
  const m = HEADER.exec(text)
  if (!m) return null
  let body = m[4] ?? ''
  let request: string | undefined
  const sep = body.lastIndexOf(REQUEST_SEP)
  if (sep >= 0) {
    request = body.slice(sep + REQUEST_SEP.length)
    body = body.slice(0, sep)
  }
  return {
    engineLabel: m[1], messages: Number(m[2]), tokens: Number(m[3]), body,
    ...(request !== undefined ? { request } : {}),
  }
}

/**
 * Estado do destino no menu, espelhando o `checkTarget` do servidor
 * (server/src/branch/switch-engine.ts): `working` (turno em curso ou aberto no
 * terminal interativo) e `limited` recusam; `idle` tem a conversa encerrada
 * (a web confirma antes); `none` não tem sessão de pé.
 */
export type HandoffTargetState = 'none' | 'idle' | 'working' | 'limited'
export interface HandoffTarget {
  engine: EngineMeta
  state: HandoffTargetState
  /** ISO da reabertura do limite, quando conhecida. */
  limitUntil?: string
  /** O que o destino já tinha: o goal (que fica pausado), a fila e os avisos de resultado (que seguem depois do pacote). */
  pending: { goal: boolean; queue: number; taskResults: number }
}

/** De pé, sem turno: o servidor encerra para abrir a conversa nova. */
const STANDING = new Set<SessionInfo['status']>(['starting', 'idle', 'needs_attention'])
/** Ocupado: o servidor recusa. */
const BUSY = new Set<SessionInfo['status']>(['working', 'in_terminal'])

/**
 * Os destinos do ⇄: os motores da lista do terminal, instalados e diferentes do
 * de origem, na ordem do catálogo. A chave de `terminalStates` e `queues` é a do
 * `progressKey` (store.ts), `<projeto>:<motor>`.
 */
export function handoffTargets(p: {
  projectId: number
  from: string
  engines: EngineMeta[]
  listed: string[]
  sessions: Record<string, SessionInfo>
  terminalStates: Record<string, TerminalState>
  queues: Record<string, OperatorQueue>
}, now: number = Date.now()): HandoffTarget[] {
  const mine = Object.values(p.sessions).filter((s) => s.projectId === p.projectId)
  return p.engines
    .filter((e) => e.id !== p.from && e.available !== false && p.listed.includes(e.id))
    .map((engine) => {
      const key = `${p.projectId}:${engine.id}`
      const ts = p.terminalStates[key]
      const statuses = mine.filter((s) => s.engine === engine.id).map((s) => s.status)
      let state: HandoffTargetState = 'none'
      let limitUntil: string | undefined
      if (statuses.some((s) => BUSY.has(s))) state = 'working'
      else if (limitActive(ts, now)) {
        state = 'limited'
        const resets = ts?.usageLimit?.resetsAt
        if (resets != null && resets * 1000 > now) limitUntil = new Date(resets * 1000).toISOString()
      } else if (statuses.some((s) => STANDING.has(s))) state = 'idle'
      const goal = ts?.goal?.status
      return {
        engine, state, ...(limitUntil ? { limitUntil } : {}),
        pending: {
          goal: goal === 'active' || goal === 'waiting',
          queue: p.queues[key]?.items.length ?? 0,
          taskResults: ts?.taskResults.length ?? 0,
        },
      }
    })
}
