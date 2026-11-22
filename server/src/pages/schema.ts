import type { Db } from '../db.js'

/**
 * Esquema das respostas visuais: uma linha por página publicada, presa ao
 * projeto (apagar o projeto leva as linhas) e à conversa onde apareceu. O HTML
 * fica num arquivo em `config.pagesDir`, com o id como nome.
 *
 * Idempotente, como o resto do db.ts.
 */
export function migratePages(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visual_pages (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      engine TEXT NOT NULL,
      local_id TEXT NOT NULL,
      conversation_id TEXT,
      turn_id INTEGER,
      turn_key TEXT,
      title TEXT NOT NULL,
      height INTEGER,
      bytes INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_path TEXT,
      created_at TEXT DEFAULT (datetime('now')))
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_visual_pages_conv ON visual_pages(project_id, engine, conversation_id)`)
}
