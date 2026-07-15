import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'

// Cria um DB com o schema ANTIGO (colunas/status em PT) direto via better-sqlite3,
// sem passar por openDb — simula uma instalação existente antes da Task 1.
function createLegacyDb(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#7c5cff',
      icon TEXT NOT NULL DEFAULT '📁',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      local_id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE mural (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      titulo TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      to_project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      descricao TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'em_andamento',
      resultado TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Origem', '/tmp/origem')`).run()
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (2, 'Destino', '/tmp/destino')`).run()

  db.prepare(`INSERT INTO mural (project_id, titulo, conteudo) VALUES (1, 'Aviso antigo', 'conteúdo antigo')`).run()

  db.prepare(
    `INSERT INTO tasks (from_project_id, to_project_id, descricao, status, resultado) VALUES (1, 2, 'tarefa em andamento', 'em_andamento', NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO tasks (from_project_id, to_project_id, descricao, status, resultado) VALUES (1, 2, 'tarefa concluída', 'concluida', 'feito!')`,
  ).run()
  db.prepare(
    `INSERT INTO tasks (from_project_id, to_project_id, descricao, status, resultado) VALUES (1, 2, 'tarefa que falhou', 'falhou', 'deu erro')`,
  ).run()

  db.close()
}

describe('migrações EN (DB velho com colunas/status PT)', () => {
  it('renomeia colunas e migra valores de status ao abrir com openDb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-migrate-'))
    const dbPath = join(dir, 'claudinei.db')
    createLegacyDb(dbPath)

    const db = openDb(dbPath)

    // colunas novas existem nas duas tabelas
    const muralCols = (db.prepare(`PRAGMA table_info(mural)`).all() as { name: string }[]).map((c) => c.name)
    expect(muralCols).toContain('title')
    expect(muralCols).toContain('content')
    expect(muralCols).not.toContain('titulo')
    expect(muralCols).not.toContain('conteudo')

    const taskCols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name)
    expect(taskCols).toContain('description')
    expect(taskCols).toContain('result')
    expect(taskCols).not.toContain('descricao')
    expect(taskCols).not.toContain('resultado')

    // dados do mural preservados, sob os nomes novos
    const post = db.prepare(`SELECT * FROM mural WHERE id = 1`).get() as any
    expect(post.title).toBe('Aviso antigo')
    expect(post.content).toBe('conteúdo antigo')

    // status antigos migrados para os valores EN, dados preservados
    const tasks = db.prepare(`SELECT * FROM tasks ORDER BY id`).all() as any[]
    expect(tasks).toHaveLength(3)
    expect(tasks[0]).toMatchObject({ description: 'tarefa em andamento', status: 'in_progress', result: null })
    expect(tasks[1]).toMatchObject({ description: 'tarefa concluída', status: 'completed', result: 'feito!' })
    expect(tasks[2]).toMatchObject({ description: 'tarefa que falhou', status: 'failed', result: 'deu erro' })
  })

  it('é idempotente: abrir duas vezes não falha e mantém os dados migrados', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-migrate-'))
    const dbPath = join(dir, 'claudinei.db')
    createLegacyDb(dbPath)

    openDb(dbPath)
    const db2 = openDb(dbPath)

    const tasks = db2.prepare(`SELECT status FROM tasks ORDER BY id`).all() as { status: string }[]
    expect(tasks.map((t) => t.status)).toEqual(['in_progress', 'completed', 'failed'])
  })

  it('instalação nova (:memory:) já nasce com os nomes EN', () => {
    const db = openDb(':memory:')
    const muralCols = (db.prepare(`PRAGMA table_info(mural)`).all() as { name: string }[]).map((c) => c.name)
    expect(muralCols).toContain('title')
    expect(muralCols).toContain('content')
    const taskCols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name)
    expect(taskCols).toContain('description')
    expect(taskCols).toContain('result')
  })
})
