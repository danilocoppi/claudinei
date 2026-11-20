import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createTasksService } from '../src/tasks.js'
import {
  createTerminalStateStore, RESTART_FAIL_TEXT,
  type TerminalStateRow, type TerminalStateStore,
} from '../src/restart/terminal-state.js'
import {
  planBoot, createRestartService, RESUME_PREFIX, RESUME_TEXT, MAX_AUTO_RESUMES,
} from '../src/restart/boot.js'
import type { OrchestratorHooks } from '../src/routes/orchestrator.js'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

// ---------------------------------------------------------------- planBoot

const row = (over: Partial<TerminalStateRow> = {}): TerminalStateRow => ({
  projectId: 1, engine: 'claude',
  autostart: false, autoResume: false,
  interruptedAt: null, interruptedLocalId: null,
  lostQuestion: null, resumeCount: 0, holdReason: null,
  ...over,
})
const interrupted = (over: Partial<TerminalStateRow> = {}) =>
  row({ interruptedAt: '2026-11-20 10:00:00', interruptedLocalId: 'loc-int', ...over })
const latest = (id: string | null = 'loc-ult') => () => id
const pergunta = [{ question: 'Qual cor?', header: 'Cor', options: [], multiSelect: false }] as any

describe('planBoot', () => {
  it('interrompido com pergunta segura, mesmo com retomar ligado', () => {
    expect(planBoot([interrupted({ autoResume: true, lostQuestion: pergunta })], latest())).toEqual([
      { kind: 'hold', projectId: 1, engine: 'claude', reason: 'question', alsoIdle: false, localId: 'loc-int' },
    ])
  })

  it('pergunta vazia não conta como pergunta', () => {
    expect(planBoot([interrupted({ autoResume: true, lostQuestion: [] })], latest())).toEqual([
      { kind: 'resume', projectId: 1, engine: 'claude', localId: 'loc-int' },
    ])
  })

  it('interrompido com retomar ligado e no teto segura com limit', () => {
    expect(planBoot([interrupted({ autoResume: true, resumeCount: MAX_AUTO_RESUMES })], latest())).toEqual([
      { kind: 'hold', projectId: 1, engine: 'claude', reason: 'limit', alsoIdle: false, localId: 'loc-int' },
    ])
  })

  it('interrompido com retomar ligado abaixo do teto retoma', () => {
    expect(planBoot([interrupted({ autoResume: true })], latest())).toEqual([
      { kind: 'resume', projectId: 1, engine: 'claude', localId: 'loc-int' },
    ])
  })

  it('interrompido com retomar desligado segura com off', () => {
    expect(planBoot([interrupted()], latest())).toEqual([
      { kind: 'hold', projectId: 1, engine: 'claude', reason: 'off', alsoIdle: false, localId: 'loc-int' },
    ])
  })

  it('não interrompido com iniciar ligado sobe parado com a sessão mais recente', () => {
    expect(planBoot([row({ autostart: true })], latest())).toEqual([
      { kind: 'idle', projectId: 1, engine: 'claude', localId: 'loc-ult' },
    ])
    expect(planBoot([row({ autostart: true })], latest(null))).toEqual([
      { kind: 'idle', projectId: 1, engine: 'claude', localId: null },
    ])
  })

  it('não interrompido sem iniciar não faz nada', () => {
    expect(planBoot([row(), row({ autoResume: true })], latest())).toEqual([])
  })

  it('no hold, alsoIdle segue o iniciar', () => {
    const [a] = planBoot([interrupted({ autostart: true })], latest())
    expect(a).toMatchObject({ kind: 'hold', reason: 'off', alsoIdle: true })
  })

  it('retomar ligado e contador 2 retoma; 3 segura', () => {
    expect(planBoot([interrupted({ autoResume: true, resumeCount: 2 })], latest())[0].kind).toBe('resume')
    expect(planBoot([interrupted({ autoResume: true, resumeCount: 3 })], latest())[0]).toMatchObject({ kind: 'hold', reason: 'limit' })
  })

  it('ordem: resume antes de idle', () => {
    const out = planBoot([
      row({ projectId: 1, autostart: true }),
      interrupted({ projectId: 2, autostart: true }),
      interrupted({ projectId: 3, autoResume: true }),
      interrupted({ projectId: 4 }),
      interrupted({ projectId: 5, autoResume: true }),
    ], latest())
    expect(out.map((a) => [a.kind, a.projectId])).toEqual([
      ['resume', 3], ['resume', 5], ['idle', 1], ['hold', 2], ['hold', 4],
    ])
  })

  it('interrompido sem sessão nenhuma para retomar segura com failed', () => {
    expect(planBoot([interrupted({ autoResume: true, interruptedLocalId: null })], latest(null))).toEqual([
      { kind: 'hold', projectId: 1, engine: 'claude', reason: 'failed', alsoIdle: false, localId: null },
    ])
  })

  it('hold sem autostart não sobe', () => {
    const [a] = planBoot([interrupted({ autostart: false })], latest())
    expect(a).toMatchObject({ kind: 'hold', alsoIdle: false })
  })
})

// ---------------------------------------------------------------- executor

let db: Db
let mgr: ReturnType<typeof createSessionManager>
let store: TerminalStateStore
let mgrBroadcasts: any[]
let stateBroadcasts: any[]
let brokenPaths: Set<string>
let orch: OrchestratorHooks

const fakeFactory = (opts: SessionOptions) => {
  if (brokenPaths.has(opts.projectPath)) throw new Error('motor recusou')
  return new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
}

const newProject = (name: string) =>
  createProjectsService(db).create({ name, path: mkdtempSync(join(tmpdir(), 'boot-')) })

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

beforeEach(async () => {
  db = openDb(':memory:')
  mgrBroadcasts = []
  stateBroadcasts = []
  brokenPaths = new Set()
  mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m) })
  store = createTerminalStateStore(db)
  await buildApp({
    config: loadConfig({}), db, manager: mgr,
    wsHub: { broadcast: () => {}, register: () => {} } as any,
    onOrchestratorReady: (o) => { orch = o },
  })
})

afterEach(async () => { await mgr.stopAll() })

const makeService = (over: { sleep?: (ms: number) => Promise<void>; closeInterruptedRuns?: () => number } = {}) => {
  const sleeps: number[] = []
  const svc = createRestartService({
    db, manager: mgr, store,
    orchestrator: () => orch,
    broadcast: (m) => stateBroadcasts.push(m),
    sleep: over.sleep ?? (async (ms) => { sleeps.push(ms) }),
    closeInterruptedRuns: over.closeInterruptedRuns,
    log: () => {},
  })
  return { svc, sleeps }
}

const activeOf = (project: Project) =>
  mgr.list().find((s) => s.projectId === project.id && ['starting', 'idle', 'working', 'needs_attention'].includes(s.status))

describe('createRestartService.boot', () => {
  it('boot retoma e manda a mensagem do Claudinei', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.setPrefs(p.id, 'claude', { autoResume: true })
    store.markInterrupted(p.id, 'claude', localId, null)
    const tasks = createTasksService(db)
    const t = tasks.create(null, p.id, 'faça', 'in_progress').id
    tasks.setToEngine(t, 'claude')
    const closeInterruptedRuns = vi.fn(() => 0)

    const { svc } = makeService({ closeInterruptedRuns })
    await svc.boot()

    expect(closeInterruptedRuns).toHaveBeenCalledTimes(1)
    await waitUntil(() => resumeEchoes().length === 1)
    expect(resumeEchoes()[0].localId).toBe(localId)
    expect(resumeEchoes()[0].event.message.content[0].text).toBe(RESUME_TEXT)
    const st = store.get(p.id, 'claude')
    expect(st.interruptedAt).toBeNull()
    expect(st.resumeCount).toBe(1)
    expect(stateBroadcasts).toContainEqual({ type: 'terminal_state', state: expect.objectContaining({ projectId: p.id, interruption: null }) })
    // A tarefa foi religada ao turno retomado e fecha com o result dele.
    await waitUntil(() => tasks.get(t)?.status === 'completed')
    expect(tasks.get(t)?.result).toBe(`eco: ${RESUME_TEXT}`)
  })

  it('boot segura quem não retoma e falha as tarefas dele', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.markInterrupted(p.id, 'claude', localId, null)
    const tasks = createTasksService(db)
    const t = tasks.create(null, p.id, 'faça', 'in_progress').id
    tasks.setToEngine(t, 'claude')

    const { svc } = makeService()
    await svc.boot()

    expect(store.get(p.id, 'claude')).toMatchObject({ holdReason: 'off', interruptedLocalId: localId })
    expect(tasks.get(t)).toMatchObject({ status: 'failed', result: RESTART_FAIL_TEXT })
    expect(stateBroadcasts).toContainEqual({
      type: 'terminal_state',
      state: expect.objectContaining({ projectId: p.id, interruption: expect.objectContaining({ reason: 'off' }) }),
    })
    // Sem iniciar, nada sobe.
    expect(activeOf(p)).toBeUndefined()
    expect(resumeEchoes()).toHaveLength(0)
  })

  it('hold com iniciar sobe a sessão parada, sem mensagem', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.setPrefs(p.id, 'claude', { autostart: true })
    store.markInterrupted(p.id, 'claude', localId, pergunta)

    const { svc } = makeService()
    await svc.boot()

    expect(store.get(p.id, 'claude').holdReason).toBe('question')
    expect(activeOf(p)?.localId).toBe(localId)
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    expect(resumeEchoes()).toHaveLength(0)
  })

  it('boot em lotes de 3', async () => {
    for (let i = 0; i < 7; i++) {
      const p = newProject(`P${i}`)
      store.setPrefs(p.id, 'claude', { autostart: true })
    }
    const { svc, sleeps } = makeService()
    await svc.boot()
    expect(sleeps).toEqual([5000, 5000])
    expect(mgr.list().filter((s) => s.status !== 'dead' && s.status !== 'stopped')).toHaveLength(7)
  })

  it('continuar e lote juntos mandam uma mensagem só', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.markInterrupted(p.id, 'claude', localId, null)
    const { svc } = makeService()

    expect(svc.resumeTerminal(p.id, 'claude', { auto: true })).toBe(true)
    expect(svc.resumeTerminal(p.id, 'claude')).toBe(false)
    await waitUntil(() => resumeEchoes().length >= 1)
    await new Promise((r) => setTimeout(r, 100))
    expect(resumeEchoes()).toHaveLength(1)
  })

  it('Continuar revive, manda a mensagem e zera o contador', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.markInterrupted(p.id, 'claude', localId, null)
    store.bumpResume(p.id, 'claude')
    store.bumpResume(p.id, 'claude')
    const { svc } = makeService()

    expect(svc.resumeTerminal(p.id, 'claude')).toBe(true)
    expect(activeOf(p)?.localId).toBe(localId)
    expect(store.get(p.id, 'claude').resumeCount).toBe(0)
    await waitUntil(() => resumeEchoes().length === 1)
  })

  it('reviver que falha vira hold failed e falha a tarefa', async () => {
    const ruim = newProject('Ruim')
    const bom = newProject('Bom')
    const localRuim = seedSession(ruim)
    const localBom = seedSession(bom)
    for (const [p, l] of [[ruim, localRuim], [bom, localBom]] as const) {
      store.setPrefs(p.id, 'claude', { autoResume: true })
      store.markInterrupted(p.id, 'claude', l, null)
    }
    brokenPaths.add(ruim.path)
    const tasks = createTasksService(db)
    const t = tasks.create(null, ruim.id, 'faça', 'in_progress').id
    tasks.setToEngine(t, 'claude')

    const { svc } = makeService()
    await svc.boot()

    const st = store.get(ruim.id, 'claude')
    expect(st.holdReason).toBe('failed')
    expect(st.interruptedAt).not.toBeNull()
    expect(tasks.get(t)).toMatchObject({ status: 'failed', result: RESTART_FAIL_TEXT })
    expect(stateBroadcasts).toContainEqual({
      type: 'terminal_state',
      state: expect.objectContaining({ projectId: ruim.id, interruption: expect.objectContaining({ reason: 'failed' }) }),
    })
    // O outro terminal segue normalmente.
    await waitUntil(() => resumeEchoes().some((e) => e.localId === localBom))
    expect(store.get(bom.id, 'claude').interruptedAt).toBeNull()
  })

  it('boot interrompido no meio deixa o resto marcado', async () => {
    const ps: Project[] = []
    for (let i = 0; i < 4; i++) {
      const p = newProject(`P${i}`)
      store.setPrefs(p.id, 'claude', { autoResume: true })
      store.markInterrupted(p.id, 'claude', seedSession(p), null)
      ps.push(p)
    }
    const { svc } = makeService({ sleep: () => Promise.reject(new Error('encerrando')) })
    await expect(svc.boot()).rejects.toThrow('encerrando')

    for (const p of ps.slice(0, 3)) expect(store.get(p.id, 'claude').interruptedAt).toBeNull()
    const resto = store.get(ps[3].id, 'claude')
    expect(resto.interruptedAt).not.toBeNull()
    expect(resto.holdReason).toBeNull()
    expect(resto.resumeCount).toBe(0)
  })

  it('autostart sem sessão anterior chama start', async () => {
    const p = newProject('P')
    store.setPrefs(p.id, 'claude', { autostart: true })
    const start = vi.spyOn(mgr, 'start')
    const { svc } = makeService()
    await svc.boot()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: p.id }), { engine: 'claude', continueLatest: true })
    expect(activeOf(p)).toBeDefined()
  })
})

describe('createRestartService: mensagens e interruptores', () => {
  it('onOperatorMessage limpa o aviso e zera o contador', () => {
    const p = newProject('P')
    store.markInterrupted(p.id, 'claude', 'x', null)
    store.setHold(p.id, 'claude', 'off')
    store.bumpResume(p.id, 'claude')
    const { svc } = makeService()

    svc.onOperatorMessage(p.id, 'claude')
    const st = store.get(p.id, 'claude')
    expect(st.interruptedAt).toBeNull()
    expect(st.holdReason).toBeNull()
    expect(st.resumeCount).toBe(0)
    expect(stateBroadcasts).toContainEqual({ type: 'terminal_state', state: expect.objectContaining({ projectId: p.id, interruption: null }) })
  })

  it('aviso dispensado fecha as tarefas presas ao turno que não volta', async () => {
    const p = newProject('P')
    store.markInterrupted(p.id, 'claude', 'x', null)
    const tasks = createTasksService(db)
    const t = tasks.create(null, p.id, 'faça', 'in_progress').id
    tasks.setToEngine(t, 'claude')
    const { svc } = makeService()
    svc.onOperatorMessage(p.id, 'claude')
    expect(tasks.get(t)).toMatchObject({ status: 'failed', result: RESTART_FAIL_TEXT })
  })

  it('mensagem do operador sem interrupção não faz broadcast', () => {
    const p = newProject('P')
    const { svc } = makeService()
    svc.onOperatorMessage(p.id, 'claude')
    expect(stateBroadcasts).toEqual([])
  })

  it('onTurnResult zera o contador', () => {
    const p = newProject('P')
    store.bumpResume(p.id, 'claude')
    store.bumpResume(p.id, 'claude')
    const { svc } = makeService()
    svc.onTurnResult(p.id, 'claude')
    expect(store.get(p.id, 'claude').resumeCount).toBe(0)
  })

  it('dismiss limpa o aviso e faz broadcast', () => {
    const p = newProject('P')
    store.markInterrupted(p.id, 'claude', 'x', null)
    const { svc } = makeService()
    svc.dismiss(p.id, 'claude')
    expect(store.get(p.id, 'claude').interruptedAt).toBeNull()
    expect(stateBroadcasts).toContainEqual({ type: 'terminal_state', state: expect.objectContaining({ projectId: p.id, interruption: null }) })
  })

  it('setPrefs grava, faz broadcast e devolve o DTO; list devolve DTOs', () => {
    const p = newProject('P')
    const { svc } = makeService()
    const dto = svc.setPrefs(p.id, 'claude', { autostart: true })
    expect(dto).toEqual({ projectId: p.id, engine: 'claude', autostart: true, autoResume: false, interruption: null })
    expect(stateBroadcasts).toContainEqual({ type: 'terminal_state', state: dto })
    expect(svc.list()).toEqual([dto])
  })
})
