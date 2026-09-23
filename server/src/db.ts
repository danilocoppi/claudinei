import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
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

/**
 * Índices ÚNICOS sobre `projects.path` que vieram de restrição de coluna
 * (`origin = 'u'`).
 *
 * A detecção é pelo estado real do schema porque os bancos existentes não
 * registram quais migrações já rodaram: um contador introduzido agora teria que
 * adivinhar o passado. Perguntar ao SQLite acerta nos três estados do parque —
 * banco antigo, banco já migrado e instalação nova.
 */
function indicesUnicosDePath(db: Db): string[] {
  const list = db.prepare(`PRAGMA index_list(projects)`).all() as { name: string; origin: string }[]
  const achados: string[] = []
  for (const idx of list) {
    // Só 'u' (restrição de coluna): um CREATE UNIQUE INDEX avulso apareceria como
    // 'c' e não existe neste projeto — se um dia existir, um DROP INDEX resolve,
    // sem recriar tabela.
    if (idx.origin !== 'u') continue
    const cols = (db.prepare(`PRAGMA index_info('${idx.name.replace(/'/g, "''")}')`).all() as { name: string | null }[]).map((c) => c.name)
    if (cols.length === 1 && cols[0] === 'path') achados.push(idx.name)
  }
  return achados
}

/**
 * Remove o `UNIQUE` de `projects.path` — é o que libera dois terminais na mesma
 * pasta.
 *
 * Diferente das outras migrações do arquivo, esta não cabe num
 * `try { ALTER TABLE } catch {}`: no SQLite, tirar uma restrição exige recriar a
 * tabela, e uma queda no meio das cinco instruções deixaria a instalação SEM a
 * tabela `projects`. Daí a transação, a conferência e a cópia de segurança.
 */
function migrarPathNaoUnico(db: Db, dbPath: string): void {
  if (indicesUnicosDePath(db).length === 0) return // já migrado, ou instalação nova

  // Primeira migração destrutiva do projeto, rodando em máquinas que não podemos
  // inspecionar. VACUUM INTO dá uma cópia consistente sem parar nada e sem
  // depender do estado do WAL; custa o tamanho do banco em disco, uma vez na vida
  // da instalação, e é o único caminho de volta que existe remotamente.
  if (dbPath !== ':memory:') {
    const bak = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`)
  }

  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`).get() as { sql?: string } | undefined)?.sql
  if (!ddl) throw new Error('projects sem DDL em sqlite_master')
  // O DDL e as colunas VÊM DO BANCO: as adicionadas por ALTER TABLE (sort_order,
  // group_id, sector_id e as que vierem depois) já estão lá. Uma lista fixa aqui
  // apagaria calada a próxima coluna que alguém escrever, e `SELECT *` quebraria
  // se a ordem das colunas divergisse entre máquinas.
  const novoDdl = ddl
    // `"projects"` entre as alternativas não é paranoia: o próprio
    // ALTER TABLE ... RENAME reescreve o DDL com o nome citado, e um banco que já
    // passou por uma recriação guarda `CREATE TABLE "projects"` (medido).
    .replace(/CREATE\s+TABLE\s+(?:"projects"|'projects'|\[projects\]|projects)/i, 'CREATE TABLE projects_new')
    .replace(/(\bpath\b[^,)]*?)\s+UNIQUE\b/i, '$1')
  const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]).map((c) => `"${c.name}"`).join(', ')

  // FORA da transação: dentro, este PRAGMA é no-op silencioso — e sem ele o DROP
  // abaixo dispararia o ON DELETE CASCADE das sete tabelas que apontam para
  // projects, levando embora sessões, mural, tarefas, agendamentos e ações.
  db.pragma('foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    try {
      // MAX(id) não inclui terminais já excluídos. O DROP também apaga a
      // sequência antiga; preservá-la evita reutilizar esses identificadores.
      const previousSequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='projects'").get() as { seq: number } | undefined)?.seq
      db.exec(novoDdl)
      db.exec(`INSERT INTO projects_new (${cols}) SELECT ${cols} FROM projects`)
      db.exec('DROP TABLE projects')
      db.exec('ALTER TABLE projects_new RENAME TO projects')
      if (previousSequence !== undefined) {
        const updated = db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='projects'").run(previousSequence)
        if (!updated.changes) db.prepare('INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)').run('projects', previousSequence)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)`)
      // Confere o que a substituição no DDL de fato produziu. Se o UNIQUE
      // sobreviveu (DDL escrito de outra forma numa instalação que não conhecemos),
      // aborta com o banco intacto em vez de deixar um meio-caminho.
      if (indicesUnicosDePath(db).length > 0) throw new Error('o UNIQUE de projects.path sobreviveu à recriação')
      const violacoes = db.prepare('PRAGMA foreign_key_check').all()
      if (violacoes.length > 0) throw new Error(`foreign_key_check acusou ${violacoes.length} violação(ões)`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  // NULL preserves unrestricted access for existing installations.
  const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
  if (!userColumns.some(c => c.name === 'access_hours')) db.exec('ALTER TABLE users ADD COLUMN access_hours TEXT')
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

  // De quem é cada conversa. Existe porque as SESSÕES não servem de memória de
  // posse: a limpeza automática guarda só as 5 últimas finalizadas por projeto
  // (manager.ts), então o id de uma conversa antiga desaparece do banco enquanto
  // a conversa segue no disco da engine — pronta para ser confundida com a do
  // terminal vizinho da mesma pasta.
  //
  // `seq` ordena, não `seen_at`: `datetime('now')` tem resolução de um segundo e
  // dois registros no mesmo segundo empatariam, deixando "meu último thread"
  // indefinido (e o teste disso intermitente). `seen_at` fica para leitura humana.
  db.exec(`CREATE TABLE IF NOT EXISTS project_threads (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    engine     TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, engine, thread_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_own ON project_threads(project_id, engine, seq DESC)`)

  // Substitui o índice que vinha de brinde com o UNIQUE removido: a busca por
  // caminho continua existindo (é como se sabe que a pasta é compartilhada).
  // Recriado aqui a cada boot porque o DROP TABLE da migração leva os índices
  // de projects embora.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)`)

  db.exec(`UPDATE tasks SET status = CASE status WHEN 'em_andamento' THEN 'in_progress' WHEN 'concluida' THEN 'completed' WHEN 'falhou' THEN 'failed' ELSE status END`)

  // Depois de TODAS as alterações de coluna de projects — antes delas, a cópia
  // levaria os dados sem sort_order/group_id/sector_id.
  //
  // Falhar aqui NÃO derruba o boot: o rollback já devolveu o banco íntegro, e
  // tirar o Claudinei do ar de um usuário remoto por causa de uma funcionalidade
  // opcional seria pior que não tê-la. O sintoma visível é a pasta repetida
  // continuar recusada.
  try {
    migrarPathNaoUnico(db, path)
  } catch (err) {
    console.error('[claudinei] MIGRAÇÃO projects.path FALHOU — dois terminais na mesma pasta seguem indisponíveis:', err)
  }
  return db
}
