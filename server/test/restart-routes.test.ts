import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createTerminalStateStore, type TerminalStateStore } from '../src/restart/terminal-state.js'
import { RESUME_PREFIX, RESUME_TEXT, type RestartService } from '../src/restart/boot.js'

/**
 * Rotas do reinício sem prejuízo: os interruptores por terminal, o Continuar,
 * o fechar do aviso e a lista que a interface lê ao abrir. Cada mudança vai às
 * telas como `{ type: 'terminal_state', state }`.
 */
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService
let manager: ReturnType<typeof createSessionManager>
let store: TerminalStateStore
let restart: RestartService | undefined
let broadcasts: any[]
let mgrBroadcasts: any[]
let brokenPaths: Set<string>
let p1: Project, p2: Project
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

const fakeFactory = (opts: SessionOptions) => {
  if (brokenPaths.has(opts.projectPath)) throw new Error('motor recusou')
  return new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
}

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

/** Sessão anterior persistida (parada), como a que sobra depois do reinício. */
const seedSession = (project: Project) => {
  const localId = randomUUID()
  db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES (?, ?, 'claude', 'stopped')`)
    .run(localId, project.id)
  return localId
}

const resumeEchoes = () => mgrBroadcasts.filter((b) =>
  b.type === 'session_event' && b.event?.kind === 'user' &&
  String(b.event.message?.content?.[0]?.text ?? '').startsWith(RESUME_PREFIX))
const states = () => broadcasts.filter((b) => b.type === 'terminal_state')

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  broadcasts = []
  mgrBroadcasts = []
  brokenPaths = new Set()
  restart = undefined
  manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m) })
  store = createTerminalStateStore(db)
  app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as never,
    onRestartReady: (r) => { restart = r },
  })
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'rr1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'rr2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
})

afterEach(async () => {
  await manager.stopAll()
  await app.close()
})

const patch = (pid: number, payload: unknown, cookies = adminCookie, engine = 'claude') =>
  app.inject({ method: 'PATCH', url: `/api/projects/${pid}/terminals/${engine}/restart`, cookies, payload: payload as object })
const cont = (pid: number, cookies = adminCookie, engine = 'claude') =>
  app.inject({ method: 'POST', url: `/api/projects/${pid}/terminals/${engine}/continue`, cookies })
const dismiss = (pid: number, cookies = adminCookie, engine = 'claude') =>
  app.inject({ method: 'DELETE', url: `/api/projects/${pid}/terminals/${engine}/interruption`, cookies })
const list = (cookies = adminCookie) => app.inject({ method: 'GET', url: '/api/terminals/state', cookies })

describe('rotas do reinício', () => {
  it('o app entrega o serviço por onRestartReady', () => {
    expect(restart).toBeDefined()
    expect(typeof restart!.boot).toBe('function')
  })

  it('PATCH grava e devolve o DTO', async () => {
    const res = await patch(p1.id, { autostart: true })
    expect(res.statusCode).toBe(200)
    const dto = {
      projectId: p1.id, engine: 'claude', autostart: true, autoResume: false, interruption: null,
      autoResumeLimit: false, usageLimit: null, taskResults: [],
    }
    expect(res.json()).toEqual(dto)
    expect(store.get(p1.id, 'claude')).toMatchObject({ autostart: true, autoResume: false })
    expect(states()).toEqual([{ type: 'terminal_state', state: dto }])

    // Só o que veio muda; o outro interruptor mantém o valor.
    const res2 = await patch(p1.id, { autoResume: true })
    expect(res2.json()).toMatchObject({ autostart: true, autoResume: true })
    expect((await list()).json()).toEqual([{ ...dto, autoResume: true }])
  })

  it('PATCH sem booleano dá 400', async () => {
    expect((await patch(p1.id, {})).statusCode).toBe(400)
    expect((await patch(p1.id, { autostart: 'sim' })).statusCode).toBe(400)
    expect((await patch(p1.id, { autostart: true, autoResume: 1 })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${p1.id}/terminals/claude/restart`, cookies: adminCookie })).statusCode).toBe(400)
    expect(store.list()).toEqual([])
    expect(states()).toEqual([])
  })

  it('engine inválido dá 400', async () => {
    for (const res of [
      await patch(p1.id, { autostart: true }, adminCookie, 'nope'),
      await cont(p1.id, adminCookie, 'nope'),
      await dismiss(p1.id, adminCookie, 'nope'),
    ]) {
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('unknown_engine')
    }
    expect(store.list()).toEqual([])
  })

  it('projeto inexistente dá 404; id inválido dá 400', async () => {
    expect((await patch(999, { autostart: true })).statusCode).toBe(404)
    expect((await cont(999)).statusCode).toBe(404)
    expect((await dismiss(999)).statusCode).toBe(404)
    expect((await patch(0, { autostart: true })).statusCode).toBe(400)
    expect(store.list()).toEqual([])
  })

  it('usuário sem acesso ao projeto recebe 403 e não vê o terminal no GET', async () => {
    store.setPrefs(p1.id, 'claude', { autostart: true })
    store.setPrefs(p2.id, 'claude', { autoResume: true })
    store.markInterrupted(p2.id, 'claude', seedSession(p2), null)

    expect((await patch(p2.id, { autostart: true }, anaCookie)).statusCode).toBe(403)
    expect((await cont(p2.id, anaCookie)).statusCode).toBe(403)
    expect((await dismiss(p2.id, anaCookie)).statusCode).toBe(403)
    // Nada mudou no terminal alheio.
    expect(store.get(p2.id, 'claude')).toMatchObject({ autostart: false, interruptedAt: expect.any(String) })
    expect(resumeEchoes()).toHaveLength(0)

    const daAna = await list(anaCookie)
    expect(daAna.statusCode).toBe(200)
    expect(daAna.json().map((s: any) => s.projectId)).toEqual([p1.id])
    expect((await list()).json().map((s: any) => s.projectId)).toEqual([p1.id, p2.id])
    // No projeto dela, a ana mexe.
    expect((await patch(p1.id, { autoResume: true }, anaCookie)).statusCode).toBe(200)
  })

  it('continue sem interrupção dá 409', async () => {
    const res = await cont(p1.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('nothing_to_continue')
    expect(resumeEchoes()).toHaveLength(0)
  })

  it('continue com interrupção revive e manda a mensagem', async () => {
    const localId = seedSession(p1)
    store.markInterrupted(p1.id, 'claude', localId, null)
    store.setHold(p1.id, 'claude', 'off')

    const res = await cont(p1.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(manager.get(localId)?.status).not.toBe('stopped')
    await waitUntil(() => resumeEchoes().length === 1)
    expect(resumeEchoes()[0].localId).toBe(localId)
    expect(resumeEchoes()[0].event.message.content[0].text).toBe(RESUME_TEXT)
    expect(store.get(p1.id, 'claude').interruptedAt).toBeNull()
    expect(states().at(-1)).toEqual({ type: 'terminal_state', state: expect.objectContaining({ projectId: p1.id, interruption: null }) })

    // O segundo clique não acha mais nada para continuar.
    expect((await cont(p1.id)).statusCode).toBe(409)
  })

  it('continue cujo revive falha devolve o erro e a marca fica', async () => {
    const localId = seedSession(p1)
    store.markInterrupted(p1.id, 'claude', localId, null)
    brokenPaths.add(p1.path)

    const res = await cont(p1.id)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('motor recusou')
    expect(store.get(p1.id, 'claude').interruptedAt).not.toBeNull()
  })

  it('continue e DELETE durante o encerramento dão 409 shutting_down e a marca fica', async () => {
    const localId = seedSession(p1)
    store.markInterrupted(p1.id, 'claude', localId, null)
    manager.beginShutdown()

    for (const res of [await cont(p1.id), await dismiss(p1.id)]) {
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('shutting_down')
    }
    expect(store.get(p1.id, 'claude').interruptedLocalId).toBe(localId)
    expect(manager.get(localId)?.status ?? 'stopped').toBe('stopped')
    expect(states()).toEqual([])
  })

  it('continue com a sessão no meio de um turno dá 409 session_busy e não manda nada', async () => {
    const info = manager.start(p1, { engine: 'claude' })
    await waitUntil(() => manager.get(info.localId)?.status === 'idle')
    manager.send(info.localId, 'demorada')
    await waitUntil(() => manager.get(info.localId)?.status === 'working')
    store.markInterrupted(p1.id, 'claude', info.localId, null)
    store.setHold(p1.id, 'claude', 'off')

    const res = await cont(p1.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('session_busy')
    expect(resumeEchoes()).toHaveLength(0)
    expect(store.get(p1.id, 'claude').holdReason).toBe('off')
  })

  it('DELETE limpa e faz broadcast terminal_state', async () => {
    store.markInterrupted(p1.id, 'claude', seedSession(p1), null)
    store.setHold(p1.id, 'claude', 'question')

    const res = await dismiss(p1.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(store.get(p1.id, 'claude')).toMatchObject({ interruptedAt: null, holdReason: null })
    expect(states()).toEqual([{
      type: 'terminal_state',
      state: {
        projectId: p1.id, engine: 'claude', autostart: false, autoResume: false, interruption: null,
        autoResumeLimit: false, usageLimit: null, taskResults: [],
      },
    }])
    expect(resumeEchoes()).toHaveLength(0)
  })
})
