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
  try { db.exec(`ALTER TABLE project_groups ADD COLUMN icon TEXT NOT NULL DEFAULT '🗂️'`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE project_groups ADD COLUMN color TEXT NOT NULL DEFAULT '#7c5cff'`) } catch { /* já migrado */ }

  // SETOR: um nível acima do grupo, aceitando grupos E terminais. Migração
  // aditiva de propósito — as colunas nascem nulas e todo o conteúdo existente
  // continua na raiz, exatamente onde está hoje (setor é opcional).
  db.exec(`CREATE TABLE IF NOT EXISTS sectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🏢',
    color TEXT NOT NULL DEFAULT '#58c4dc',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  try { db.exec(`ALTER TABLE project_groups ADD COLUMN sector_id INTEGER REFERENCES sectors(id)`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE projects ADD COLUMN sector_id INTEGER REFERENCES sectors(id)`) } catch { /* já migrado */ }

  // Engine de quem despachou/executou a task (colaboração entre engines do MESMO
  // projeto: "Vaexa → Vaexa" não dizia quem mandou pra quem).
  try { db.exec(`ALTER TABLE tasks ADD COLUMN from_engine TEXT`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN to_engine TEXT`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE mural RENAME COLUMN titulo TO title`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE mural RENAME COLUMN conteudo TO content`) } catch { /* já migrado */ }
  // Agendamentos por terminal. O resultado NÃO mora aqui: o banco guarda o título e
  // o tamanho, e o conteúdo vai para arquivo (ver schedules/store.ts) — 50 execuções
  // de 128 KB por agendamento incharia o banco que carrega a aplicação inteira.
  db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    task TEXT NOT NULL,
    cadence TEXT NOT NULL,
    engine TEXT,
    model TEXT,
    effort TEXT,
    expects_result INTEGER NOT NULL DEFAULT 1,
    keep_results INTEGER NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    title TEXT,
    content_size INTEGER,
    error TEXT,
    local_id TEXT,
    late INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_schedule ON schedule_runs(schedule_id, seq DESC)`)

  // Ações do terminal: um nome e uma sequência de comandos que o operador salva
  // para repetir com um clique (deploy, migração, seed). São DO TERMINAL: o
  // `awsVAEXA` que faz sentido num projeto publicaria na conta errada em outro.
  db.exec(`CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    commands TEXT NOT NULL,
    auto_close INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id, sort_order, id)`)
  // Campo para responder ao comando. Opcional porque a maioria das ações não
  // pergunta nada, e um campo de digitação numa janela que só cospe log é convite
  // a mandar texto para um processo que não está lendo.
  try { db.exec(`ALTER TABLE actions ADD COLUMN allow_input INTEGER NOT NULL DEFAULT 0`) } catch { /* já migrado */ }

  // Desenhos de ícone baixados do Iconify. É CACHE, não dado do usuário: pode ser
  // apagado a qualquer momento que o servidor rebaixa tudo — mas enquanto existe,
  // a sidebar pinta sem tocar na rede, e o serviço gratuito deles recebe um pedido
  // por desenho na vida da instalação, não um por tela aberta.
  db.exec(`CREATE TABLE IF NOT EXISTS icon_cache (
    token TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    width INTEGER NOT NULL DEFAULT 24,
    height INTEGER NOT NULL DEFAULT 24,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  // Aparência por usuário. `user_id = 0` é a instalação sem auth — por isso não há
  // FK para users: a linha 0 não corresponde a usuário nenhum.
  db.exec(`CREATE TABLE IF NOT EXISTS user_prefs (
    user_id INTEGER PRIMARY KEY,
    appearance TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  db.exec(`UPDATE tasks SET status = CASE status WHEN 'em_andamento' THEN 'in_progress' WHEN 'concluida' THEN 'completed' WHEN 'falhou' THEN 'failed' ELSE status END`)
  return db
}
