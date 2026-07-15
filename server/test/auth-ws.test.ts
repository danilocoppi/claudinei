import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createWsHub } from '../src/routes/ws.js'
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

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService
let hub: ReturnType<typeof createWsHub>
let baseUrl: string
let p1: { id: number }, p2: { id: number }

const loginCookie = async (username: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd' } })
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME) as any
  return `${COOKIE_NAME}=${c.value}`
}

// Fila de mensagens por socket: o listener é anexado no MOMENTO da criação
// do WebSocket (aqui em openWs), nunca depois de um `await opened(ws)`.
// Isso evita a race em que o 1o frame (sessions_snapshot, hoje síncrono no
// handler de conexão) chega antes de o teste registrar um listener via
// `ws.once('message', ...)`. `nextMsg` só consome dessa fila.
//
// O mesmo cuidado vale para o evento 'open': a promise é criada e os
// listeners são anexados AQUI, não dentro de `opened()`. Login agora é
// assíncrono (scrypt roda na threadpool sem bloquear o event loop), então
// o handshake do 1º socket pode completar enquanto o teste ainda está
// dando `await` no login do 2º usuário — se `opened()` só registrasse o
// listener depois desse await, o evento 'open' já teria disparado e ficaria
// perdido para sempre (o socket nunca seria considerado "aberto").
const queues = new WeakMap<WebSocket, any[]>()
const openPromises = new WeakMap<WebSocket, Promise<void>>()

const openWs = (cookie?: string) => {
  const ws = new WebSocket(`${baseUrl}/ws`, cookie ? { headers: { cookie } } : {})
  const queue: any[] = []
  queues.set(ws, queue)
  ws.on('message', (d) => queue.push(JSON.parse(d.toString())))
  openPromises.set(ws, new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  }))
  return ws
}

const nextMsg = async (ws: WebSocket, ms = 3000): Promise<any> => {
  const queue = queues.get(ws)
  if (!queue) throw new Error('socket não foi criado via openWs()')
  const start = Date.now()
  while (queue.length === 0) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
  return queue.shift()
}

const opened = (ws: WebSocket): Promise<void> => {
  const p = openPromises.get(ws)
  if (!p) throw new Error('socket não foi criado via openWs()')
  return p
}

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  hub = createWsHub()
  const manager = createSessionManager({ db, broadcast: (m) => hub.broadcast(m), sessionFactory: fakeFactory })
  app = await buildApp({
    config: loadConfig({}), db, manager, auth, wsHub: hub,
    onRevokeAll: () => hub.closeAll(), onUserInvalidated: (id) => hub.closeUser(id),
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as { port: number }
  baseUrl = `ws://127.0.0.1:${addr.port}`
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'p1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'p2-')) })
  auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd', projectIds: [p1.id] })
})

afterEach(async () => { await app.close() })

describe('handshake', () => {
  it('sem cookie → conexão rejeitada (401 no upgrade)', async () => {
    const ws = openWs()
    await expect(opened(ws)).rejects.toThrow()
  })

  it('com cookie → conecta e recebe snapshot filtrado', async () => {
    const ws = openWs(await loginCookie('ana'))
    await opened(ws)
    const snap = await nextMsg(ws)
    expect(snap.type).toBe('sessions_snapshot')
    ws.close()
  })
})

describe('broadcast filtrado', () => {
  it('evento de projeto alheio não chega ao não-admin; chega ao admin', async () => {
    const anaWs = openWs(await loginCookie('ana'))
    const rootWs = openWs(await loginCookie('root'))
    await Promise.all([opened(anaWs), opened(rootWs)])
    await Promise.all([nextMsg(anaWs), nextMsg(rootWs)]) // snapshots
    const rootPromise = nextMsg(rootWs)
    const anaPromise = nextMsg(anaWs, 500)
    hub.broadcast({ type: 'board_post', projectId: p2.id, title: 'secreto' })
    await expect(rootPromise).resolves.toMatchObject({ title: 'secreto' })
    await expect(anaPromise).rejects.toThrow('timeout') // ana não recebe
    anaWs.close(); rootWs.close()
  })

  it('evento sem projeto resolvível é admin-only', async () => {
    const anaWs = openWs(await loginCookie('ana'))
    await opened(anaWs); await nextMsg(anaWs)
    const anaPromise = nextMsg(anaWs, 500)
    hub.broadcast({ type: 'global_thing' })
    await expect(anaPromise).rejects.toThrow('timeout')
    anaWs.close()
  })
})

describe('revogação derruba sockets', () => {
  it('revoke-all fecha todas as conexões', async () => {
    const cookie = await loginCookie('root')
    const ws = openWs(cookie)
    await opened(ws); await nextMsg(ws)
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    await app.inject({ method: 'POST', url: '/api/auth/revoke-all', headers: { cookie } })
    expect(await closed).toBe(1008)
  })

  it('PATCH num usuário fecha só os sockets dele', async () => {
    const rootCookie = await loginCookie('root')
    const anaId = auth.users.getByUsername('ana')!.id
    const anaWs = openWs(await loginCookie('ana'))
    const rootWs = openWs(rootCookie)
    await Promise.all([opened(anaWs), opened(rootWs)])
    await Promise.all([nextMsg(anaWs), nextMsg(rootWs)])
    const anaClosed = new Promise<number>((r) => anaWs.once('close', (code) => r(code)))
    await app.inject({ method: 'PATCH', url: `/api/auth/users/${anaId}`, headers: { cookie: rootCookie }, payload: { projectIds: [] } })
    expect(await anaClosed).toBe(1008)
    expect(rootWs.readyState).toBe(rootWs.OPEN)
    rootWs.close()
  })
})

describe('comandos do WS respeitam RBAC', () => {
  it('send_message em sessão de projeto alheio → erro forbidden', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/projects/${p2.id}/sessions`, headers: { cookie: await loginCookie('root') }, payload: {} })
    const localId = start.json().localId
    const anaWs = openWs(await loginCookie('ana'))
    await opened(anaWs); await nextMsg(anaWs)
    const err = nextMsg(anaWs)
    anaWs.send(JSON.stringify({ type: 'send_message', localId, text: 'oi' }))
    await expect(err).resolves.toMatchObject({ type: 'error', message: 'forbidden' })
    anaWs.close()
  })
})
