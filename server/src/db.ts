import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#7c5cff',
  icon TEXT NOT NULL DEFAULT '📁',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  local_id TEXT PRIMARY KEY,
  claude_session_id TEXT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  skip_permissions INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mural (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  to_project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_projects (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  try { db.exec(`ALTER TABLE sessions ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 1`) } catch { /* já existe */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`) } catch { /* já existe */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN continue_latest INTEGER NOT NULL DEFAULT 0`) } catch { /* já existe */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN permission_mode TEXT`) } catch { /* já existe */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN effort TEXT`) } catch { /* já existe */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'`) } catch { /* já existe */ }
  db.exec(`UPDATE sessions SET permission_mode = CASE WHEN skip_permissions = 0 THEN 'default' ELSE 'bypassPermissions' END WHERE permission_mode IS NULL`)
  try { db.exec(`ALTER TABLE projects ADD COLUMN sort_order INTEGER`) } catch { /* já existe */ }
  db.exec(`UPDATE projects SET sort_order = id WHERE sort_order IS NULL`)
  // Nomenclatura em inglês (Hermes): colunas antigas em PT renomeadas para EN,
  // e valores antigos de status migrados. Idempotente — instalação nova já
  // nasce com os nomes/valores EN pelo CREATE TABLE acima.
  try { db.exec(`ALTER TABLE tasks RENAME COLUMN descricao TO description`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE tasks RENAME COLUMN resultado TO result`) } catch { /* já migrado */ }
  // Grupos de terminais na sidebar (agrupamento visual; excluir grupo solta os filhos).
  db.exec(`CREATE TABLE IF NOT EXISTS project_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  try { db.exec(`ALTER TABLE projects ADD COLUMN group_id INTEGER REFERENCES project_groups(id)`) } catch { /* já migrado */ }

  // Engine de quem despachou/executou a task (colaboração entre engines do MESMO
  // projeto: "Vaexa → Vaexa" não dizia quem mandou pra quem).
  try { db.exec(`ALTER TABLE tasks ADD COLUMN from_engine TEXT`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN to_engine TEXT`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE mural RENAME COLUMN titulo TO title`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE mural RENAME COLUMN conteudo TO content`) } catch { /* já migrado */ }
  db.exec(`UPDATE tasks SET status = CASE status WHEN 'em_andamento' THEN 'in_progress' WHEN 'concluida' THEN 'completed' WHEN 'falhou' THEN 'failed' ELSE status END`)
  return db
}
