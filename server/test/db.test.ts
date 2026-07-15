import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db.js'

describe('openDb', () => {
  it('cria schema com tabelas projects e sessions', () => {
    const db = openDb(':memory:')
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('projects')
    expect(names).toContain('sessions')
    expect(names).toContain('tasks')
  })

  it('path de projeto é único', () => {
    const db = openDb(':memory:')
    const ins = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES (?, ?, ?, ?)`)
    ins.run('A', '/tmp/a', '#fff', '📁')
    expect(() => ins.run('B', '/tmp/a', '#fff', '📁')).toThrow()
  })
})
