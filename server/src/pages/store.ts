import type { Db } from '../db.js'
import type { VisualPageDto } from '../../../shared/visual-pages.js'

/** Persistência das páginas publicadas. Tabela criada em `schema.ts`. */

export interface NewPage {
  id: string
  projectId: number
  engine: string
  localId: string
  conversationId: string | null
  turnId: number | null
  turnKey: string | null
  title: string
  height: number | null
  bytes: number
  source: 'html' | 'path'
  /** Arquivo de origem quando `source` é `path`; fica só no banco, fora do DTO. */
  sourcePath: string | null
}

interface PageDb {
  id: string; project_id: number; engine: string; local_id: string; conversation_id: string | null
  turn_id: number | null; turn_key: string | null; title: string; height: number | null; bytes: number
  source: string; source_path: string | null; created_at: string
}

function toDto(r: PageDb): VisualPageDto {
  return {
    id: r.id, projectId: r.project_id, engine: r.engine, localId: r.local_id, conversationId: r.conversation_id,
    turnId: r.turn_id, turnKey: r.turn_key, title: r.title, height: r.height, bytes: r.bytes,
    source: r.source as VisualPageDto['source'], createdAt: r.created_at,
  }
}

/** Marcadores `?, ?, ?` para um `IN` com `n` valores. */
const marks = (n: number) => Array(n).fill('?').join(', ')

export function createPagesStore(db: Db) {
  const q = {
    insert: db.prepare(`INSERT INTO visual_pages
      (id, project_id, engine, local_id, conversation_id, turn_id, turn_key, title, height, bytes, source, source_path)
      VALUES (@id, @projectId, @engine, @localId, @conversationId, @turnId, @turnKey, @title, @height, @bytes, @source, @sourcePath)`),
    get: db.prepare(`SELECT * FROM visual_pages WHERE id = ?`),
    byConversation: db.prepare(`SELECT * FROM visual_pages
      WHERE project_id = ? AND engine = ? AND conversation_id = ? ORDER BY created_at, rowid`),
    // Conversa ainda sem id (primeiro turno antes de o motor informar): casa pelo terminal.
    byLocal: db.prepare(`SELECT * FROM visual_pages
      WHERE project_id = ? AND engine = ? AND conversation_id IS NULL AND local_id = ? ORDER BY created_at, rowid`),
    idsOfProject: db.prepare(`SELECT id FROM visual_pages WHERE project_id = ?`),
    allIds: db.prepare(`SELECT id FROM visual_pages`),
  }

  return {
    insert(p: NewPage): VisualPageDto {
      q.insert.run(p)
      return toDto(q.get.get(p.id) as PageDb)
    },

    get(id: string): VisualPageDto | undefined {
      const r = q.get.get(id) as PageDb | undefined
      return r ? toDto(r) : undefined
    },

    /** Ordem de criação (created_at, rowid). conversationId null: casa por local_id com conversation_id nulo. */
    listConversation(projectId: number, engine: string, conversationId: string | null, localId: string): VisualPageDto[] {
      const rows = conversationId === null
        ? q.byLocal.all(projectId, engine, localId)
        : q.byConversation.all(projectId, engine, conversationId)
      return (rows as PageDb[]).map(toDto)
    },

    idsOfTurns(turnIds: number[]): string[] {
      if (turnIds.length === 0) return []
      const rows = db.prepare(`SELECT id FROM visual_pages WHERE turn_id IN (${marks(turnIds.length)})`).all(...turnIds)
      return (rows as { id: string }[]).map((r) => r.id)
    },

    idsOfProject(projectId: number): string[] {
      return (q.idsOfProject.all(projectId) as { id: string }[]).map((r) => r.id)
    },

    allIds(): string[] {
      return (q.allIds.all() as { id: string }[]).map((r) => r.id)
    },

    /** Leva as páginas desses turnos para outra conversa; devolve quantas mudaram. */
    moveTurns(turnIds: number[], conversationId: string): number {
      if (turnIds.length === 0) return 0
      return db.prepare(`UPDATE visual_pages SET conversation_id = ? WHERE turn_id IN (${marks(turnIds.length)})`)
        .run(conversationId, ...turnIds).changes
    },

    remove(ids: string[]): void {
      if (ids.length === 0) return
      db.prepare(`DELETE FROM visual_pages WHERE id IN (${marks(ids.length)})`).run(...ids)
    },
  }
}

export type PagesStore = ReturnType<typeof createPagesStore>
