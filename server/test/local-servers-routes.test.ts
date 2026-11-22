import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createAuthService } from '../src/auth/index.js'
import { COOKIE_NAME, registerAuth } from '../src/auth/plugin.js'
import { registerAuthRoutes } from '../src/auth/routes.js'
import { createProjectsService } from '../src/projects.js'
import { registerLocalServerRoutes } from '../src/local-servers/routes.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import '../src/engine/index.js'
import { fakeProc, type FakeProcRoot } from './fake-proc.js'

// As rotas sobre um /proc falso e um `kill` dublê: nenhum sinal de verdade sai.
const SELF = 100
let fp: FakeProcRoot
let db: Db
let app: FastifyInstance
let calls: Array<[number, NodeJS.Signals]>
let p1: { id: number; path: string }
let p2: { id: number; path: string }
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

beforeEach(async () => {
  fp = fakeProc()
  calls = []
  fp.proc({ pid: 1, ppid: 0, comm: 'systemd' })
  fp.proc({ pid: SELF, ppid: 1, pgrp: 90 })
  db = openDb(':memory:')
  const auth = createAuthService({ db })
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'ls-p1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'ls-p2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
  app = Fastify({ logger: false }) as unknown as FastifyInstance
  app.decorateRequest('behindProxy', false)
  await registerAuth(app, { auth })
  registerAuthRoutes(app, { auth })
  registerLocalServerRoutes(app, {
    db, servicePort: 9105, procRoot: fp.root, selfPid: SELF,
    kill: (pid, sig) => { calls.push([pid, sig]); if (sig === 'SIGTERM') fp.kill(pid < 0 ? -pid : pid) },
  })
  const login = async (username: string) =>
    cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))
  adminCookie = await login('root')
  anaCookie = await login('ana')
  // Um vite do terminal p1/claude, readotado.
  fp.proc({ pid: 300, ppid: 1, pgrp: 300, startTime: '5555', cmdline: ['node', '/x/.bin/vite'], env: { CLAUDINEI_TERMINAL: `${p1.id}:claude` } })
  fp.listen(300, 5173)
})

afterEach(async () => {
  await app.close()
  fp.cleanup()
  rmSync(p1.path, { recursive: true, force: true })
  rmSync(p2.path, { recursive: true, force: true })
})

const listUrl = (id: number, engine = 'claude') => `/api/projects/${id}/terminals/${engine}/servers`
const stopUrl = (id: number, pid: number, engine = 'claude') => `/api/projects/${id}/terminals/${engine}/servers/${pid}/stop`

describe('rotas dos servidores locais', () => {
  it('sem acesso → 403; projeto inexistente → 404; motor desconhecido → 400', async () => {
    expect((await app.inject({ method: 'GET', url: listUrl(p2.id), cookies: anaCookie })).statusCode).toBe(403)
    const post = await app.inject({ method: 'POST', url: stopUrl(p2.id, 300), cookies: anaCookie, payload: { startTime: '5555' } })
    expect(post.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: listUrl(9999), cookies: adminCookie })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: listUrl(p1.id, 'inventado'), cookies: adminCookie })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: listUrl(p1.id), cookies: {} })).statusCode).toBe(401)
    expect(calls).toEqual([])
  })

  it('GET devolve a lista', async () => {
    const res = await app.inject({ method: 'GET', url: listUrl(p1.id), cookies: anaCookie })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      servers: [{ pid: 300, port: 5173, host: '127.0.0.1', label: 'vite', startTime: '5555', marker: 'exact' }],
    })
    // Outro motor do mesmo projeto: nada.
    expect((await app.inject({ method: 'GET', url: listUrl(p1.id, 'codex'), cookies: anaCookie })).json()).toEqual({ servers: [] })
  })

  it("POST 409 com 'o processo já não é o mesmo'", async () => {
    const res = await app.inject({ method: 'POST', url: stopUrl(p1.id, 300), cookies: anaCookie, payload: { startTime: '1234' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'not_same_process', error: 'o processo já não é o mesmo' })
    // O marcador é o do terminal da URL: o vite do p1/claude não é do p1/codex.
    const other = await app.inject({ method: 'POST', url: stopUrl(p1.id, 300, 'codex'), cookies: anaCookie, payload: { startTime: '5555' } })
    expect(other.statusCode).toBe(409)
    expect(calls).toEqual([])
  })

  it('POST para e responde { ok, target }; a lista seguinte já não o tem', async () => {
    expect((await app.inject({ method: 'GET', url: listUrl(p1.id), cookies: anaCookie })).json().servers).toHaveLength(1)
    const res = await app.inject({ method: 'POST', url: stopUrl(p1.id, 300), cookies: anaCookie, payload: { startTime: '5555' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, target: 'group' })
    expect(calls).toEqual([[-300, 'SIGTERM']])
    expect((await app.inject({ method: 'GET', url: listUrl(p1.id), cookies: anaCookie })).json()).toEqual({ servers: [] })
  })

  it('POST sem marcador → 403 no_marker; da CLI → 403 protected_process; corpo ruim → 400', async () => {
    fp.proc({ pid: 301, ppid: 1, startTime: '5555', env: { PATH: '/usr/bin' } })
    const noMarker = await app.inject({ method: 'POST', url: stopUrl(p1.id, 301), cookies: anaCookie, payload: { startTime: '5555' } })
    expect(noMarker.statusCode).toBe(403)
    expect(noMarker.json().code).toBe('no_marker')
    fp.proc({ pid: 200, ppid: SELF, pgrp: 200, startTime: '5555', env: { CLAUDINEI_TERMINAL: `${p1.id}:claude` } })
    const cli = await app.inject({ method: 'POST', url: stopUrl(p1.id, 200), cookies: anaCookie, payload: { startTime: '5555' } })
    expect(cli.statusCode).toBe(403)
    expect(cli.json().code).toBe('protected_process')
    for (const [pid, payload] of [[300, {}], [300, { startTime: 5555 }], [0, { startTime: '5555' }], [-5, { startTime: '5555' }]] as const) {
      const bad = await app.inject({ method: 'POST', url: stopUrl(p1.id, pid as number), cookies: anaCookie, payload })
      expect(bad.statusCode, JSON.stringify([pid, payload])).toBe(400)
      expect(bad.json().code).toBe('bad_args')
    }
    expect(calls).toEqual([])
  })
})

describe('o app registra as rotas', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ls-app-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); vi.restoreAllMocks() })

  it('GET responde pelo buildApp (lê o /proc de verdade, só leitura)', async () => {
    const db2 = openDb(':memory:')
    const manager = createSessionManager({ db: db2, broadcast: () => {}, sessionFactory: () => { throw new Error('sem sessão') } })
    const real = await buildApp({ config: loadConfig({ CLAUDINEI_UPLOADS: join(tmp, 'uploads') }), db: db2, manager })
    try {
      const p = createProjectsService(db2).create({ name: 'Gama', path: tmp })
      const res = await real.inject({ method: 'GET', url: `/api/projects/${p.id}/terminals/claude/servers` })
      expect(res.statusCode).toBe(200)
      // O conteúdo depende da máquina (o serviço real pode ter um terminal 1:claude).
      expect(Array.isArray(res.json().servers)).toBe(true)
    } finally { await real.close() }
  })
})
