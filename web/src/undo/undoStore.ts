import { create } from 'zustand'
import { useStore } from '../store'
import { fetchTerminalTurns } from './api'
import type { IntervalDto, TerminalTurnsDto, TurnDto } from '../../../shared/undo'

/** Os turnos de um terminal, como a rota `GET /api/undo/terminals/:localId/turns` devolve. */
export type TerminalTurns = { git: boolean; turns: TurnDto[]; outside: TurnDto[]; interactive: TurnDto[]; intervals: IntervalDto[] }

/** O terminal (projeto + motor) de cada `localId` carregado: os turnos são do terminal, não da sessão. */
type TerminalRef = { projectId: number; engine: string }

interface UndoState {
  byLocal: Record<string, TerminalTurns | undefined>
  terminalOf: Record<string, TerminalRef | undefined>
  load(localId: string): Promise<void>
  upsertTurn(t: TurnDto): void
}

// Carga em voo por localId: o número da última e os `undo_turn` que chegaram
// durante ela, reaplicados por cima da resposta (que pode ter saído antes deles).
const loadSeq: Record<string, number> = {}
const pendingTurns: Record<string, TurnDto[] | undefined> = {}

/** Troca o turno de mesmo id onde estiver; senão entra na lista dele, na ordem dos ids. */
function upsertInto(entry: TerminalTurns, t: TurnDto): TerminalTurns {
  for (const list of ['turns', 'outside', 'interactive'] as const) {
    const i = entry[list].findIndex(x => x.id === t.id)
    if (i >= 0) {
      const next = entry[list].slice()
      next[i] = t
      return { ...entry, [list]: next }
    }
  }
  const list = t.origin === 'interactive' ? 'interactive' : 'turns'
  const next = entry[list].slice()
  let at = next.length
  while (at > 0 && next[at - 1].id > t.id) at--
  next.splice(at, 0, t)
  return { ...entry, [list]: next }
}

/**
 * A resposta como o store espera: o chat ativo depende dela, e um corpo torto
 * (lista, nulo, campo faltando) vira terminal sem turnos em vez de derrubar a carga.
 */
function normalizeTurns(d: unknown): TerminalTurns {
  const o = d !== null && typeof d === 'object' && !Array.isArray(d) ? d as Partial<TerminalTurnsDto> : null
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : [])
  return {
    git: !!o && o.git !== false,
    turns: list(o?.turns), outside: list(o?.outside), interactive: list(o?.interactive), intervals: list(o?.intervals),
  }
}

const sameTerminal = (ref: TerminalRef | undefined, projectId: number, engine: string) =>
  !!ref && ref.projectId === projectId && ref.engine === engine

export const useUndoStore = create<UndoState>((set, get) => ({
  byLocal: {},
  terminalOf: {},

  async load(localId) {
    const seq = (loadSeq[localId] ?? 0) + 1
    loadSeq[localId] = seq
    pendingTurns[localId] = []
    const session = useStore.getState().sessions[localId]
    if (session) {
      set(s => ({ terminalOf: { ...s.terminalOf, [localId]: { projectId: session.projectId, engine: session.engine } } }))
    }
    let dto: TerminalTurns
    try {
      dto = normalizeTurns(await fetchTerminalTurns(localId))
    } catch (e) {
      // Uma carga mais nova assumiu: o erro desta não interessa mais.
      if (loadSeq[localId] !== seq) return
      pendingTurns[localId] = undefined
      throw e
    }
    if (loadSeq[localId] !== seq) return
    const late = pendingTurns[localId] ?? []
    pendingTurns[localId] = undefined
    let entry: TerminalTurns = dto
    for (const t of late) entry = upsertInto(entry, t)
    set(s => {
      // Sem sessão conhecida, o terminal sai dos próprios turnos.
      const any = dto.turns[0] ?? dto.outside[0] ?? dto.interactive[0]
      const ref = s.terminalOf[localId] ?? (any ? { projectId: any.projectId, engine: any.engine } : undefined)
      return {
        byLocal: { ...s.byLocal, [localId]: entry },
        ...(ref && !s.terminalOf[localId] ? { terminalOf: { ...s.terminalOf, [localId]: ref } } : {}),
      }
    })
  },

  upsertTurn(t) {
    const { byLocal, terminalOf } = get()
    const changed: Record<string, TerminalTurns> = {}
    for (const localId of Object.keys(terminalOf)) {
      if (!sameTerminal(terminalOf[localId], t.projectId, t.engine)) continue
      pendingTurns[localId]?.push(t)
      const entry = byLocal[localId]
      if (entry) changed[localId] = upsertInto(entry, t)
    }
    if (Object.keys(changed).length > 0) set(s => ({ byLocal: { ...s.byLocal, ...changed } }))
  },
}))

/** Recarrega, sem esperar nem lançar, os terminais carregados que passam no filtro. */
function reloadWhere(pick: (localId: string, ref: TerminalRef | undefined) => boolean): void {
  const { byLocal, terminalOf, load } = useUndoStore.getState()
  for (const localId of Object.keys(byLocal)) {
    if (!byLocal[localId] || !pick(localId, terminalOf[localId])) continue
    load(localId).catch(e => console.warn('[undo] recarga dos turnos falhou', localId, e))
  }
}

/**
 * Mensagens do WebSocket do desfazer, ao lado do `applyWsMessage`:
 * - `undo_turn`: o turno novo ou atualizado entra nos terminais carregados dele;
 * - `undo_run`: recarrega os terminais carregados do projeto (o desfazer muda
 *   o último desfazer dos turnos e os intervalos do repositório, de todos os motores).
 */
export function applyUndoWsMessage(msg: any): void {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'undo_turn' && msg.turn && typeof msg.turn.id === 'number') {
    useUndoStore.getState().upsertTurn(msg.turn as TurnDto)
  } else if (msg.type === 'undo_run' && typeof msg.projectId === 'number') {
    reloadWhere((_id, ref) => ref?.projectId === msg.projectId)
  }
}

// Reconexão: o servidor não reenvia o que se perdeu na queda. Mesmo sinal do
// `resyncOnReconnect` (`progressEpoch`), que as outras sincronizações usam.
useStore.subscribe((s, prev) => {
  if (s.progressEpoch !== prev.progressEpoch) reloadWhere(() => true)
})
