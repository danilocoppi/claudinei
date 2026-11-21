import type { AgentEvent } from '../engine/types.js'

/** O terminal de onde vem o aviso ao rastreador de turnos. */
export interface UndoCtx { localId: string; projectId: number; engine: string }

export type InputOrigin = 'operator' | 'claudinei' | 'task' | 'schedule'

export interface StatusInfo {
  /** O turno em curso é uma compactação. Lido numa microtask: o manager liga a marca depois do status. */
  compaction: () => boolean
  engineSessionId: string | null
  /** O serviço está parando: `stopped` vira fim `restart`. */
  shuttingDown: boolean
}

/** O único tipo que o manager importa deste módulo. */
export interface TurnObserver {
  /** Antes de cada mensagem que entra na sessão (menos /compact). Chama `send` com o texto final; o que `send` lança sobe e nada é gravado. */
  onInput(ctx: UndoCtx, text: string, origin: InputOrigin, send: (finalText: string) => void): void
  onStatus(ctx: UndoCtx, status: string, info: StatusInfo): void
  onEvent(ctx: UndoCtx, event: AgentEvent): void
  onInteractive(ctx: UndoCtx, phase: 'open' | 'close'): void
}
