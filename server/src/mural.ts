import type { Db } from './db.js'

export interface BoardPost {
  id: number
  projectId: number
  projectName: string
  title: string
  content: string
  createdAt: string
}

export function createMuralService(db: Db) {
  return {
    publish(projectId: number, title: string, content: string): { id: number } {
      const info = db
        .prepare(`INSERT INTO mural (project_id, title, content) VALUES (?, ?, ?)`)
        .run(projectId, title, content)
      return { id: Number(info.lastInsertRowid) }
    },

    list(limit = 50): BoardPost[] {
      const rows = db
        .prepare(
          `SELECT m.id as id, m.project_id as projectId, p.name as projectName,
                  m.title as title, m.content as content, m.created_at as createdAt
           FROM mural m
           JOIN projects p ON p.id = m.project_id
           ORDER BY m.id DESC
           LIMIT ?`,
        )
        .all(limit) as BoardPost[]
      return rows
    },
  }
}

export type MuralService = ReturnType<typeof createMuralService>
