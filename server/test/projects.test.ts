import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db
let dir: string

beforeEach(() => {
  db = openDb(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'claudinei-'))
})

describe('projects service', () => {
  it('cria e lista projeto com defaults', () => {
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'Meu Projeto', path: dir })
    expect(p.id).toBeGreaterThan(0)
    expect(p.color).toBe('#7c5cff')
    expect(p.icon).toBe('📁')
    expect(svc.list()).toHaveLength(1)
  })

  it('rejeita path inexistente', () => {
    const svc = createProjectsService(db)
    expect(() => svc.create({ name: 'X', path: '/nao/existe/xyz' })).toThrow(/diretório não existe/)
  })

  it('atualiza nome e cor', () => {
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'A', path: dir })
    const upd = svc.update(p.id, { name: 'B', color: '#ff0000' })
    expect(upd.name).toBe('B')
    expect(upd.color).toBe('#ff0000')
  })

  it('remove projeto', () => {
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'A', path: dir })
    svc.remove(p.id)
    expect(svc.list()).toHaveLength(0)
  })
})
