import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

// Sem node-pty no sandbox: stub mínimo só p/ registrar as rotas de terminal
// (os testes de RBAC abaixo batem no guard antes de tocar qualquer método real).
const fakeTerminalManager = {
  close: () => {},
  closeAndWait: async () => {},
  attach: () => true,
  detach: () => {},
  write: () => {},
  resize: () => {},
  refreshToken: (_id: string) => null as string | null,
}

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService
let manager: ReturnType<typeof createSessionManager>
let p1: { id: number }, p2: { id: number }
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: fakeFactory })
  app = await buildApp({ config: loadConfig({}), db, manager, auth, usage: { getLimits: async () => [] }, terminalManager: fakeTerminalManager as any })
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'p1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'p2-')) })
  auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd', projectIds: [p1.id] })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd' } }))
})

describe('projetos', () => {
  it('GET filtrado para não-admin; completo para admin', async () => {
    const admin = await app.inject({ method: 'GET', url: '/api/projects', cookies: adminCookie })
    expect(admin.json().map((p: any) => p.name).sort()).toEqual(['Alfa', 'Beta'])
    const ana = await app.inject({ method: 'GET', url: '/api/projects', cookies: anaCookie })
    expect(ana.json().map((p: any) => p.name)).toEqual(['Alfa'])
  })

  it('escrita de projeto é admin-only (403 p/ ana, ok p/ root)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3-'))
    expect((await app.inject({ method: 'POST', url: '/api/projects', cookies: anaCookie, payload: { name: 'X', path: dir } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${p1.id}`, cookies: anaCookie, payload: { name: 'Y' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p2.id}`, cookies: anaCookie })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/projects/order', cookies: anaCookie, payload: { ids: [p2.id, p1.id] } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/projects', cookies: adminCookie, payload: { name: 'X', path: dir } })).statusCode).toBe(201)
  })
})

describe('sessões', () => {
  it('ana cria sessão no projeto dela, mas não no alheio', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/sessions`, cookies: anaCookie, payload: {} })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p2.id}/sessions`, cookies: anaCookie, payload: {} })).statusCode).toBe(403)
  })

  it('GET /api/sessions filtrado; operações por localId de projeto alheio → 403', async () => {
    const s2 = (await app.inject({ method: 'POST', url: `/api/projects/${p2.id}/sessions`, cookies: adminCookie, payload: {} })).json()
    const list = await app.inject({ method: 'GET', url: '/api/sessions', cookies: anaCookie })
    expect(list.json()).toEqual([])
    for (const [method, url] of [
      ['GET', `/api/sessions/${s2.localId}/history`],
      ['POST', `/api/sessions/${s2.localId}/stop`],
      ['POST', `/api/sessions/${s2.localId}/revive`],
      ['PATCH', `/api/sessions/${s2.localId}/options`],
      ['POST', `/api/sessions/${s2.localId}/terminal`],
      ['DELETE', `/api/sessions/${s2.localId}/terminal`],
    ] as const) {
      const res = await app.inject({ method, url, cookies: anaCookie, ...(method === 'PATCH' ? { payload: {} } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })
})

describe('admin-only diversos', () => {
  it('fs e usage: 403 p/ ana', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/fs/list', cookies: anaCookie })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/usage', cookies: anaCookie })).statusCode).toBe(403)
  })
})

describe('board/tasks filtrados', () => {
  it('não-admin só vê posts/tasks dos projetos dele', async () => {
    await app.inject({ method: 'POST', url: '/api/hermes/board', cookies: adminCookie, payload: { projectId: p1.id, title: 'A', content: 'a' } })
    await app.inject({ method: 'POST', url: '/api/hermes/board', cookies: adminCookie, payload: { projectId: p2.id, title: 'B', content: 'b' } })
    const board = await app.inject({ method: 'GET', url: '/api/hermes/board', cookies: anaCookie })
    expect(board.json().map((p: any) => p.title)).toEqual(['A'])
    const admin = await app.inject({ method: 'GET', url: '/api/hermes/board', cookies: adminCookie })
    expect(admin.json().length).toBe(2)
  })

  it('POST board: não-admin não posta em projeto alheio (403), pode no próprio (201); admin posta em ambos', async () => {
    const anaForaste = await app.inject({
      method: 'POST', url: '/api/hermes/board', cookies: anaCookie,
      payload: { projectId: p2.id, title: 'Invasão', content: 'x' },
    })
    expect(anaForaste.statusCode).toBe(403)

    const anaPropio = await app.inject({
      method: 'POST', url: '/api/hermes/board', cookies: anaCookie,
      payload: { projectId: p1.id, title: 'Post da Ana', content: 'x' },
    })
    expect(anaPropio.statusCode).toBe(201)

    const adminP1 = await app.inject({
      method: 'POST', url: '/api/hermes/board', cookies: adminCookie,
      payload: { projectId: p1.id, title: 'Admin p1', content: 'x' },
    })
    expect(adminP1.statusCode).toBe(201)

    const adminP2 = await app.inject({
      method: 'POST', url: '/api/hermes/board', cookies: adminCookie,
      payload: { projectId: p2.id, title: 'Admin p2', content: 'x' },
    })
    expect(adminP2.statusCode).toBe(201)
  })
})
