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
  planBoot, createRestartService, startAfterListen, RESUME_PREFIX, RESUME_TEXT, MAX_AUTO_RESUMES,
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
  autoResumeLimit: false,
  limitHitAt: null, limitResetsAt: null, limitAction: 'none', limitOrigin: null, limitTries: 0,
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

  // Marca nova sempre chega sem motivo: um motivo gravado é de uma subida anterior.
  it('hold off de uma subida anterior segue off mesmo com retomar ligado depois', () => {
    expect(planBoot([interrupted({ autoResume: true, holdReason: 'off' })], latest())).toEqual([
      { kind: 'hold', projectId: 1, engine: 'claude', reason: 'off', alsoIdle: false, localId: 'loc-int' },
    ])
  })

  it('hold failed de uma subida anterior segue failed, sem nova tentativa; alsoIdle segue o iniciar', () => {
    expect(planBoot([interrupted({ autoResume: true, autostart: true, holdReason: 'failed' })], latest())).toEqual([
      { kind: 'hold', projectId: 1, engine: 'claude', reason: 'failed', alsoIdle: true, localId: 'loc-int' },
    ])
  })

  // Limite de uso ativo: a retomada fica com o serviço do limite, e o boot absorve a marca.
  const AGORA = Date.UTC(2026, 10, 20, 12, 0, 0)   // ms
  const limitado = (resetsAt: number | null) =>
    ({ limitHitAt: '2026-11-20 11:00:00', limitResetsAt: resetsAt, limitOrigin: 'operator' as const })

  it('planBoot pula interrupção com limite futuro', () => {
    const futuro = AGORA / 1000 + 3600   // epoch segundos
    expect(planBoot([interrupted({ autoResume: true, ...limitado(futuro) })], latest(), AGORA)).toEqual([])
    // Nem hold, nem subida parada com o iniciar ligado, nem com uma pergunta perdida.
    expect(planBoot([interrupted({ autostart: true, ...limitado(futuro) })], latest(), AGORA)).toEqual([])
    expect(planBoot([interrupted({ lostQuestion: pergunta, ...limitado(futuro) })], latest(), AGORA)).toEqual([])
    // Reabertura desconhecida conta como limite ativo.
    expect(planBoot([interrupted({ autoResume: true, ...limitado(null) })], latest(), AGORA)).toEqual([])
    // Sem interrupção, o limite não impede o iniciar.
    expect(planBoot([row({ autostart: true, ...limitado(futuro) })], latest(), AGORA)).toEqual([
      { kind: 'idle', projectId: 1, engine: 'claude', localId: 'loc-ult' },
    ])
  })

  it('planBoot retoma normalmente se o limite já reabriu', () => {
    const passado = AGORA / 1000 - 60
    expect(planBoot([interrupted({ autoResume: true, ...limitado(passado) })], latest(), AGORA)).toEqual([
      { kind: 'resume', projectId: 1, engine: 'claude', localId: 'loc-int' },
    ])
    // Exatamente na hora da reabertura já não é ativo.
    expect(planBoot([interrupted({ autoResume: true, ...limitado(AGORA / 1000) })], latest(), AGORA)[0].kind).toBe('resume')
    expect(planBoot([interrupted({ ...limitado(passado) })], latest(), AGORA)).toEqual([
      { kind: 'hold', projectId: 1, engine: 'claude', reason: 'off', alsoIdle: false, localId: 'loc-int' },
    ])
  })

  it('planBoot: reabertura desconhecida só conta como ativa até 5 h depois do limite', () => {
    // limitHitAt vem do datetime('now') do SQLite: 'YYYY-MM-DD HH:MM:SS', em UTC. AGORA = 12:00 UTC.
    const semHora = (hitAt: string) => ({ ...limitado(null), limitHitAt: hitAt })
    // 4 h 59 min 59 s depois: ainda ativo, o reinício não retoma.
    expect(planBoot([interrupted({ autoResume: true, ...semHora('2026-11-20 07:00:01') })], latest(), AGORA)).toEqual([])
    // Exatamente 5 h depois, e além: já não é ativo, o reinício retoma como sempre.
    expect(planBoot([interrupted({ autoResume: true, ...semHora('2026-11-20 07:00:00') })], latest(), AGORA)).toEqual([
      { kind: 'resume', projectId: 1, engine: 'claude', localId: 'loc-int' },
    ])
    expect(planBoot([interrupted({ autoResume: true, ...semHora('2026-11-19 12:00:00') })], latest(), AGORA)[0].kind).toBe('resume')
    // Armado segue ativo sempre (R8), mesmo sem hora e com o limite antigo.
    expect(planBoot([interrupted({ autoResume: true, ...semHora('2026-11-19 12:00:00'), limitAction: 'armed' })], latest(), AGORA)).toEqual([])
    // Data que não se lê não segura o terminal para sempre.
    expect(planBoot([interrupted({ autoResume: true, ...semHora('lixo') })], latest(), AGORA)[0].kind).toBe('resume')
  })

  it('planBoot pula interrupção com retomada armada já vencida', () => {
    const passado = AGORA / 1000 - 3600
    const armado = { ...limitado(passado), limitAction: 'armed' as const }
    // A mensagem é do serviço do limite: o reinício não retoma, não segura nem sobe.
    expect(planBoot([interrupted({ autoResume: true, ...armado })], latest(), AGORA)).toEqual([])
    expect(planBoot([interrupted({ autostart: true, ...armado })], latest(), AGORA)).toEqual([])
    // Adiado com a reabertura passada segue o caminho de sempre.
    expect(planBoot([interrupted({ autoResume: true, ...limitado(passado), limitAction: 'snoozed' })], latest(), AGORA)).toEqual([
      { kind: 'resume', projectId: 1, engine: 'claude', localId: 'loc-int' },
    ])
  })
})

// ---------------------------------------------------------------- executor

let db: Db
let mgr: ReturnType<typeof createSessionManager>
let store: TerminalStateStore
let mgrBroadcasts: any[]
let appBroadcasts: any[]
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
  appBroadcasts = []
  stateBroadcasts = []
  brokenPaths = new Set()
  mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m) })
  store = createTerminalStateStore(db)
  await buildApp({
    config: loadConfig({}), db, manager: mgr,
    wsHub: { broadcast: (m: object) => appBroadcasts.push(m), register: () => {} } as any,
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
    closeInterruptedRuns: over.closeInterruptedRuns ?? (() => 0),
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

  /** Terminal segurado (retomar desligado) com iniciar: de pé e parado depois da subida. */
  const heldAndLive = async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.setPrefs(p.id, 'claude', { autostart: true })
    store.markInterrupted(p.id, 'claude', localId, null)
    const { svc } = makeService()
    await svc.boot()
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    expect(store.get(p.id, 'claude').holdReason).toBe('off')
    return { p, localId, svc }
  }

  /** Tarefa encaminhada DEPOIS da subida, entregue pelo caminho normal (drain). */
  const dispatchAfterBoot = (p: Project) => {
    const tasks = createTasksService(db)
    const { id } = tasks.create(null, p.id, 'tarefa nova', 'queued')
    orch.drain(p.id)
    expect(tasks.get(id)?.status).toBe('in_progress')
    return { tasks, id }
  }
  const taskUpdates = (id: number, status: string) =>
    appBroadcasts.filter((b) => b.type === 'task_update' && b.task.id === id && b.task.status === status)

  for (const via of ['dismiss', 'onOperatorMessage'] as const) {
    it(`tarefa entregue depois da subida sobrevive ao ${via}`, async () => {
      const { p, svc } = await heldAndLive()
      const { tasks, id } = dispatchAfterBoot(p)

      svc[via](p.id, 'claude')
      expect(store.get(p.id, 'claude').interruptedAt).toBeNull()
      expect(tasks.get(id)?.status).toBe('in_progress')

      await waitUntil(() => tasks.get(id)?.status === 'completed')
      expect(tasks.get(id)?.result).toBe('eco: [Task from unknown]: tarefa nova')
      expect(taskUpdates(id, 'failed')).toHaveLength(0)
    })
  }

  it('Continuar não põe um segundo ouvinte na tarefa entregue depois da subida', async () => {
    const { p, localId, svc } = await heldAndLive()
    const { tasks, id } = dispatchAfterBoot(p)

    // No meio do turno da tarefa, o Continuar recusa: a retomada cairia no turno dela.
    expect(mgr.get(localId)?.status).toBe('working')
    expect(() => svc.resumeTerminal(p.id, 'claude')).toThrow(expect.objectContaining({ code: 'session_busy' }))
    await waitUntil(() => tasks.get(id)?.status === 'completed')
    expect(tasks.get(id)?.result).toBe('eco: [Task from unknown]: tarefa nova')
    // Turno da tarefa terminado: o Continuar agora retoma.
    await waitUntil(() => mgr.get(localId)?.status !== 'working')
    expect(svc.resumeTerminal(p.id, 'claude')).toBe(true)
    // O turno da mensagem de retomada também fecha; um ouvinte a mais fecharia de novo.
    await waitUntil(() => mgrBroadcasts.some((b) => b.type === 'session_event' && b.localId === localId &&
      b.event?.kind === 'result' && JSON.stringify(b.event).includes('eco: [Claudinei: resume')))
    await new Promise((r) => setTimeout(r, 100))
    expect(taskUpdates(id, 'completed')).toHaveLength(1)
    expect(tasks.get(id)?.result).toBe('eco: [Task from unknown]: tarefa nova')
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

  it('encerramento iniciado durante a espera para os lotes seguintes', async () => {
    const ps: Project[] = []
    for (let i = 0; i < 4; i++) {
      const p = newProject(`P${i}`)
      store.setPrefs(p.id, 'claude', { autoResume: true })
      store.markInterrupted(p.id, 'claude', seedSession(p), null)
      ps.push(p)
    }
    // A espera padrão resolve normalmente; o que segura o resto é o modo de encerramento.
    const { svc } = makeService({ sleep: async () => { mgr.beginShutdown() } })
    await svc.boot()

    for (const p of ps.slice(0, 3)) expect(store.get(p.id, 'claude').interruptedAt).toBeNull()
    const resto = store.get(ps[3].id, 'claude')
    expect(resto.interruptedAt).not.toBeNull()
    expect(resto.holdReason).toBeNull()
    expect(activeOf(ps[3])).toBeUndefined()
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

describe('createRestartService: limite de uso', () => {
  const emUmaHora = () => Math.floor(Date.now() / 1000) + 3600   // epoch segundos

  it('boot absorve a marca do terminal limitado e fecha as tarefas anotadas', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.setPrefs(p.id, 'claude', { autoResume: true, autostart: true })
    store.markInterrupted(p.id, 'claude', localId, null)
    store.recordUsageLimit(p.id, 'claude', { resetsAt: emUmaHora(), origin: 'operator' })
    const tasks = createTasksService(db)
    const t = tasks.create(null, p.id, 'faça', 'in_progress').id
    tasks.setToEngine(t, 'claude')
    const sent = vi.spyOn(mgr, 'sendAsClaudinei')

    const { svc } = makeService()
    await svc.boot()

    const st = store.get(p.id, 'claude')
    expect(st).toMatchObject({ interruptedAt: null, interruptedLocalId: null, holdReason: null })
    // O limite fica: a retomada é do serviço do limite.
    expect(st.limitHitAt).not.toBeNull()
    expect(tasks.get(t)).toMatchObject({ status: 'failed', result: RESTART_FAIL_TEXT })
    expect(stateBroadcasts).toContainEqual({
      type: 'terminal_state',
      state: expect.objectContaining({ projectId: p.id, interruption: null, usageLimit: expect.objectContaining({ action: 'none' }) }),
    })
    // Nada sobe nem sai: nem retomada, nem subida parada.
    expect(sent).not.toHaveBeenCalled()
    expect(activeOf(p)).toBeUndefined()
    expect(resumeEchoes()).toHaveLength(0)
  })

  it('boot com o limite já reaberto retoma como antes', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.setPrefs(p.id, 'claude', { autoResume: true })
    store.markInterrupted(p.id, 'claude', localId, null)
    store.recordUsageLimit(p.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) - 60, origin: 'operator' })

    const { svc } = makeService()
    await svc.boot()

    await waitUntil(() => resumeEchoes().length === 1)
    expect(store.get(p.id, 'claude').interruptedAt).toBeNull()
  })

  it('absorbInterruption tira a marca, fecha as tarefas anotadas e publica', async () => {
    // Retomada no segundo lote: a tarefa dele fica anotada enquanto o primeiro sobe.
    const [p1, p2] = [newProject('P1'), newProject('P2')]
    const ids = [p1, p2].map((p) => {
      const localId = seedSession(p)
      store.setPrefs(p.id, 'claude', { autoResume: true })
      store.markInterrupted(p.id, 'claude', localId, null)
      return localId
    })
    const tasks = createTasksService(db)
    const t = tasks.create(null, p2.id, 'faça', 'in_progress').id
    tasks.setToEngine(t, 'claude')
    let release!: () => void
    const svc = createRestartService({
      db, manager: mgr, store, orchestrator: () => orch, broadcast: (m) => stateBroadcasts.push(m),
      closeInterruptedRuns: () => 0,
      batchSize: 1, sleep: () => new Promise<void>((r) => { release = r }), log: () => {},
    })
    const booting = svc.boot()
    await waitUntil(() => release !== undefined)
    expect(tasks.get(t)?.status).toBe('in_progress')

    svc.absorbInterruption(p2.id, 'claude')
    expect(store.get(p2.id, 'claude').interruptedAt).toBeNull()
    expect(tasks.get(t)).toMatchObject({ status: 'failed', result: RESTART_FAIL_TEXT })
    expect(stateBroadcasts).toContainEqual({ type: 'terminal_state', state: expect.objectContaining({ projectId: p2.id, interruption: null }) })

    release()
    await booting
    // O lote encontra a marca já absorvida: só o primeiro terminal retoma.
    await waitUntil(() => resumeEchoes().length === 1)
    expect(resumeEchoes().map((b) => b.localId)).toEqual([ids[0]])
    expect(activeOf(p2)).toBeUndefined()
  })

  it('absorbInterruption sem marca não publica', () => {
    const p = newProject('P')
    const { svc } = makeService()
    svc.absorbInterruption(p.id, 'claude')
    expect(stateBroadcasts).toEqual([])
  })

  it('absorbInterruption não faz nada durante o encerramento', () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.markInterrupted(p.id, 'claude', localId, null)
    mgr.beginShutdown()
    const { svc } = makeService()
    svc.absorbInterruption(p.id, 'claude')
    expect(store.get(p.id, 'claude')).toMatchObject({ interruptedLocalId: localId })
    expect(stateBroadcasts).toEqual([])
  })

  it('bringUp e publish ficam expostos ao serviço do limite', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    const { svc } = makeService()
    expect(svc.bringUp(p.id, 'claude', localId)).toBe(localId)
    expect(activeOf(p)?.localId).toBe(localId)
    const dto = svc.publish(p.id, 'claude')
    expect(dto).toMatchObject({ projectId: p.id, engine: 'claude', interruption: null })
    expect(stateBroadcasts).toEqual([{ type: 'terminal_state', state: dto }])
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

  it('aviso dispensado entre os lotes fecha a tarefa do turno que não volta', async () => {
    // Dois terminais que retomam, um por lote: o segundo espera o sleep.
    const [p1, p2] = [newProject('P1'), newProject('P2')]
    for (const p of [p1, p2]) {
      store.setPrefs(p.id, 'claude', { autoResume: true })
      store.markInterrupted(p.id, 'claude', seedSession(p), null)
    }
    const tasks = createTasksService(db)
    const t = tasks.create(null, p2.id, 'faça', 'in_progress').id
    tasks.setToEngine(t, 'claude')
    let release!: () => void
    const svc = createRestartService({
      db, manager: mgr, store, orchestrator: () => orch, broadcast: (m) => stateBroadcasts.push(m),
      closeInterruptedRuns: () => 0,
      batchSize: 1, sleep: () => new Promise<void>((r) => { release = r }), log: () => {},
    })
    const booting = svc.boot()
    await waitUntil(() => release !== undefined)
    expect(tasks.get(t)?.status).toBe('in_progress')

    svc.onOperatorMessage(p2.id, 'claude')
    expect(tasks.get(t)).toMatchObject({ status: 'failed', result: RESTART_FAIL_TEXT })

    release()
    await booting
    // O lote encontra a marca já tirada: não retoma nem religa.
    expect(svc.resumeTerminal(p2.id, 'claude')).toBe(false)
    expect(tasks.get(t)?.status).toBe('failed')
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

  it('subida não retoma uma marca segurada numa subida anterior', async () => {
    const p = newProject('P')
    const localId = seedSession(p)
    store.markInterrupted(p.id, 'claude', localId, null)
    store.setHold(p.id, 'claude', 'off')
    store.setPrefs(p.id, 'claude', { autoResume: true })
    const { svc } = makeService()
    await svc.boot()
    expect(store.get(p.id, 'claude')).toMatchObject({ holdReason: 'off', interruptedLocalId: localId })
    expect(activeOf(p)).toBeUndefined()
    expect(resumeEchoes()).toHaveLength(0)
  })

  it('Continuar com a sessão no meio de um turno não manda nada e a marca fica', async () => {
    const p = newProject('P')
    const info = mgr.start(p, { engine: 'claude' })
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'demorada')
    await waitUntil(() => mgr.get(info.localId)?.status === 'working')
    store.markInterrupted(p.id, 'claude', info.localId, null)
    store.setHold(p.id, 'claude', 'off')
    const sent = vi.spyOn(mgr, 'sendAsClaudinei')
    const { svc } = makeService()

    expect(() => svc.resumeTerminal(p.id, 'claude')).toThrow(expect.objectContaining({ code: 'session_busy' }))
    expect(sent).not.toHaveBeenCalled()
    expect(store.get(p.id, 'claude')).toMatchObject({ holdReason: 'off', interruptedLocalId: info.localId })
  })

  describe('durante o encerramento', () => {
    /** Marca gravada pelo captureShutdown, com o serviço já encerrando. */
    const marcadoEncerrando = () => {
      const p = newProject('P')
      const localId = seedSession(p)
      store.markInterrupted(p.id, 'claude', localId, null)
      store.bumpResume(p.id, 'claude')
      mgr.beginShutdown()
      return { p, localId }
    }

    it('mensagem do operador não apaga a marca', () => {
      const { p, localId } = marcadoEncerrando()
      const { svc } = makeService()
      svc.onOperatorMessage(p.id, 'claude')
      expect(store.get(p.id, 'claude')).toMatchObject({ interruptedLocalId: localId, resumeCount: 1 })
      expect(stateBroadcasts).toEqual([])
    })

    it('fechar o aviso não apaga a marca', () => {
      const { p, localId } = marcadoEncerrando()
      const { svc } = makeService()
      svc.dismiss(p.id, 'claude')
      expect(store.get(p.id, 'claude')).toMatchObject({ interruptedLocalId: localId, resumeCount: 1 })
      expect(stateBroadcasts).toEqual([])
    })

    it('Continuar não revive nem apaga a marca', () => {
      const { p, localId } = marcadoEncerrando()
      const { svc } = makeService()
      expect(svc.resumeTerminal(p.id, 'claude')).toBe(false)
      expect(activeOf(p)).toBeUndefined()
      expect(store.get(p.id, 'claude')).toMatchObject({ interruptedLocalId: localId, resumeCount: 1 })
      expect(svc.isShuttingDown()).toBe(true)
    })

    it('turno que termina no encerramento tira a marca: não há o que retomar', () => {
      const { p } = marcadoEncerrando()
      const { svc } = makeService()
      svc.onTurnResult(p.id, 'claude')
      expect(store.get(p.id, 'claude')).toMatchObject({ interruptedAt: null, resumeCount: 0 })
      expect(stateBroadcasts).toContainEqual({ type: 'terminal_state', state: expect.objectContaining({ projectId: p.id, interruption: null }) })
    })
  })

  it('fora do encerramento, o fim de um turno não mexe na marca', () => {
    const p = newProject('P')
    store.markInterrupted(p.id, 'claude', 'x', null)
    store.setHold(p.id, 'claude', 'off')
    const { svc } = makeService()
    svc.onTurnResult(p.id, 'claude')
    expect(store.get(p.id, 'claude')).toMatchObject({ interruptedLocalId: 'x', holdReason: 'off' })
  })

  it('setPrefs grava, faz broadcast e devolve o DTO; list devolve DTOs', () => {
    const p = newProject('P')
    const { svc } = makeService()
    const dto = svc.setPrefs(p.id, 'claude', { autostart: true })
    expect(dto).toEqual({
      projectId: p.id, engine: 'claude', autostart: true, autoResume: false, interruption: null,
      autoResumeLimit: false, usageLimit: null,
    })
    expect(stateBroadcasts).toContainEqual({ type: 'terminal_state', state: dto })
    expect(svc.list()).toEqual([dto])
  })
})

describe('startAfterListen', () => {
  it('agendador liga só depois do boot', async () => {
    const ordem: string[] = []
    let terminar!: () => void
    const restart = { boot: () => new Promise<void>((r) => { terminar = () => { ordem.push('boot'); r() } }) }
    const scheduler = { start: vi.fn(() => { ordem.push('scheduler') }) }

    const pronto = startAfterListen({ restart, scheduler })
    await new Promise((r) => setTimeout(r, 20))
    expect(scheduler.start).not.toHaveBeenCalled()
    terminar()
    await pronto
    expect(ordem).toEqual(['boot', 'scheduler'])
  })

  it('boot que falha é registrado e o agendador liga mesmo assim', async () => {
    const logs: string[] = []
    const scheduler = { start: vi.fn() }
    await expect(startAfterListen({
      restart: { boot: () => Promise.reject(new Error('banco travado')) },
      scheduler,
      log: (m) => logs.push(m),
    })).resolves.toBeUndefined()
    expect(scheduler.start).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('banco travado')
  })

  it('sem agendador nem serviço não quebra', async () => {
    await expect(startAfterListen({ restart: undefined, scheduler: undefined })).resolves.toBeUndefined()
  })

  it('encerramento começado durante o boot não liga o agendador', async () => {
    const scheduler = { start: vi.fn() }
    let encerrando = false
    await startAfterListen({
      restart: { boot: async () => { encerrando = true } },
      scheduler,
      isShuttingDown: () => encerrando,
    })
    expect(scheduler.start).not.toHaveBeenCalled()
  })
})
