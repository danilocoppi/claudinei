import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { registerGroupRoutes } from '../src/routes/groups.js'
import { createGroupsService } from '../src/groups.js'
import { createProjectsService } from '../src/projects.js'

let app: FastifyInstance
let db: Db
let groups: ReturnType<typeof createGroupsService>
let projects: ReturnType<typeof createProjectsService>

const proj = (n: string) => projects.create({ name: n, path: mkdtempSync(join(tmpdir(), `so-${n}-`)) }).id

beforeEach(async () => {
  db = openDb(':memory:')
  groups = createGroupsService(db)
  projects = createProjectsService(db)
  app = Fastify()
  registerGroupRoutes(app, { db } as never)
  await app.ready()
})
afterEach(async () => { await app.close() })

const put = (entries: unknown) =>
  app.inject({ method: 'PUT', url: '/api/sidebar-order', payload: { entries } })

describe('PUT /api/sidebar-order com setores', () => {
  it('aceita a árvore de três níveis e devolve os setores', async () => {
    const s = groups.createSector('S')
    const g = groups.create('G')
    const p = proj('a')
    const res = await put([
      { kind: 'sector', id: s.id, children: [{ kind: 'group', id: g.id, children: [p] }] },
    ])
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sectors.map((x: { id: number }) => x.id)).toEqual([s.id])
    expect(body.projects[0].groupId).toBe(g.id)
  })

  it('aceita terminal solto dentro do setor', async () => {
    const s = groups.createSector('S')
    const p = proj('b')
    const res = await put([{ kind: 'sector', id: s.id, children: [{ kind: 'project', id: p }] }])
    expect(res.statusCode).toBe(200)
    expect(res.json().projects[0].sectorId).toBe(s.id)
  })

  it('recusa filho inválido dentro do setor', async () => {
    const s = groups.createSector('S')
    const res = await put([{ kind: 'sector', id: s.id, children: [{ kind: 'sector', id: 9 }] }])
    expect(res.statusCode).toBe(400)
  })

  it('estrutura antiga (sem setor) continua aceita', async () => {
    const g = groups.create('G')
    const p = proj('c')
    const res = await put([{ kind: 'group', id: g.id, children: [p] }])
    expect(res.statusCode).toBe(200)
  })
})
