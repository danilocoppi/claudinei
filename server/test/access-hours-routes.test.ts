import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { createAuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createWsHub } from '../src/routes/ws.js'
import { createTerminalManager } from '../src/terminal/manager.js'
import { createProjectsService } from '../src/projects.js'
import { createActionsStore } from '../src/actions.js'
import { loadConfig } from '../src/config.js'
import type { PtyProcess } from '../src/terminal/pty.js'

const policy = { timeZone: 'UTC', windows: [{ days: [1], start: '09:00', end: '10:00' }] }
let now: number, dir: string, port: number, userId: number, projectId: number, actionId: number
let expireWhileParsing = false
let db: ReturnType<typeof openDb>, auth: ReturnType<typeof createAuthService>, app: Awaited<ReturnType<typeof buildApp>>
let hub: ReturnType<typeof createWsHub>, manager: ReturnType<typeof createSessionManager>, terminals: ReturnType<typeof createTerminalManager>
let emitData: (data: string) => void
const writes = vi.fn(), kills = vi.fn(), factory = vi.fn(), sends = vi.fn()
const sockets: WebSocket[] = []
const cookie = (id = userId) => ({ [COOKIE_NAME]: auth.tokens.signUser(id, auth.users.tokenVersion(id)!) })
const waitFor = async (fn: () => boolean) => {
  const until = Date.now() + 3000
  while (!fn()) { if (Date.now() >= until) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)) }
}
const connect = (path: string, id = userId) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { cookie: `${COOKIE_NAME}=${cookie(id)[COOKIE_NAME]}` } })
  sockets.push(ws)
  const messages: string[] = []
  ws.on('message', data => messages.push(data.toString()))
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  return { ws, messages, opened }
}
beforeEach(async () => {
  expireWhileParsing = false
  now = Date.parse('2026-09-07T09:59:58Z'); dir = mkdtempSync(join(tmpdir(), 'access-routes-'))
  writes.mockClear(); kills.mockClear(); factory.mockClear(); sends.mockClear()
  db = openDb(':memory:'); auth = createAuthService({ db, now: () => now }); hub = createWsHub()
  manager = createSessionManager({ db, broadcast: hub.broadcast }); vi.spyOn(manager, 'send').mockImplementation(sends)
  const proc: PtyProcess = { write: writes, resize: vi.fn(), kill: kills, onData: cb => { emitData = cb }, onExit: vi.fn() }
  factory.mockReturnValue(proc); terminals = createTerminalManager({ ptyFactory: factory })
  projectId = createProjectsService(db).create({ name: 'Allowed', path: dir }).id
  db.prepare("INSERT INTO sessions(local_id,project_id,status) VALUES('session',?,'working')").run(projectId)
  actionId = createActionsStore(db).create(projectId, { name: 'Task', commands: ['echo test'] }).id
  auth.users.create({ username: 'admin', password: 'password1', isAdmin: true })
  userId = auth.users.create({ username: 'limited', password: 'password1', projectIds: [projectId], accessHours: policy }).id
  app = await buildApp({ config: loadConfig({}), db, manager, auth, wsHub: hub, terminalManager: terminals,
    onUserInvalidated: id => hub.closeUser(id) })
  app.addHook('preParsing', async (_req, _reply, payload) => {
    if (expireWhileParsing) now = Date.parse('2026-09-07T10:00:00Z')
    return payload
  })
  await app.listen({ host: '127.0.0.1', port: 0 }); port = (app.server.address() as { port: number }).port
})
afterEach(async () => {
  for (const ws of sockets.splice(0)) if (ws.readyState !== ws.CLOSED) ws.terminate()
  await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks()
})

describe('server-enforced access windows', () => {
  it('rechecks a request that crossed the cutoff while its body was arriving', async () => {
    expireWhileParsing = true
    const res = await app.inject({ method: 'POST', url: `/api/actions/${actionId}/run`, cookies: cookie(), payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'access_hours_restricted' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('creates and lists a restricted user without changing the existing grants', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/users', cookies: cookie(1), payload: {
      username: 'new-user', password: 'password1', projectIds: [projectId], accessHours: policy,
    } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ accessHours: policy, projectIds: [projectId], isAdmin: false })
    const listed = (await app.inject({ url: '/api/auth/users', cookies: cookie(1) })).json()
    expect(listed.find((u: { id: number }) => u.id === res.json().id)).toMatchObject(res.json())
  })

  it('blocks all protected routes with a valid cookie or bearer, including encoded paths', async () => {
    expect((await app.inject({ url: '/api/projects', cookies: cookie() })).statusCode).toBe(200)
    now = Date.parse('2026-09-07T10:00:00Z')
    for (const [method, url] of [
      ['GET', '/api/projects'], ['GET', '/%61pi/projects'], ['GET', '/api/engines'],
      ['POST', '/api/projects'], ['POST', `/api/projects/${projectId}/sessions`],
      ['GET', '/api/sessions/session/history'], ['POST', '/api/sessions/session/terminal'],
      ['POST', `/api/actions/${actionId}/run`], ['DELETE', `/api/actions/${actionId}/run`],
      ['POST', '/api/orchestrator/dispatch'], ['POST', '/api/uploads'],
    ] as const) {
      const res = await app.inject({ method, url, cookies: cookie() })
      expect(res.statusCode, url).toBe(403); expect(res.json()).toEqual({ error: 'access_hours_restricted' })
    }
    expect((await app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${cookie()[COOKIE_NAME]}` } })).statusCode).toBe(403)
    expect(factory).not.toHaveBeenCalled(); expect(sends).not.toHaveBeenCalled()
    expect((await app.inject({ url: '/api/projects', cookies: cookie(1) })).statusCode).toBe(200)
    const me = (await app.inject({ url: '/api/auth/me', cookies: cookie() })).json()
    expect(me).toMatchObject({ accessHours: policy, access: { allowed: false, serverNow: now } })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'limited', password: 'password1' } })
    expect(login.json().access.allowed).toBe(false)
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: cookie() })).statusCode).toBe(204)
    now = Date.parse('2026-09-14T09:00:00Z')
    expect((await app.inject({ url: '/api/projects', cookies: cookie() })).statusCode).toBe(200)
  })

  it('applies configured restrictions to administrators too', async () => {
    auth.users.update(1, { accessHours: policy }); now = Date.parse('2026-09-07T10:00:00Z')
    expect((await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie(1), payload: { name: 'Denied', path: dir } })).json()).toEqual({ error: 'access_hours_restricted' })
  })

  it('edits/removes policy through admin CRUD without granting extra terminal permissions', async () => {
    const invalid = await app.inject({ method: 'PATCH', url: `/api/auth/users/${userId}`, cookies: cookie(1), payload: { accessHours: { ...policy, timeZone: 'bad/zone' } } })
    expect(invalid.statusCode).toBe(400); expect(auth.users.get(userId)?.accessHours).toEqual(policy)
    now = Date.parse('2026-09-07T10:00:00Z')
    const updated = await app.inject({ method: 'PATCH', url: `/api/auth/users/${userId}`, cookies: cookie(1), payload: { accessHours: null } })
    expect(updated.json()).toMatchObject({ accessHours: null, projectIds: [projectId] })
    expect((await app.inject({ url: '/api/projects', cookies: cookie() })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/projects', cookies: cookie(), payload: { name: 'Denied', path: dir } })).statusCode).toBe(403)
  })

  it('stops commands and broadcasts on an existing chat socket at the boundary', async () => {
    const limited = connect('/ws'), admin = connect('/ws', 1)
    await Promise.all([limited.opened, admin.opened])
    limited.ws.send(JSON.stringify({ type: 'send_message', localId: 'session', text: 'inside' }))
    await waitFor(() => sends.mock.calls.length === 1)
    now = Date.parse('2026-09-07T10:00:00Z')
    limited.ws.send(JSON.stringify({ type: 'send_message', localId: 'session', text: 'outside' }))
    hub.broadcast({ type: 'session_event', localId: 'session', event: { kind: 'stream', text: 'private-after-cutoff' } })
    await waitFor(() => limited.ws.readyState === WebSocket.CLOSED)
    expect(sends).toHaveBeenCalledTimes(1)
    expect(limited.messages.some(m => m.includes('private-after-cutoff'))).toBe(false)
    await waitFor(() => admin.messages.some(m => m.includes('private-after-cutoff')))
    expect(manager.get('session')?.status).toBe('working')
  })

  it.each(['session', 'action'])('cuts an already attached %s PTY without killing the process', async kind => {
    const key = kind === 'action' ? `act-${actionId}` : 'session'
    const token = terminals.open(key, { cwd: dir, file: 'fake', args: [], onExit: vi.fn() })
    const client = connect(`/ws/terminal/${key}?token=${token}`); await client.opened
    client.ws.send(Buffer.from('inside'))
    await waitFor(() => writes.mock.calls.length === 1)
    now = Date.parse('2026-09-07T10:00:00Z')
    client.ws.send(Buffer.from('outside')); emitData('private-after-cutoff')
    await waitFor(() => client.ws.readyState === WebSocket.CLOSED)
    expect(writes).toHaveBeenCalledTimes(1); expect(client.messages).not.toContain('private-after-cutoff')
    expect(kills).not.toHaveBeenCalled(); expect(terminals.isAlive(key)).toBe(true)
    const reconnect = connect(`/ws/terminal/${key}?token=${token}`)
    await expect(reconnect.opened).rejects.toThrow('403')
  })

  it('disconnects a silent client when a policy changes, without waiting for input', async () => {
    const client = connect('/ws'); await client.opened
    auth.users.update(userId, { accessHours: { ...policy, windows: [{ days: [2], start: '09:00', end: '10:00' }] } })
    await waitFor(() => client.ws.readyState === WebSocket.CLOSED)
    expect(manager.get('session')?.status).toBe('working')
  })
})
