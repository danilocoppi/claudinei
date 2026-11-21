import { req } from '../api'
import type {
  ChangedFilesDto, FileDiff, RestoreAction, RewindMode, RewindOptionsDto, RewindResultDto, RewindTarget,
  TerminalTurnsDto, UndoPreview, UndoRunDto,
} from '../../../shared/undo'

/**
 * Rotas do desfazer turno (server/src/routes/undo.ts). Os erros saem do `req`
 * já traduzidos, com `code` e `params`; o 409 `undo_changed` traz também a
 * prévia nova em `preview`.
 */
export type UndoApiError = Error & {
  status?: number
  code?: string
  params?: Record<string, string | number>
  preview?: UndoPreview
}

/** A prévia nova de um 409 `undo_changed`; null para qualquer outro erro. */
export function changedPreview(err: unknown): UndoPreview | null {
  const e = err as UndoApiError | null
  return e && e.code === 'undo_changed' && e.preview ? e.preview : null
}

/** O que o operador decidiu por arquivo na prévia, e o token dela. */
export interface UndoDecision { token: string; decisions: Record<string, RestoreAction> }

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
const enc = encodeURIComponent

export const fetchTerminalTurns = (localId: string) =>
  req<TerminalTurnsDto>(`/api/undo/terminals/${enc(localId)}/turns`)

export const fetchTurnFiles = (turnId: number) =>
  req<ChangedFilesDto>(`/api/undo/turns/${turnId}/files`)

export const fetchTurnDiff = (turnId: number, path: string) =>
  req<FileDiff>(`/api/undo/turns/${turnId}/diff?${new URLSearchParams({ path })}`)

/** Intervalos fora de turno: o terminal (`localId`) é quem autoriza e recorta pela pasta do projeto. */
export const fetchIntervalFiles = (localId: string, from: number, to: number) =>
  req<ChangedFilesDto>(`/api/undo/intervals/${from}/${to}/files?${new URLSearchParams({ localId })}`)

export const fetchIntervalDiff = (localId: string, from: number, to: number, path: string) =>
  req<FileDiff>(`/api/undo/intervals/${from}/${to}/diff?${new URLSearchParams({ localId, path })}`)

export const previewUndo = (turnIds: number[]) =>
  req<UndoPreview>('/api/undo/preview', json({ turnIds }))

export const applyUndo = (turnIds: number[], d: UndoDecision) =>
  req<UndoRunDto>('/api/undo/apply', json({ turnIds, token: d.token, decisions: d.decisions }))

export const previewRedo = (runId: number) =>
  req<UndoPreview>(`/api/undo/runs/${runId}/redo/preview`, { method: 'POST' })

export const applyRedo = (runId: number, d: UndoDecision) =>
  req<UndoRunDto>(`/api/undo/runs/${runId}/redo`, json({ token: d.token, decisions: d.decisions }))

// ── Editar a partir daqui ──

export const fetchRewindOptions = (localId: string, target: RewindTarget) =>
  req<RewindOptionsDto>(`/api/undo/terminals/${enc(localId)}/rewind/options`, json({ target }))

/** Com `conversation_and_files`, `token`/`decisions` são os da prévia dos arquivos. */
export const rewind = (localId: string, body: { target: RewindTarget; mode: RewindMode; editedText: string } & Partial<UndoDecision>) =>
  req<RewindResultDto>(`/api/undo/terminals/${enc(localId)}/rewind`, json(body))
