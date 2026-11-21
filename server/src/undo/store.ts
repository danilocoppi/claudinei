import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Db } from '../db.js'
import type { UntrackedEntry } from '../checkpoint/snapshot.js'
import type { EndKind, RestoreResult, TurnOrigin, TurnSummary } from '../../../shared/undo.js'

/**
 * Persistência do desfazer turno: marcos, listagens de soltos, turnos,
 * desfazeres e as notas "files reverted" à espera da próxima mensagem.
 * Tabelas criadas em db.ts. As colunas JSON saem daqui já parseadas.
 */

export type MarkKind = 'turn_start' | 'message' | 'turn_end' | 'undo_pre' | 'undo_post' | 'terminal_open' | 'terminal_close' | 'boot'
export type SnapshotState = 'pending' | 'ok' | 'late' | 'failed' | 'no_git' | 'lost'

export interface MarkRow {
  id: number
  repoKey: string
  n: number
  repoTop: string
  ref: string
  commitSha: string
  headSha: string | null
  branch: string | null
  mode: 'full' | 'limited'
  kind: MarkKind
  /** Ids dos turnos ativos logo depois deste marco. */
  active: number[]
  big: UntrackedEntry[]
  listingHash: string | null
  createdAt: string
}

export interface TurnRow {
  id: number
  localId: string
  projectId: number
  engine: string
  bornSessionId: string | null
  conversationId: string | null
  origin: TurnOrigin
  textKey: string | null
  midTurn: boolean
  /** Id do turno do Codex. */
  anchor: string | null
  repoKey: string | null
  repoTop: string | null
  startMark: number | null
  endMark: number | null
  endKind: EndKind | null
  snapshot: SnapshotState
  snapshotError: string | null
  limited: boolean
  declared: string[]
  summary: TurnSummary | null
  rewoundAt: string | null
  startedAt: string
  endedAt: string | null
}

export interface NewTurn {
  localId: string
  projectId: number
  engine: string
  origin: TurnOrigin
  bornSessionId?: string | null
  conversationId?: string | null
  textKey?: string | null
  midTurn?: boolean
  anchor?: string | null
  repoKey?: string | null
  repoTop?: string | null
  /** Padrão: `pending`. */
  snapshot?: SnapshotState
}

/** `error`: a mensagem do erro de E/S, só em `failed`. */
export interface RunFile { path: string; result: RestoreResult; error?: string }

export interface RunRow {
  id: number
  projectId: number
  engine: string
  kind: 'undo' | 'redo'
  turnIds: number[]
  repoKey: string
  preMark: number | null
  postMark: number | null
  files: RunFile[]
  redoOf: number | null
  redoneAt: string | null
  createdAt: string
}

export type NewRun = Omit<RunRow, 'id' | 'redoOf' | 'redoneAt' | 'createdAt'> & { redoOf?: number | null }

interface MarkDb {
  id: number; repo_key: string; n: number; repo_top: string; ref: string; commit_sha: string
  head_sha: string | null; branch: string | null; mode: string; kind: string; active: string; big: string
  listing_hash: string | null; created_at: string
}

interface TurnDb {
  id: number; local_id: string; project_id: number; engine: string; born_session_id: string | null
  conversation_id: string | null; origin: string; text_key: string | null; mid_turn: number; anchor: string | null
  repo_key: string | null; repo_top: string | null; start_mark: number | null; end_mark: number | null
  end_kind: string | null; snapshot: string; snapshot_error: string | null; limited: number; declared: string
  summary: string | null; rewound_at: string | null; started_at: string; ended_at: string | null
}

interface RunDb {
  id: number; project_id: number; engine: string; kind: string; turn_ids: string; repo_key: string
  pre_mark: number | null; post_mark: number | null; files: string; redo_of: number | null
  redone_at: string | null; created_at: string
}

function toMark(r: MarkDb): MarkRow {
  return {
    id: r.id, repoKey: r.repo_key, n: r.n, repoTop: r.repo_top, ref: r.ref, commitSha: r.commit_sha,
    headSha: r.head_sha, branch: r.branch, mode: r.mode as MarkRow['mode'], kind: r.kind as MarkKind,
    active: JSON.parse(r.active) as number[], big: JSON.parse(r.big) as UntrackedEntry[],
    listingHash: r.listing_hash, createdAt: r.created_at,
  }
}

function toTurn(r: TurnDb): TurnRow {
  return {
    id: r.id, localId: r.local_id, projectId: r.project_id, engine: r.engine, bornSessionId: r.born_session_id,
    conversationId: r.conversation_id, origin: r.origin as TurnOrigin, textKey: r.text_key, midTurn: r.mid_turn === 1,
    anchor: r.anchor, repoKey: r.repo_key, repoTop: r.repo_top, startMark: r.start_mark, endMark: r.end_mark,
    endKind: r.end_kind as EndKind | null, snapshot: r.snapshot as SnapshotState, snapshotError: r.snapshot_error,
    limited: r.limited === 1, declared: JSON.parse(r.declared) as string[],
    summary: r.summary === null ? null : JSON.parse(r.summary) as TurnSummary,
    rewoundAt: r.rewound_at, startedAt: r.started_at, endedAt: r.ended_at,
  }
}

function toRun(r: RunDb): RunRow {
  return {
    id: r.id, projectId: r.project_id, engine: r.engine, kind: r.kind as RunRow['kind'],
    turnIds: JSON.parse(r.turn_ids) as number[], repoKey: r.repo_key, preMark: r.pre_mark, postMark: r.post_mark,
    files: JSON.parse(r.files) as RunFile[], redoOf: r.redo_of, redoneAt: r.redone_at, createdAt: r.created_at,
  }
}

/** Une listas de caminhos sem repetir, na ordem em que apareceram. */
function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

export function createUndoStore(db: Db) {
  const q = {
    nextN: db.prepare(`SELECT COALESCE(MAX(n), 0) + 1 AS n FROM undo_marks WHERE repo_key = ?`),
    insertMark: db.prepare(`INSERT INTO undo_marks
      (repo_key, n, repo_top, ref, commit_sha, head_sha, branch, mode, kind, active, big, listing_hash)
      VALUES (@repoKey, @n, @repoTop, @ref, @commitSha, @headSha, @branch, @mode, @kind, @active, @big, @listingHash)`),
    mark: db.prepare(`SELECT * FROM undo_marks WHERE id = ?`),
    marksRange: db.prepare(`SELECT * FROM undo_marks WHERE repo_key = ? AND n BETWEEN ? AND ? ORDER BY n`),
    latestMarks: db.prepare(`SELECT * FROM undo_marks WHERE repo_key = ? ORDER BY n DESC LIMIT ?`),
    putListing: db.prepare(`INSERT OR IGNORE INTO undo_listings (hash, data) VALUES (?, ?)`),
    listing: db.prepare(`SELECT data FROM undo_listings WHERE hash = ?`),
    openTurn: db.prepare(`INSERT INTO undo_turns
      (local_id, project_id, engine, born_session_id, conversation_id, origin, text_key, mid_turn, anchor, repo_key, repo_top, snapshot)
      VALUES (@localId, @projectId, @engine, @bornSessionId, @conversationId, @origin, @textKey, @midTurn, @anchor, @repoKey, @repoTop, @snapshot)`),
    turn: db.prepare(`SELECT * FROM undo_turns WHERE id = ?`),
    // O turno marcado como tardio (ferramenta antes de o marco de início
    // terminar) continua tardio quando o marco chega bem.
    setStart: db.prepare(`UPDATE undo_turns SET start_mark = ?,
      snapshot = CASE WHEN snapshot = 'late' AND ? = 'ok' THEN 'late' ELSE ? END,
      snapshot_error = ?, limited = COALESCE(?, limited) WHERE id = ?`),
    // Sem conversa nova, mantém a que havia.
    setEnd: db.prepare(`UPDATE undo_turns SET end_mark = ?, end_kind = ?, conversation_id = COALESCE(?, conversation_id),
      ended_at = datetime('now') WHERE id = ?`),
    markLate: db.prepare(`UPDATE undo_turns SET snapshot = 'late' WHERE id = ? AND snapshot IN ('pending', 'ok')`),
    setAnchor: db.prepare(`UPDATE undo_turns SET anchor = ? WHERE id = ?`),
    declared: db.prepare(`SELECT declared FROM undo_turns WHERE id = ?`),
    setDeclared: db.prepare(`UPDATE undo_turns SET declared = ? WHERE id = ?`),
    setSummary: db.prepare(`UPDATE undo_turns SET summary = ? WHERE id = ?`),
    setSnapshot: db.prepare(`UPDATE undo_turns SET snapshot = ?, snapshot_error = ? WHERE id = ?`),
    setRepo: db.prepare(`UPDATE undo_turns SET repo_key = ?, repo_top = ? WHERE id = ?`),
    openTurns: db.prepare(`SELECT * FROM undo_turns WHERE ended_at IS NULL ORDER BY id`),
    terminalTurns: db.prepare(`SELECT * FROM undo_turns WHERE project_id = ? AND engine = ? ORDER BY id`),
    markRewound: db.prepare(`UPDATE undo_turns SET rewound_at = datetime('now') WHERE id = ?`),
    setConversation: db.prepare(`UPDATE undo_turns SET conversation_id = ? WHERE id = ?`),
    insertRun: db.prepare(`INSERT INTO undo_runs
      (project_id, engine, kind, turn_ids, repo_key, pre_mark, post_mark, files, redo_of)
      VALUES (@projectId, @engine, @kind, @turnIds, @repoKey, @preMark, @postMark, @files, @redoOf)`),
    run: db.prepare(`SELECT * FROM undo_runs WHERE id = ?`),
    // O último desfazer que levou o turno; o refazer marca esse com redone_at.
    lastRunFor: db.prepare(`SELECT r.* FROM undo_runs r
      WHERE r.kind = 'undo' AND EXISTS (SELECT 1 FROM json_each(r.turn_ids) j WHERE j.value = ?)
      ORDER BY r.id DESC LIMIT 1`),
    setRedone: db.prepare(`UPDATE undo_runs SET redone_at = datetime('now') WHERE id = ?`),
    note: db.prepare(`SELECT files FROM undo_notes WHERE project_id = ? AND engine = ?`),
    putNote: db.prepare(`INSERT INTO undo_notes (project_id, engine, files) VALUES (?, ?, ?)
      ON CONFLICT (project_id, engine) DO UPDATE SET files = excluded.files`),
    dropNote: db.prepare(`DELETE FROM undo_notes WHERE project_id = ? AND engine = ?`),
  }

  const addDeclared = db.transaction((id: number, paths: string[]) => {
    const row = q.declared.get(id) as { declared: string } | undefined
    if (!row) return
    q.setDeclared.run(JSON.stringify(union(JSON.parse(row.declared) as string[], paths)), id)
  })
  const addNote = db.transaction((projectId: number, engine: string, files: string[]) => {
    const row = q.note.get(projectId, engine) as { files: string } | undefined
    const prev = row ? JSON.parse(row.files) as string[] : []
    q.putNote.run(projectId, engine, JSON.stringify(union(prev, files)))
  })
  const takeNote = db.transaction((projectId: number, engine: string): string[] | null => {
    const row = q.note.get(projectId, engine) as { files: string } | undefined
    if (!row) return null
    q.dropNote.run(projectId, engine)
    return JSON.parse(row.files) as string[]
  })
  const markRewound = db.transaction((ids: number[]) => { for (const id of ids) q.markRewound.run(id) })
  const setConversation = db.transaction((ids: number[], conversationId: string) => {
    for (const id of ids) q.setConversation.run(conversationId, id)
  })

  return {
    nextMarkN(repoKey: string): number {
      return (q.nextN.get(repoKey) as { n: number }).n
    },
    insertMark(m: Omit<MarkRow, 'id' | 'createdAt'>): number {
      return Number(q.insertMark.run({ ...m, active: JSON.stringify(m.active), big: JSON.stringify(m.big) }).lastInsertRowid)
    },
    mark(id: number): MarkRow | undefined {
      const r = q.mark.get(id) as MarkDb | undefined
      return r && toMark(r)
    },
    /** Ordenado por n. */
    marksRange(repoKey: string, fromN: number, toN: number): MarkRow[] {
      return (q.marksRange.all(repoKey, fromN, toN) as MarkDb[]).map(toMark)
    },
    /** Do mais novo para o mais velho. */
    latestMarks(repoKey: string, limit: number): MarkRow[] {
      return (q.latestMarks.all(repoKey, limit) as MarkDb[]).map(toMark)
    },

    /** Guarda a lista em gzip; a chave é o sha1 do JSON, então lista igual é gravada uma vez. */
    putListing(entries: UntrackedEntry[]): string {
      const json = JSON.stringify(entries.map(e => ({ path: e.path, size: e.size, mtimeMs: e.mtimeMs })))
      const hash = createHash('sha1').update(json).digest('hex')
      q.putListing.run(hash, gzipSync(json))
      return hash
    },
    listing(hash: string): UntrackedEntry[] | null {
      const r = q.listing.get(hash) as { data: Buffer } | undefined
      return r ? JSON.parse(gunzipSync(r.data).toString('utf8')) as UntrackedEntry[] : null
    },

    openTurn(t: NewTurn): number {
      return Number(q.openTurn.run({
        localId: t.localId, projectId: t.projectId, engine: t.engine, origin: t.origin,
        bornSessionId: t.bornSessionId ?? null, conversationId: t.conversationId ?? null, textKey: t.textKey ?? null,
        midTurn: t.midTurn ? 1 : 0, anchor: t.anchor ?? null, repoKey: t.repoKey ?? null, repoTop: t.repoTop ?? null,
        snapshot: t.snapshot ?? 'pending',
      }).lastInsertRowid)
    },
    turn(id: number): TurnRow | undefined {
      const r = q.turn.get(id) as TurnDb | undefined
      return r && toTurn(r)
    },
    /** `limited` ausente mantém o valor que havia. */
    setStart(id: number, markId: number | null, snapshot: SnapshotState, error?: string, limited?: boolean): void {
      q.setStart.run(markId, snapshot, snapshot, error ?? null, limited === undefined ? null : limited ? 1 : 0, id)
    },
    setEnd(id: number, markId: number | null, endKind: EndKind, conversationId: string | null): void {
      q.setEnd.run(markId, endKind, conversationId, id)
    },
    markLate(id: number): void { q.markLate.run(id) },
    setAnchor(id: number, anchor: string): void { q.setAnchor.run(anchor, id) },
    addDeclared(id: number, paths: string[]): void { addDeclared(id, paths) },
    setSummary(id: number, s: TurnSummary): void { q.setSummary.run(JSON.stringify(s), id) },
    setSnapshot(id: number, s: SnapshotState, error?: string): void { q.setSnapshot.run(s, error ?? null, id) },
    /** O repositório do turno aberto antes de a pasta ser resolvida. */
    setRepo(id: number, repoKey: string, repoTop: string): void { q.setRepo.run(repoKey, repoTop, id) },
    /** Turnos sem fim registrado, em qualquer terminal. */
    openTurns(): TurnRow[] { return (q.openTurns.all() as TurnDb[]).map(toTurn) },
    /** Por id. */
    terminalTurns(projectId: number, engine: string): TurnRow[] {
      return (q.terminalTurns.all(projectId, engine) as TurnDb[]).map(toTurn)
    },
    markRewound(ids: number[]): void { markRewound(ids) },
    setConversation(ids: number[], conversationId: string): void { setConversation(ids, conversationId) },

    insertRun(r: NewRun): number {
      return Number(q.insertRun.run({
        projectId: r.projectId, engine: r.engine, kind: r.kind, turnIds: JSON.stringify(r.turnIds), repoKey: r.repoKey,
        preMark: r.preMark, postMark: r.postMark, files: JSON.stringify(r.files), redoOf: r.redoOf ?? null,
      }).lastInsertRowid)
    },
    run(id: number): RunRow | undefined {
      const r = q.run.get(id) as RunDb | undefined
      return r && toRun(r)
    },
    /** O último desfazer (kind `undo`) que incluiu o turno. */
    lastRunFor(turnId: number): RunRow | undefined {
      const r = q.lastRunFor.get(turnId) as RunDb | undefined
      return r && toRun(r)
    },
    setRedone(id: number): void { q.setRedone.run(id) },

    /** Une com a nota que já espera no terminal. */
    addNote(projectId: number, engine: string, files: string[]): void { addNote(projectId, engine, files) },
    /** Devolve e apaga a nota do terminal; null se não há. */
    takeNote(projectId: number, engine: string): string[] | null { return takeNote(projectId, engine) },
  }
}

export type UndoStore = ReturnType<typeof createUndoStore>
