import type { Db } from '../db.js'

/**
 * Esquema de "ramificar a conversa": o ramo (projeto copiado) guarda de onde veio
 * e até onde a cópia foi; a sessão guarda a conversa de origem da cópia; e as
 * conversas laterais ganham uma tabela própria, presa ao projeto.
 *
 * Idempotente, como o resto do db.ts: cada `ALTER` num try/catch próprio (a coluna
 * já existir é o caso normal a partir do segundo boot).
 */
export function migrateBranch(db: Db): void {
  // ON DELETE SET NULL: apagar o original não apaga o ramo, só esquece a origem.
  try { db.exec(`ALTER TABLE projects ADD COLUMN forked_from INTEGER REFERENCES projects(id) ON DELETE SET NULL`) } catch { /* já existe */ }
  try { db.exec(`ALTER TABLE projects ADD COLUMN forked_cut_at TEXT`) } catch { /* já existe */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN fork_source TEXT`) } catch { /* já existe */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS side_threads (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      engine TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
  `)
}
