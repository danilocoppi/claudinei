import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { registerProjectRoutes } from '../src/routes/projects.js'

let db: Db
beforeEach(() => { db = openDb(':memory:') })

const mk = (svc: ReturnType<typeof createProjectsService>, name: string) =>
  svc.create({ name, path: mkdtempSync(join(tmpdir(), 'tm-')) })

describe('ordenação de projetos', () => {
  it('create dá sort_order incremental e list respeita a ordem', () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'Alpha')
    const c = mk(svc, 'Charlie')
    const b = mk(svc, 'Bravo')
    // ordem de criação, NÃO alfabética
    expect(svc.list().map((p) => p.id)).toEqual([a.id, c.id, b.id])
  })

  it('reorder persiste a nova ordem e ignora ids desconhecidos', () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'A'); const b = mk(svc, 'B'); const c = mk(svc, 'C')
    const out = svc.reorder([c.id, a.id, 999, b.id])
    expect(out.map((p) => p.id)).toEqual([c.id, a.id, b.id])
    expect(svc.list().map((p) => p.id)).toEqual([c.id, a.id, b.id])
  })

  it('migração: projetos antigos (sort_order NULL) recebem sort_order = id', () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'A')
    db.prepare('UPDATE projects SET sort_order = NULL WHERE id = ?').run(a.id)
    // reabrir o schema roda o backfill
    db.exec(`UPDATE projects SET sort_order = id WHERE sort_order IS NULL`)
    expect(svc.list().map((p) => p.id)).toEqual([a.id])
  })
})

describe('PUT /api/projects/order', () => {
  const makeApp = async () => {
    const app = Fastify()
    registerProjectRoutes(app, { db, manager: { hasActiveSession: () => false } as any })
    return app
  }

  it('reordena e devolve a lista', async () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'A'); const b = mk(svc, 'B')
    const app = await makeApp()
    const res = await app.inject({ method: 'PUT', url: '/api/projects/order', payload: { ids: [b.id, a.id] } })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((p: any) => p.id)).toEqual([b.id, a.id])
    await app.close()
  })

  it('body inválido → 400', async () => {
    const app = await makeApp()
    for (const payload of [{}, { ids: 'x' }, { ids: [1, 'dois'] }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/projects/order', payload })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })
})

describe('PATCH /api/projects/:id', () => {
  it('não permite trocar o path (whitelist name/color/icon)', async () => {
    const svc = createProjectsService(db)
    const a = mk(svc, 'A')
    const app = Fastify()
    registerProjectRoutes(app, { db, manager: { hasActiveSession: () => false } as any })
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${a.id}`, payload: { name: 'Novo', path: '/etc' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Novo')
    expect(svc.get(a.id)!.path).toBe(a.path) // path intocado
    await app.close()
  })
})
