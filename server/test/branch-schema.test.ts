import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { migrateBranch } from '../src/branch/schema.js'
import { createProjectsService } from '../src/projects.js'

let db: Db
let dir: string

beforeEach(() => {
  db = openDb(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'claudinei-branch-'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const columns = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('migrateBranch', () => {
  it('migrateBranch cria side_threads e as colunas, e roda duas vezes sem erro', () => {
    expect(() => { migrateBranch(db); migrateBranch(db) }).not.toThrow()
    expect(columns('projects')).toEqual(expect.arrayContaining(['forked_from', 'forked_cut_at']))
    expect(columns('sessions')).toContain('fork_source')
    expect(columns('side_threads')).toEqual(['id', 'project_id', 'engine', 'thread_id', 'created_at'])
  })

  it('apagar o original deixa forked_from nulo no ramo', () => {
    const ins = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES (?, ?, ?, ?)`)
    const original = Number(ins.run('Original', '/tmp/a', '#fff', '📁').lastInsertRowid)
    const ramo = Number(ins.run('Ramo', '/tmp/a', '#fff', '📁').lastInsertRowid)
    db.prepare(`UPDATE projects SET forked_from = ?, forked_cut_at = ? WHERE id = ?`).run(original, '2026-11-20T14:05:00Z', ramo)
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(original)
    const row = db.prepare(`SELECT forked_from, forked_cut_at FROM projects WHERE id = ?`).get(ramo) as any
    expect(row.forked_from).toBeNull()
    expect(row.forked_cut_at).toBe('2026-11-20T14:05:00Z')
  })

  it('apagar o projeto apaga as conversas laterais dele', () => {
    const p = Number(db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES ('A', '/tmp/a', '#fff', '📁')`).run().lastInsertRowid)
    db.prepare(`INSERT INTO side_threads (id, project_id, engine) VALUES ('x', ?, 'claude')`).run(p)
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(p)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM side_threads`).get()).toEqual({ n: 0 })
  })

  it('rowToProject expõe forkedFrom e forkedCutAt', () => {
    const svc = createProjectsService(db)
    const original = svc.create({ name: 'Original', path: dir })
    expect(original).toMatchObject({ forkedFrom: null, forkedCutAt: null })
    const ramo = svc.create({ name: 'Ramo', path: dir })
    db.prepare(`UPDATE projects SET forked_from = ?, forked_cut_at = ? WHERE id = ?`).run(original.id, '2026-11-20T14:05:00Z', ramo.id)
    expect(svc.get(ramo.id)).toMatchObject({ forkedFrom: original.id, forkedCutAt: '2026-11-20T14:05:00Z' })
  })
})
