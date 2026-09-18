import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'

/**
 * A migração que remove o UNIQUE de projects.path.
 *
 * É a primeira migração DESTRUTIVA do projeto e roda em máquinas que não podemos
 * inspecionar, então o que está sob teste não é só "o UNIQUE saiu": é que nada se
 * perde, que a cópia de segurança existe, que rodar duas vezes não faz nada na
 * segunda, e que a numeração de ids não regride.
 */

/**
 * Devolve `projects` ao estado ANTIGO (com o UNIQUE), pelo mesmo procedimento de
 * recriação que a migração usa — ao contrário.
 *
 * Simular a instalação antiga escrevendo o DDL de todas as tabelas à mão ficaria
 * desatualizado no primeiro ALTER TABLE que alguém escrevesse; assim o "banco
 * antigo" é o banco de verdade, com a restrição de volta.
 */
function reintroduzirUnique(dbPath: string): void {
  const db = new Database(dbPath)
  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`).get() as { sql: string }).sql
  const antigo = ddl
    .replace(/CREATE\s+TABLE\s+"?projects"?/i, 'CREATE TABLE projects_old')
    .replace(/(\bpath\s+TEXT\s+NOT\s+NULL)/i, '$1 UNIQUE')
  const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]).map((c) => `"${c.name}"`).join(', ')
  db.pragma('foreign_keys = OFF')
  db.exec('BEGIN')
  db.exec(antigo)
  db.exec(`INSERT INTO projects_old (${cols}) SELECT ${cols} FROM projects`)
  db.exec('DROP TABLE projects')
  db.exec('ALTER TABLE projects_old RENAME TO projects')
  db.exec('COMMIT')
  db.pragma('foreign_keys = ON')
  db.close()
}

/** Banco com dados em todas as tabelas que dependem de projects, e com o UNIQUE de volta. */
function bancoAntigoPovoado(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mig-path-')), 'claudinei.db')
  const db = openDb(dbPath)
  db.prepare(`INSERT INTO projects (id, name, path, color, icon) VALUES (1, 'Alfa', '/tmp/alfa', '#fff', '📁')`).run()
  db.prepare(`INSERT INTO projects (id, name, path, color, icon) VALUES (2, 'Beta', '/tmp/beta', '#fff', '📁')`).run()
  db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status, claude_session_id) VALUES ('s1', 1, 'claude', 'stopped', 'conv-1')`).run()
  db.prepare(`INSERT INTO mural (project_id, title, content) VALUES (1, 'Aviso', 'corpo')`).run()
  db.prepare(`INSERT INTO tasks (from_project_id, to_project_id, description) VALUES (1, 2, 'tarefa')`).run()
  db.prepare(`INSERT INTO users (username, password_hash) VALUES ('u', 'h')`).run()
  db.prepare(`INSERT INTO user_projects (user_id, project_id) VALUES (1, 1)`).run()
  db.prepare(`INSERT INTO schedules (project_id, name, task, cadence) VALUES (1, 'diário', 'olhar', 'daily')`).run()
  db.prepare(`INSERT INTO actions (project_id, name, commands) VALUES (1, 'deploy', 'echo oi')`).run()
  db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (1, 'claude', 'conv-1', 1)`).run()
  db.close()
  reintroduzirUnique(dbPath)
  return dbPath
}

const unicos = (dbPath: string): number => {
  const db = new Database(dbPath, { readonly: true })
  const list = db.prepare(`PRAGMA index_list(projects)`).all() as { name: string; origin: string }[]
  let n = 0
  for (const idx of list) {
    if (idx.origin !== 'u') continue
    const cols = (db.prepare(`PRAGMA index_info('${idx.name}')`).all() as { name: string | null }[]).map((c) => c.name)
    if (cols.length === 1 && cols[0] === 'path') n++
  }
  db.close()
  return n
}

const backups = (dbPath: string): string[] =>
  readdirSync(join(dbPath, '..')).filter((f) => f.startsWith('claudinei.db.bak-'))

describe('migração: projects.path deixa de ser único', () => {
  it('abre o banco antigo e passa a aceitar duas entradas na mesma pasta', () => {
    const dbPath = bancoAntigoPovoado()
    expect(unicos(dbPath), 'o banco do teste tem que começar COM o UNIQUE').toBe(1)

    const db = openDb(dbPath)
    expect(() =>
      db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES ('Alfa 2', '/tmp/alfa', '#fff', '📁')`).run(),
    ).not.toThrow()
    db.close()
  })

  it('não perde nada das tabelas que dependem de projects', () => {
    const dbPath = bancoAntigoPovoado()
    const db = openDb(dbPath)
    const conta = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
    expect(conta('projects')).toBe(2)
    expect(conta('sessions')).toBe(1)
    expect(conta('mural')).toBe(1)
    expect(conta('tasks')).toBe(1)
    expect(conta('user_projects')).toBe(1)
    expect(conta('schedules')).toBe(1)
    expect(conta('actions')).toBe(1)
    expect(conta('project_threads')).toBe(1)
    // O DROP TABLE projects com as FKs LIGADAS levaria as filhas em cascata: a
    // contagem acima é o que prova que o PRAGMA foreign_keys=OFF pegou.
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const p = db.prepare('SELECT * FROM projects WHERE id=1').get() as any
    expect(p).toMatchObject({ name: 'Alfa', path: '/tmp/alfa' })
    db.close()
  })

  it('a numeração de ids não regride depois da recriação', () => {
    const dbPath = bancoAntigoPovoado()
    const db = openDb(dbPath)
    const info = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES ('Gama', '/tmp/gama', '#fff', '📁')`).run()
    expect(Number(info.lastInsertRowid)).toBeGreaterThan(2)
    db.close()
  })

  it('deixa uma cópia de segurança do banco antes de mexer', () => {
    const dbPath = bancoAntigoPovoado()
    expect(backups(dbPath)).toHaveLength(0)
    const db = openDb(dbPath)
    db.close()
    expect(backups(dbPath)).toHaveLength(1)
  })

  it('é idempotente: a segunda abertura não migra nada nem copia de novo', () => {
    const dbPath = bancoAntigoPovoado()
    openDb(dbPath).close()
    openDb(dbPath).close()
    expect(backups(dbPath), 'um backup por migração, não por boot').toHaveLength(1)
    expect(unicos(dbPath)).toBe(0)
  })

  it('instalação nova nasce sem a restrição e com o índice de busca por caminho', () => {
    const db = openDb(':memory:')
    const ins = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES (?, ?, '#fff', '📁')`)
    ins.run('A', '/tmp/mesma')
    expect(() => ins.run('B', '/tmp/mesma')).not.toThrow()
    const nomes = (db.prepare(`PRAGMA index_list(projects)`).all() as { name: string }[]).map((i) => i.name)
    expect(nomes).toContain('idx_projects_path')
  })
})
