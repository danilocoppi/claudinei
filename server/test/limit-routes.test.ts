import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
import { startAfterListen } from '../src/restart/boot.js'
import type { UsageLimitService } from '../src/limit/usage-limit.js'
import { LIMIT_RESUME_PREFIX, LIMIT_RESUME_TEXT } from '../src/limit/texts.js'

/**
 * Rotas do "bateu o limite": o interruptor por terminal (no mesmo PATCH do
 * reinício), as ações sobre o aviso (armar, adiar, cancelar, continuar agora)
 * e a ordem da subida depois do listen.
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
let limit: UsageLimitService | undefined
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

/** Sessão anterior persistida (parada), como a que sobra depois do limite. */
const seedSession = (project: Project) => {
  const localId = randomUUID()
  db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES (?, ?, 'claude', 'stopped')`)
    .run(localId, project.id)
  return localId
}

/** Reabertura daqui a uma hora, em epoch SEGUNDOS (como vem do rate_limit_event). */
const futureReset = () => Math.floor(Date.now() / 1000) + 3600

const limitEchoes = () => mgrBroadcasts.filter((b) =>
  b.type === 'session_event' && b.event?.kind === 'user' &&
  String(b.event.message?.content?.[0]?.text ?? '').startsWith(LIMIT_RESUME_PREFIX))
const states = () => broadcasts.filter((b) => b.type === 'terminal_state')

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  broadcasts = []
  mgrBroadcasts = []
  brokenPaths = new Set()
  limit = undefined
  manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m) })
  store = createTerminalStateStore(db)
  app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as never,
    onLimitReady: (l) => { limit = l },
  })
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'lr1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'lr2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
})

afterEach(async () => {
  limit?.dispose()
  await manager.stopAll()
  await app.close()
})

const patch = (pid: number, payload: unknown, cookies = adminCookie, engine = 'claude') =>
  app.inject({ method: 'PATCH', url: `/api/projects/${pid}/terminals/${engine}/restart`, cookies, payload: payload as object })
const act = (pid: number, action: unknown, cookies = adminCookie, engine = 'claude') =>
  app.inject({ method: 'POST', url: `/api/projects/${pid}/terminals/${engine}/limit`, cookies, payload: { action } as object })

describe('rotas do limite', () => {
  it('o app entrega o serviço por onLimitReady', () => {
    expect(limit).toBeDefined()
    expect(typeof limit!.boot).toBe('function')
  })

  it('PATCH com autoResumeLimit grava e devolve o DTO', async () => {
    const res = await patch(p1.id, { autoResumeLimit: true })
    expect(res.statusCode).toBe(200)
    const dto = {
      projectId: p1.id, engine: 'claude', autostart: false, autoResume: false, interruption: null,
      autoResumeLimit: true, usageLimit: null, taskResults: [],
    }
    expect(res.json()).toEqual(dto)
    expect(store.get(p1.id, 'claude').autoResumeLimit).toBe(true)
    expect(states()).toEqual([{ type: 'terminal_state', state: dto }])

    // Só o que veio muda: os interruptores do reinício ficam como estavam.
    const res2 = await patch(p1.id, { autostart: true })
    expect(res2.json()).toMatchObject({ autostart: true, autoResumeLimit: true })
    expect((await patch(p1.id, { autoResumeLimit: false })).json()).toMatchObject({ autostart: true, autoResumeLimit: false })

    // Não booleano dá 400 e não grava.
    expect((await patch(p2.id, { autoResumeLimit: 'sim' })).statusCode).toBe(400)
    expect(store.get(p2.id, 'claude').autoResumeLimit).toBe(false)
  })

  it('arm, snooze e cancel mudam a ação e devolvem o DTO', async () => {
    const resetsAt = futureReset()
    store.recordUsageLimit(p1.id, 'claude', { resetsAt, origin: 'operator' })

    const armed = await act(p1.id, 'arm')
    expect(armed.statusCode).toBe(200)
    expect(armed.json()).toMatchObject({ projectId: p1.id, usageLimit: { resetsAt, action: 'armed', origin: 'operator' } })
    expect(store.get(p1.id, 'claude').limitAction).toBe('armed')
    expect(states().at(-1)).toEqual({ type: 'terminal_state', state: armed.json() })

    const snoozed = await act(p1.id, 'snooze')
    expect(snoozed.statusCode).toBe(200)
    expect(snoozed.json().usageLimit.action).toBe('snoozed')

    // De adiado, cancelar devolve o aviso (none).
    const back = await act(p1.id, 'cancel')
    expect(back.statusCode).toBe(200)
    expect(back.json().usageLimit).toMatchObject({ action: 'none', resetsAt })

    // De none, cancelar dispensa o aviso.
    const gone = await act(p1.id, 'cancel')
    expect(gone.statusCode).toBe(200)
    expect(gone.json().usageLimit).toBeNull()
    expect(store.get(p1.id, 'claude').limitHitAt).toBeNull()
    expect(limitEchoes()).toHaveLength(0)
  })

  it('sem limite ativo, toda ação dá 409 no_usage_limit', async () => {
    for (const action of ['arm', 'snooze', 'cancel', 'continue']) {
      const res = await act(p1.id, action)
      expect(res.statusCode, action).toBe(409)
      expect(res.json().code, action).toBe('no_usage_limit')
    }
    expect(states()).toEqual([])
  })

  it('reabertura desconhecida ou passada: arm e snooze dão 409 reset_unknown', async () => {
    store.recordUsageLimit(p1.id, 'claude', { resetsAt: null, origin: 'operator' })
    store.recordUsageLimit(p2.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) - 60, origin: 'operator' })
    for (const pid of [p1.id, p2.id]) {
      for (const action of ['arm', 'snooze']) {
        const res = await act(pid, action)
        expect(res.statusCode, action).toBe(409)
        expect(res.json().code, action).toBe('reset_unknown')
      }
      expect(store.get(pid, 'claude').limitAction).toBe('none')
    }
  })

  it('continue revive, manda a mensagem do limite e limpa o aviso', async () => {
    const localId = seedSession(p1)
    store.recordUsageLimit(p1.id, 'claude', { resetsAt: futureReset(), origin: 'operator' })

    const res = await act(p1.id, 'continue')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ projectId: p1.id, usageLimit: null })
    expect(manager.get(localId)?.status).not.toBe('stopped')
    await waitUntil(() => limitEchoes().length === 1)
    expect(limitEchoes()[0].event.message.content[0].text).toBe(LIMIT_RESUME_TEXT)
    expect(store.get(p1.id, 'claude').limitHitAt).toBeNull()
    // O clique não conta para o teto das automáticas.
    expect(store.get(p1.id, 'claude').limitTries).toBe(0)

    // O segundo clique não acha mais o limite.
    const again = await act(p1.id, 'continue')
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('no_usage_limit')
  })

  it('continue cujo revive falha devolve o erro e o aviso fica', async () => {
    seedSession(p1)
    store.recordUsageLimit(p1.id, 'claude', { resetsAt: futureReset(), origin: 'operator' })
    brokenPaths.add(p1.path)

    const res = await act(p1.id, 'continue')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('motor recusou')
    expect(store.get(p1.id, 'claude').limitHitAt).not.toBeNull()
    expect(limitEchoes()).toHaveLength(0)
  })

  it('continue com a sessão no meio de um turno dá 409 session_busy e não manda nada', async () => {
    const info = manager.start(p1, { engine: 'claude' })
    await waitUntil(() => manager.get(info.localId)?.status === 'idle')
    manager.send(info.localId, 'demorada')
    await waitUntil(() => manager.get(info.localId)?.status === 'working')
    store.recordUsageLimit(p1.id, 'claude', { resetsAt: futureReset(), origin: 'operator' })

    const res = await act(p1.id, 'continue')
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('session_busy')
    expect(limitEchoes()).toHaveLength(0)
    expect(store.get(p1.id, 'claude').limitHitAt).not.toBeNull()
  })

  it('durante o encerramento as ações dão 409 shutting_down e nada muda', async () => {
    seedSession(p1)
    store.recordUsageLimit(p1.id, 'claude', { resetsAt: futureReset(), origin: 'operator' })
    manager.beginShutdown()

    for (const action of ['arm', 'snooze', 'cancel', 'continue']) {
      const res = await act(p1.id, action)
      expect(res.statusCode, action).toBe(409)
      expect(res.json().code, action).toBe('shutting_down')
    }
    expect(store.get(p1.id, 'claude')).toMatchObject({ limitAction: 'none', limitHitAt: expect.any(String) })
    expect(limitEchoes()).toHaveLength(0)
    expect(states()).toEqual([])
  })

  it('ação inválida dá 400', async () => {
    store.recordUsageLimit(p1.id, 'claude', { resetsAt: futureReset(), origin: 'operator' })
    for (const action of ['resume', undefined, 1, null]) {
      expect((await act(p1.id, action)).statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/terminals/claude/limit`, cookies: adminCookie })).statusCode).toBe(400)
    expect(store.get(p1.id, 'claude').limitAction).toBe('none')
    expect(states()).toEqual([])
  })

  it('engine inválido dá 400; projeto inexistente dá 404', async () => {
    const res = await act(p1.id, 'arm', adminCookie, 'nope')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown_engine')
    expect((await act(999, 'arm')).statusCode).toBe(404)
  })

  it('usuário sem acesso ao projeto recebe 403', async () => {
    const resetsAt = futureReset()
    store.recordUsageLimit(p2.id, 'claude', { resetsAt, origin: 'operator' })

    expect((await patch(p2.id, { autoResumeLimit: true }, anaCookie)).statusCode).toBe(403)
    for (const action of ['arm', 'snooze', 'cancel', 'continue']) {
      expect((await act(p2.id, action, anaCookie)).statusCode, action).toBe(403)
    }
    // Nada mudou no terminal alheio.
    expect(store.get(p2.id, 'claude')).toMatchObject({ autoResumeLimit: false, limitAction: 'none', limitResetsAt: resetsAt })
    expect(limitEchoes()).toHaveLength(0)

    // No projeto dela, a ana mexe.
    store.recordUsageLimit(p1.id, 'claude', { resetsAt, origin: 'operator' })
    expect((await act(p1.id, 'arm', anaCookie)).statusCode).toBe(200)
    expect((await patch(p1.id, { autoResumeLimit: true }, anaCookie)).statusCode).toBe(200)
  })
})

describe('startAfterListen com o limite', () => {
  it('limit.boot roda depois do restart.boot e antes do agendador', async () => {
    const ordem: string[] = []
    let terminarRestart!: () => void
    let terminarLimit!: () => void
    const restart = { boot: () => new Promise<void>((r) => { ordem.push('restart:start'); terminarRestart = () => { ordem.push('restart:end'); r() } }) }
    const limitSvc = { boot: vi.fn(() => new Promise<void>((r) => { ordem.push('limit:start'); terminarLimit = () => { ordem.push('limit:end'); r() } })) }
    const scheduler = { start: vi.fn(() => { ordem.push('scheduler') }) }

    const pronto = startAfterListen({ restart, limit: limitSvc, scheduler })
    await new Promise((r) => setTimeout(r, 20))
    // O limite espera a subida do reinício terminar (a marca absorvida depende disso).
    expect(limitSvc.boot).not.toHaveBeenCalled()
    terminarRestart()
    await new Promise((r) => setTimeout(r, 20))
    expect(limitSvc.boot).toHaveBeenCalledTimes(1)
    expect(scheduler.start).not.toHaveBeenCalled()
    terminarLimit()
    await pronto
    expect(ordem).toEqual(['restart:start', 'restart:end', 'limit:start', 'limit:end', 'scheduler'])
  })

  it('falha do limit.boot é registrada e não impede o agendador', async () => {
    const logs: string[] = []
    const scheduler = { start: vi.fn() }
    await expect(startAfterListen({
      restart: { boot: async () => {} },
      limit: { boot: () => Promise.reject(new Error('relógio quebrado')) },
      scheduler,
      log: (m) => logs.push(m),
    })).resolves.toBeUndefined()
    expect(scheduler.start).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('relógio quebrado')
  })

  it('falha do restart.boot não impede o limit.boot', async () => {
    const limitSvc = { boot: vi.fn(async () => {}) }
    const scheduler = { start: vi.fn() }
    await startAfterListen({
      restart: { boot: () => Promise.reject(new Error('banco travado')) },
      limit: limitSvc, scheduler, log: () => {},
    })
    expect(limitSvc.boot).toHaveBeenCalledTimes(1)
    expect(scheduler.start).toHaveBeenCalledTimes(1)
  })

  it('encerramento começado durante a subida do reinício não roda o limit.boot nem o agendador', async () => {
    let encerrando = false
    const limitSvc = { boot: vi.fn(async () => {}) }
    const scheduler = { start: vi.fn() }
    await startAfterListen({
      restart: { boot: async () => { encerrando = true } },
      limit: limitSvc, scheduler,
      isShuttingDown: () => encerrando,
    })
    expect(limitSvc.boot).not.toHaveBeenCalled()
    expect(scheduler.start).not.toHaveBeenCalled()
  })
})
