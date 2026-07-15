import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createGroupsService } from '../src/groups.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db
let front: Project, back: Project, other: Project

beforeEach(() => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  front = projects.create({ name: 'X Front', path: mkdtempSync(join(tmpdir(), 'g-')) })
  back = projects.create({ name: 'X Back', path: mkdtempSync(join(tmpdir(), 'g-')) })
  other = projects.create({ name: 'Solto', path: mkdtempSync(join(tmpdir(), 'g-')) })
})

describe('groups service', () => {
  it('create/list/rename/remove; excluir grupo SOLTA os terminais (não os exclui)', () => {
    const groups = createGroupsService(db)
    const projects = createProjectsService(db)
    const g = groups.create('Projeto X')
    groups.setProjectGroup(front.id, g.id)
    groups.setProjectGroup(back.id, g.id)
    expect(projects.list().filter((p) => p.groupId === g.id).map((p) => p.name).sort()).toEqual(['X Back', 'X Front'])

    groups.rename(g.id, 'X renomeado')
    expect(groups.list()).toMatchObject([{ id: g.id, name: 'X renomeado' }])

    groups.remove(g.id)
    expect(groups.list()).toEqual([])
    // terminais continuam existindo, soltos na raiz
    expect(projects.list()).toHaveLength(3)
    expect(projects.list().every((p) => p.groupId === null)).toBe(true)
  })

  it('setProjectGroup(null) tira do grupo; grupo inexistente rejeita', () => {
    const groups = createGroupsService(db)
    const projects = createProjectsService(db)
    const g = groups.create('G')
    groups.setProjectGroup(front.id, g.id)
    groups.setProjectGroup(front.id, null)
    expect(projects.get(front.id)?.groupId).toBeNull()
    expect(() => groups.setProjectGroup(front.id, 999)).toThrow(/não existe/)
    expect(() => groups.setProjectGroup(999, g.id)).toThrow(/não existe/)
  })
})

describe('rotas /api/groups (RBAC)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let auth: AuthService
  const cookieOf = (res: any): Record<string, string> => {
    const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
    return c ? { [COOKIE_NAME]: c.value } : {}
  }

  beforeEach(async () => {
    auth = createAuthService({ db })
    const manager = createSessionManager({ db, broadcast: () => {} })
    app = await buildApp({ config: loadConfig({}), db, manager, auth })
    auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd', projectIds: [front.id] })
  })

  it('admin cria/renomeia/exclui; não-admin toma 403 nas mutações', async () => {
    const admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd' } }))
    const ana = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd' } }))

    const created = await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'Projeto X' }, cookies: admin })
    expect(created.statusCode).toBe(201)
    const g = created.json()

    expect((await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'Nope' }, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/groups/${g.id}`, payload: { name: 'Nope' }, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/groups/${g.id}`, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${front.id}/group`, payload: { groupId: g.id }, cookies: ana })).statusCode).toBe(403)

    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${front.id}/group`, payload: { groupId: g.id }, cookies: admin })).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: `/api/groups/${g.id}`, cookies: admin })).statusCode).toBe(204)
  })

  it('GET /api/groups: não-admin só vê grupos com ≥1 terminal acessível', async () => {
    const admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd' } }))
    const ana = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd' } }))

    const gx = (await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'Grupo do X' }, cookies: admin })).json()
    const gz = (await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'Grupo alheio' }, cookies: admin })).json()
    await app.inject({ method: 'PATCH', url: `/api/projects/${front.id}/group`, payload: { groupId: gx.id }, cookies: admin })
    await app.inject({ method: 'PATCH', url: `/api/projects/${other.id}/group`, payload: { groupId: gz.id }, cookies: admin })

    const adminSees = (await app.inject({ method: 'GET', url: '/api/groups', cookies: admin })).json() as any[]
    expect(adminSees.map((g) => g.name).sort()).toEqual(['Grupo alheio', 'Grupo do X'])

    const anaSees = (await app.inject({ method: 'GET', url: '/api/groups', cookies: ana })).json() as any[]
    expect(anaSees.map((g) => g.name)).toEqual(['Grupo do X']) // 'Grupo alheio' não vaza
  })

  it('nome inválido → 400; renomear grupo inexistente → 404', async () => {
    const admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd' } }))
    expect((await app.inject({ method: 'POST', url: '/api/groups', payload: { name: '   ' }, cookies: admin })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'x'.repeat(61) }, cookies: admin })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/api/groups/999', payload: { name: 'ok' }, cookies: admin })).statusCode).toBe(404)
  })
})

describe('applySidebarOrder (ordem unificada grupos + soltos)', () => {
  it('numera grupos, filhos e soltos no MESMO espaço; a estrutura define o pertencimento', () => {
    const groups = createGroupsService(db)
    const projects = createProjectsService(db)
    const g = groups.create('Projeto X')
    // ordem desejada: [Solto(other), Grupo X(front, back)] → other antes do grupo
    groups.applySidebarOrder([
      { kind: 'project', id: other.id },
      { kind: 'group', id: g.id, children: [front.id, back.id] },
    ])
    const ps = Object.fromEntries(projects.list().map((p) => [p.name, p]))
    const [gg] = groups.list()
    expect(ps['Solto'].sortOrder).toBeLessThan(gg.sortOrder)          // solto vem antes do grupo
    expect(ps['X Front'].groupId).toBe(g.id)                          // pertencimento veio da estrutura
    expect(ps['X Back'].groupId).toBe(g.id)
    expect(ps['X Front'].sortOrder).toBeLessThan(ps['X Back'].sortOrder) // ordem dos filhos preservada

    // mover o grupo pra ANTES do solto
    groups.applySidebarOrder([
      { kind: 'group', id: g.id, children: [back.id, front.id] },     // e inverte os filhos
      { kind: 'project', id: other.id },
    ])
    const ps2 = Object.fromEntries(projects.list().map((p) => [p.name, p]))
    const [gg2] = groups.list()
    expect(gg2.sortOrder).toBeLessThan(ps2['Solto'].sortOrder)
    expect(ps2['X Back'].sortOrder).toBeLessThan(ps2['X Front'].sortOrder)
  })

  it('entrada project solta SEMPRE zera o grupo (arrastar pra fora)', () => {
    const groups = createGroupsService(db)
    const projects = createProjectsService(db)
    const g = groups.create('G')
    groups.setProjectGroup(front.id, g.id)
    groups.applySidebarOrder([
      { kind: 'project', id: front.id },
      { kind: 'group', id: g.id, children: [] },
    ])
    expect(projects.get(front.id)?.groupId).toBeNull()
  })

  it('PUT /api/sidebar-order é admin-only e devolve projects+groups frescos', async () => {
    const auth = createAuthService({ db })
    const manager = createSessionManager({ db, broadcast: () => {} })
    const app = await buildApp({ config: loadConfig({}), db, manager, auth })
    auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd', projectIds: [front.id] })
    const cookieOf = (res: any): Record<string, string> => {
      const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
      return c ? { [COOKIE_NAME]: c.value } : {}
    }
    const admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd' } }))
    const ana = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd' } }))
    const g = (await app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'G' }, cookies: admin })).json()

    expect((await app.inject({ method: 'PUT', url: '/api/sidebar-order', payload: { entries: [] }, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/sidebar-order', payload: { entries: [{ kind: 'x' }] }, cookies: admin })).statusCode).toBe(400)

    const res = await app.inject({
      method: 'PUT', url: '/api/sidebar-order',
      payload: { entries: [{ kind: 'group', id: g.id, children: [front.id] }, { kind: 'project', id: back.id }, { kind: 'project', id: other.id }] },
      cookies: admin,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.projects.find((p: any) => p.id === front.id).groupId).toBe(g.id)
    expect(body.groups[0].sortOrder).toBeLessThan(body.projects.find((p: any) => p.id === back.id).sortOrder)
  })
})
