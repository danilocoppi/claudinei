import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import {
  backfillProjectEngines, defaultEngines, enginesOf, parseEngines, sortEngines, validateEnginesInput,
} from '../src/terminal-engines.js'

/**
 * A lista de motores de cada terminal (`projects.engines`): leitura tolerante,
 * ordem canônica, a migração que a preenche a partir do que o terminal já usou
 * e a garantia de que ela roda uma vez só.
 */

const novoBanco = (): string => join(mkdtempSync(join(tmpdir(), 'motores-')), 'claudinei.db')
const pasta = (): string => mkdtempSync(join(tmpdir(), 'motores-p-'))

/**
 * Leva o banco ao estado de antes desta funcionalidade (sem a coluna) e abre de
 * novo com `openDb`: é o caminho real da migração numa instalação existente.
 */
function reabrirSemAColuna(dbPath: string): Db {
  const old = new Database(dbPath)
  old.exec('ALTER TABLE projects DROP COLUMN engines')
  old.close()
  return openDb(dbPath)
}

/** Mesmo procedimento de `migrations-path-shared.test.ts`: devolve o UNIQUE de projects.path. */
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

const temUniqueEmPath = (dbPath: string): boolean => {
  const db = new Database(dbPath, { readonly: true })
  const achou = (db.prepare(`PRAGMA index_list(projects)`).all() as { name: string; origin: string }[])
    .some((i) => i.origin === 'u')
  db.close()
  return achou
}

describe('ordem e leitura', () => {
  it('sortEngines põe os canônicos primeiro e mantém os desconhecidos', () => {
    expect(sortEngines(['xyz', 'codex', 'claude', 'codex'])).toEqual(['claude', 'codex', 'xyz'])
    expect(sortEngines(['opencode', 'b', 'kimi', 'a'])).toEqual(['kimi', 'opencode', 'b', 'a'])
  })

  it('parseEngines recusa lixo', () => {
    for (const lixo of ['"x"', '[]', 'nao-json', null, '[1]']) expect(parseEngines(lixo)).toBeNull()
    expect(parseEngines('["kimi"]')).toEqual(['kimi'])
  })

  it('defaultEngines: Claude, ou o primeiro instalado na ordem canônica', () => {
    expect(defaultEngines(() => true)).toEqual(['claude'])
    expect(defaultEngines((id) => id !== 'claude')).toEqual(['codex'])
    expect(defaultEngines((id) => id === 'opencode')).toEqual(['opencode'])
    expect(defaultEngines(() => false)).toEqual(['claude'])
  })

  it('validateEnginesInput: lista ordenada, ou null sem nenhum id conhecido', () => {
    const conhecido = (id: string) => ['claude', 'codex', 'kimi', 'opencode'].includes(id)
    expect(validateEnginesInput(['codex', 'claude'], conhecido)).toEqual(['claude', 'codex'])
    expect(validateEnginesInput(['claude', 'futuro'], conhecido)).toEqual(['claude', 'futuro'])
    expect(validateEnginesInput([], conhecido)).toBeNull()
    expect(validateEnginesInput(['futuro'], conhecido)).toBeNull()
    expect(validateEnginesInput('claude', conhecido)).toBeNull()
    expect(validateEnginesInput(['claude', 1], conhecido)).toBeNull()
    expect(validateEnginesInput(['claude', 'Não Vale'], conhecido)).toBeNull()
    expect(validateEnginesInput(undefined, conhecido)).toBeNull()
  })
})

describe('migração', () => {
  it('backfill: sessões de Claude e Codex dão os dois', () => {
    const dbPath = novoBanco()
    const db = openDb(dbPath)
    const p = createProjectsService(db).create({ name: 'A', path: pasta() })
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES ('s1', ?, 'codex', 'stopped')`).run(p.id)
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES ('s2', ?, 'claude', 'stopped')`).run(p.id)
    db.close()
    const migrado = reabrirSemAColuna(dbPath)
    expect(enginesOf(migrado, p.id)).toEqual(['claude', 'codex'])
    migrado.close()
  })

  it('backfill: só project_threads de Kimi dá o Kimi', () => {
    const dbPath = novoBanco()
    const db = openDb(dbPath)
    const p = createProjectsService(db).create({ name: 'A', path: pasta() })
    db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (?, 'kimi', 't1', 1)`).run(p.id)
    db.close()
    const migrado = reabrirSemAColuna(dbPath)
    expect(enginesOf(migrado, p.id)).toEqual(['kimi'])
    migrado.close()
  })

  it('backfill: terminal sem nada fica com o Claude', () => {
    const dbPath = novoBanco()
    const db = openDb(dbPath)
    const svc = createProjectsService(db)
    const vazio = svc.create({ name: 'Vazio', path: pasta() })
    const outro = svc.create({ name: 'Outro', path: pasta() })
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES ('s1', ?, 'opencode', 'stopped')`).run(outro.id)
    db.close()
    const migrado = reabrirSemAColuna(dbPath)
    expect(enginesOf(migrado, vazio.id)).toEqual(['claude'])
    expect(enginesOf(migrado, outro.id)).toEqual(['opencode'])
    // Sem coluna nula sobrando: todo terminal sai da migração com a lista gravada.
    expect(migrado.prepare('SELECT COUNT(*) AS n FROM projects WHERE engines IS NULL').get()).toEqual({ n: 0 })
    migrado.close()
  })

  it('backfillProjectEngines devolve quantos terminais preencheu', () => {
    const db = openDb(':memory:')
    const svc = createProjectsService(db)
    svc.create({ name: 'A', path: pasta() })
    svc.create({ name: 'B', path: pasta() })
    expect(backfillProjectEngines(db)).toBe(2)
  })

  it('migração roda uma vez só', () => {
    const dbPath = novoBanco()
    const db = openDb(dbPath)
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'A', path: pasta() })
    // Uma sessão de Claude: se o backfill rodasse de novo, a lista viraria ['claude'].
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES ('s1', ?, 'claude', 'stopped')`).run(p.id)
    svc.setEngines(p.id, ['codex'])
    db.close()
    const reaberto = openDb(dbPath)
    expect(enginesOf(reaberto, p.id)).toEqual(['codex'])
    reaberto.close()
  })

  it('engines sobrevive à recriação de projects', () => {
    const dbPath = novoBanco()
    const db = openDb(dbPath)
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'A', path: pasta() })
    svc.setEngines(p.id, ['kimi', 'codex'])
    db.close()
    reintroduzirUnique(dbPath)
    expect(temUniqueEmPath(dbPath), 'o banco do teste tem que começar COM o UNIQUE').toBe(true)

    const migrado = openDb(dbPath)
    expect(temUniqueEmPath(dbPath)).toBe(false)
    expect(enginesOf(migrado, p.id)).toEqual(['codex', 'kimi'])
    migrado.close()
  })

  it('coluna com JSON quebrado é lida como Claude', () => {
    const db = openDb(':memory:')
    const svc = createProjectsService(db)
    svc.create({ name: 'A', path: pasta() })
    db.exec(`UPDATE projects SET engines='[]'`)
    expect(() => svc.list()).not.toThrow()
    expect(svc.list()[0].engines).toEqual(['claude'])
    db.exec(`UPDATE projects SET engines='"x"'`)
    expect(svc.list()[0].engines).toEqual(['claude'])
  })
})

describe('serviço de projetos', () => {
  it('create grava a lista em ordem canônica; sem lista, o Claude', () => {
    const db = openDb(':memory:')
    const svc = createProjectsService(db)
    expect(svc.create({ name: 'A', path: pasta() }).engines).toEqual(['claude'])
    const b = svc.create({ name: 'B', path: pasta(), engines: ['opencode', 'codex'] })
    expect(b.engines).toEqual(['codex', 'opencode'])
    expect(db.prepare('SELECT engines FROM projects WHERE id=?').get(b.id)).toEqual({ engines: '["codex","opencode"]' })
  })

  it('setEngines devolve o projeto, ou undefined quando ele não existe', () => {
    const db = openDb(':memory:')
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'A', path: pasta() })
    expect(svc.setEngines(p.id, ['kimi', 'claude'])?.engines).toEqual(['claude', 'kimi'])
    expect(svc.setEngines(9999, ['claude'])).toBeUndefined()
  })
})
