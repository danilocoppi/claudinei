import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createTerminalStateStore } from '../src/restart/terminal-state.js'
import { createRestartService, type RestartService } from '../src/restart/boot.js'
import { createUsageLimitService, type UsageLimitService } from '../src/limit/usage-limit.js'
import { createTriageStore, type TriageStore } from '../src/triage/store.js'
import { createTriageWaker, type TriageWaker } from '../src/triage/wake.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
// Pastas em que o motor recusa subir, e em que a sessão sobe mas recusa mensagem.
let brokenStart: Set<string>
let brokenSend: Set<string>
const fakeFactory = (opts: SessionOptions) => {
  if (brokenStart.has(opts.projectPath)) throw new Error('motor recusou')
  const s = new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
  if (brokenSend.has(opts.projectPath)) s.send = () => { throw new Error('mensagem recusada') }
  return s
}

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

const daqui = (ms: number) => new Date(Date.now() + ms).toISOString()
const HORA = 3600_000
// Dois usuários com acesso ao mesmo projeto: um assenta, o outro adia.
const ANA = 1
const BETO = 2

let db: Db
let project: Project
let store: TriageStore
let triageMsgs: Array<{ type: string; userId: number; item: unknown }>
let onNeedsOperator: ReturnType<typeof vi.fn>
let mgr: ReturnType<typeof createSessionManager>

beforeEach(() => {
  brokenStart = new Set()
  brokenSend = new Set()
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tw-')) })
  store = createTriageStore(db)
  triageMsgs = []
  const waker = createTriageWaker({ store, broadcast: (m) => triageMsgs.push(m as never) })
  onNeedsOperator = vi.fn((projectId: number, reason: 'question' | 'failed' | 'dead') => waker.wake(projectId, reason))
  mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {}, onNeedsOperator })
})

afterEach(async () => { await mgr.stopAll() })

const startIdle = async () => {
  const { localId } = mgr.start(project, {})
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  return localId
}

/** Ana assenta e Beto adia o mesmo terminal. */
const settleAndSnooze = () => {
  store.update(ANA, project.id, { settled: true })
  store.update(BETO, project.id, { snoozedUntil: daqui(HORA) })
}

const expectAsleep = () => {
  expect(store.get(ANA, project.id).settled).toBe(true)
  expect(store.get(BETO, project.id).snoozedUntil).not.toBeNull()
  expect(triageMsgs).toEqual([])
}

const expectAwake = () => {
  expect(store.get(ANA, project.id)).toEqual({ projectId: project.id, pinned: false, settled: false, snoozedUntil: null, pinOrder: null })
  expect(store.get(BETO, project.id)).toEqual({ projectId: project.id, pinned: false, settled: false, snoozedUntil: null, pinOrder: null })
}

describe('o despertador acorda o assentado e o adiado', () => {
  it('pergunta aberta acorda o assentado e o adiado', async () => {
    const localId = await startIdle()
    settleAndSnooze()
    mgr.send(localId, 'faz-pergunta')
    await waitUntil(() => mgr.get(localId)?.pendingQuestion !== undefined)
    await waitUntil(() => onNeedsOperator.mock.calls.length > 0)
    expect(onNeedsOperator.mock.calls).toEqual([[project.id, 'question']])
    expectAwake()
  })

  it('a mesma pergunta acorda uma vez só, mesmo com outros status no caminho', async () => {
    const localId = await startIdle()
    mgr.send(localId, 'faz-pergunta')
    await waitUntil(() => mgr.get(localId)?.pendingQuestion !== undefined)
    // Respondida, o turno fecha com novos status; nenhum deles é pergunta nova.
    mgr.answerQuestion(localId, { 'Qual cor você prefere?': 'Verde', 'Quais frutas você gosta?': 'Banana' })
    await waitUntil(() => mgr.get(localId)?.status === 'needs_attention')
    expect(onNeedsOperator.mock.calls).toEqual([[project.id, 'question']])
    // Uma pergunta nova, depois, acorda de novo.
    mgr.send(localId, 'faz-pergunta')
    await waitUntil(() => onNeedsOperator.mock.calls.length === 2)
    expect(onNeedsOperator.mock.calls[1]).toEqual([project.id, 'question'])
  })

  it('turno com erro acorda', async () => {
    const localId = await startIdle()
    settleAndSnooze()
    mgr.send(localId, 'turno-com-erro')
    await waitUntil(() => onNeedsOperator.mock.calls.length > 0)
    expect(onNeedsOperator.mock.calls).toEqual([[project.id, 'failed']])
    expectAwake()
  })

  it('turno no limite sem o gancho do limite acorda como falha', async () => {
    const localId = await startIdle()
    settleAndSnooze()
    mgr.send(localId, 'limite')
    await waitUntil(() => onNeedsOperator.mock.calls.length > 0)
    expect(onNeedsOperator.mock.calls).toEqual([[project.id, 'failed']])
    expectAwake()
  })

  it('sessão morta acorda', async () => {
    const localId = await startIdle()
    settleAndSnooze()
    mgr.send(localId, 'crash')
    await waitUntil(() => mgr.get(localId)?.status === 'dead')
    await waitUntil(() => onNeedsOperator.mock.calls.length > 0)
    expect(onNeedsOperator.mock.calls).toEqual([[project.id, 'dead']])
    expectAwake()
  })

  it('o pin sobrevive ao despertar', async () => {
    const localId = await startIdle()
    // Adiar mantém o pin; acordar tira só o adiamento.
    store.update(ANA, project.id, { pinned: true })
    store.update(ANA, project.id, { snoozedUntil: daqui(HORA) })
    mgr.send(localId, 'crash')
    await waitUntil(() => onNeedsOperator.mock.calls.length > 0)
    expect(store.get(ANA, project.id)).toEqual({ projectId: project.id, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 })
    expect(triageMsgs).toEqual([{ type: 'triage', userId: ANA, item: { projectId: project.id, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 } }])
  })

  it('o broadcast vai uma vez por usuário afetado', async () => {
    const localId = await startIdle()
    settleAndSnooze()
    // Só fixado (nada a acordar) e adiamento já vencido: não recebem aviso.
    store.update(3, project.id, { pinned: true })
    db.prepare(`INSERT INTO user_triage (user_id, project_id, snoozed_until) VALUES (4, ?, ?)`).run(project.id, daqui(-1000))
    mgr.send(localId, 'crash')
    await waitUntil(() => onNeedsOperator.mock.calls.length > 0)
    const vazio = { projectId: project.id, pinned: false, settled: false, snoozedUntil: null, pinOrder: null }
    expect(triageMsgs).toEqual([
      { type: 'triage', userId: ANA, item: vazio },
      { type: 'triage', userId: BETO, item: vazio },
    ])
  })
})

describe('o que não acorda', () => {
  it('turno normal não acorda', async () => {
    const localId = await startIdle()
    settleAndSnooze()
    mgr.send(localId, 'oi')
    await waitUntil(() => mgr.get(localId)?.status === 'needs_attention')
    expect(onNeedsOperator).not.toHaveBeenCalled()
    expectAsleep()
  })

  it('working não acorda', async () => {
    const localId = await startIdle()
    settleAndSnooze()
    mgr.send(localId, 'demorada')
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    expect(onNeedsOperator).not.toHaveBeenCalled()
    expectAsleep()
  })

  it('interrupção pedida pelo operador não acorda', async () => {
    // O Claude fecha o turno interrompido com um result de erro
    // (error_during_execution): isso não é falha, foi o operador que parou.
    // `demorada-junto` faz esse result chegar ao manager (no mesmo pedaço do
    // stdout que a resposta do interrupt), em vez de ser descartado como póstumo.
    const eventos: Array<{ type: string; event?: { kind: string; subtype?: string } }> = []
    await mgr.stopAll()
    mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => eventos.push(m as never), onNeedsOperator })
    const localId = await startIdle()
    settleAndSnooze()
    mgr.send(localId, 'demorada-junto')
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    await mgr.interrupt(localId)
    await waitUntil(() => mgr.get(localId)?.status !== 'working')
    expect(eventos.some((m) => m.type === 'session_event' && m.event?.kind === 'result' && m.event.subtype === 'error_during_execution')).toBe(true)
    expect(onNeedsOperator).not.toHaveBeenCalled()
    expectAsleep()
    // Depois da interrupção, um erro de verdade volta a acordar.
    mgr.send(localId, 'turno-com-erro')
    await waitUntil(() => onNeedsOperator.mock.calls.length > 0)
    expect(onNeedsOperator.mock.calls).toEqual([[project.id, 'failed']])
  })

  it('morte no encerramento não acorda', async () => {
    // O stopAll pararia a sessão como `stopped`; aqui o processo morre de fato
    // (`dead`) com o encerramento já em curso, como no SIGTERM do serviço.
    const localId = await startIdle()
    settleAndSnooze()
    mgr.beginShutdown()
    mgr.send(localId, 'crash')
    await waitUntil(() => mgr.get(localId)?.status === 'dead')
    expect(onNeedsOperator).not.toHaveBeenCalled()
    expectAsleep()
  })

  it('um gancho que lança não derruba a sessão', async () => {
    const quebrado = createSessionManager({
      db, sessionFactory: fakeFactory, broadcast: () => {},
      onNeedsOperator: () => { throw new Error('banco fora') },
    })
    try {
      // Os três gatilhos lançam dentro dos handlers da sessão; um erro que
      // escapasse viraria uncaughtException e o vitest acusaria.
      const { localId } = quebrado.start(project, {})
      await waitUntil(() => quebrado.get(localId)?.status === 'idle')
      quebrado.send(localId, 'faz-pergunta')
      await waitUntil(() => quebrado.get(localId)?.pendingQuestion !== undefined)
      quebrado.answerQuestion(localId, { 'Qual cor você prefere?': 'Verde', 'Quais frutas você gosta?': 'Banana' })
      await waitUntil(() => quebrado.get(localId)?.status === 'needs_attention')
      quebrado.send(localId, 'turno-com-erro')
      await waitUntil(() => quebrado.get(localId)?.status === 'needs_attention')
      quebrado.send(localId, 'crash')
      await waitUntil(() => quebrado.get(localId)?.status === 'dead')
    } finally {
      await quebrado.stopAll()
    }
  })
})

describe('aviso de trabalho interrompido do reinício', () => {
  let terminalState: ReturnType<typeof createTerminalStateStore>
  let onHeld: ReturnType<typeof vi.fn>
  let svc: RestartService

  beforeEach(() => {
    terminalState = createTerminalStateStore(db)
    const waker = createTriageWaker({ store, broadcast: (m) => triageMsgs.push(m as never) })
    onHeld = vi.fn((projectId: number) => waker.wake(projectId, 'interrupted'))
    svc = createRestartService({
      db, manager: mgr, store: terminalState,
      orchestrator: () => undefined,
      broadcast: () => {},
      closeInterruptedRuns: () => 0,
      sleep: async () => {},
      log: () => {},
      onHeld,
    })
  })

  /** Sessão anterior persistida (parada), como a que sobra depois do reinício. */
  const seedSession = () => {
    const localId = randomUUID()
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES (?, ?, 'claude', 'stopped')`)
      .run(localId, project.id)
    return localId
  }

  it('aviso retido do reinício acorda; queued não', async () => {
    settleAndSnooze()

    // Na fila para retomar (sem motivo de espera): publica `queued`, não acorda.
    terminalState.markInterrupted(project.id, 'claude', 'x', null)
    expect(svc.setPrefs(project.id, 'claude', { autostart: false }).interruption?.reason).toBe('queued')
    expect(onHeld).not.toHaveBeenCalled()
    expectAsleep()

    // Retomar desligado: a subida segura o aviso (`off`) e isso acorda.
    await svc.boot()
    expect(svc.list()[0].interruption?.reason).toBe('off')
    expect(onHeld.mock.calls).toEqual([[project.id]])
    expectAwake()
  })

  it('aviso retido numa subida anterior não acorda de novo na subida seguinte', async () => {
    terminalState.markInterrupted(project.id, 'claude', 'x', null)
    await svc.boot()
    expect(onHeld.mock.calls).toEqual([[project.id]])

    // O operador assentou e adiou com o aviso ainda aberto; o serviço reinicia de novo.
    settleAndSnooze()
    await svc.boot()
    expect(svc.list()[0].interruption?.reason).toBe('off')
    expect(onHeld.mock.calls).toEqual([[project.id]])
    expectAsleep()
  })

  it('aviso retido com iniciar ligado que não sobe na subida seguinte não acorda de novo', async () => {
    terminalState.markInterrupted(project.id, 'claude', 'x', null)
    terminalState.setPrefs(project.id, 'claude', { autostart: true })
    terminalState.setHold(project.id, 'claude', 'off')
    brokenStart.add(project.path)
    settleAndSnooze()
    await svc.boot()
    expect(svc.list()[0].interruption?.reason).toBe('failed')
    expect(onHeld).not.toHaveBeenCalled()
    expectAsleep()
  })

  it('mexer nos interruptores de um terminal com aviso retido não acorda de novo', () => {
    // O aviso já foi retido (e acordou) numa subida; depois o operador assentou de novo.
    terminalState.markInterrupted(project.id, 'claude', 'x', null)
    terminalState.setHold(project.id, 'claude', 'off')
    settleAndSnooze()
    expect(svc.setPrefs(project.id, 'claude', { autostart: true }).interruption?.reason).toBe('off')
    expect(onHeld).not.toHaveBeenCalled()
    expectAsleep()
  })

  it('retomada da subida que não sobe acorda', async () => {
    const localId = seedSession()
    terminalState.setPrefs(project.id, 'claude', { autoResume: true })
    terminalState.markInterrupted(project.id, 'claude', localId, null)
    brokenStart.add(project.path)
    settleAndSnooze()
    await svc.boot()
    expect(svc.list()[0].interruption?.reason).toBe('failed')
    expect(onHeld.mock.calls).toEqual([[project.id]])
    expectAwake()
  })

  it('Continuar que não consegue mandar a mensagem acorda', () => {
    const localId = seedSession()
    terminalState.markInterrupted(project.id, 'claude', localId, null)
    brokenSend.add(project.path)
    settleAndSnooze()
    expect(() => svc.resumeTerminal(project.id, 'claude')).toThrow('mensagem recusada')
    expect(svc.list()[0].interruption?.reason).toBe('failed')
    expect(onHeld.mock.calls).toEqual([[project.id]])
    expectAwake()
  })
})

describe('aviso de limite de uso', () => {
  let terminalState: ReturnType<typeof createTerminalStateStore>
  let onLimitNotice: ReturnType<typeof vi.fn>
  let limit: UsageLimitService
  const daquiSegs = (ms: number) => Math.floor((Date.now() + ms) / 1000)

  beforeEach(() => {
    terminalState = createTerminalStateStore(db)
    const waker = createTriageWaker({ store, broadcast: (m) => triageMsgs.push(m as never) })
    onLimitNotice = vi.fn((projectId: number) => waker.wake(projectId, 'usage_limit'))
    const restart = createRestartService({
      db, manager: mgr, store: terminalState,
      orchestrator: () => undefined,
      broadcast: () => {},
      closeInterruptedRuns: () => 0,
      log: () => {},
    })
    limit = createUsageLimitService({
      manager: mgr, store: terminalState, restart,
      setTimer: () => ({ clear() {} }),
      log: () => {},
      onLimitNotice,
    })
  })
  afterEach(() => limit.dispose())

  it('limite de uso acorda o assentado e o adiado quando o aviso nasce', () => {
    settleAndSnooze()
    limit.onUsageLimit(project.id, 'claude', { localId: 'x', resetsAt: daquiSegs(HORA), origin: 'operator' })
    expect(onLimitNotice.mock.calls).toEqual([[project.id]])
    expectAwake()
  })

  it('limite armado sozinho também acorda: o aviso aparece, em destaque', () => {
    terminalState.setPrefs(project.id, 'claude', { autoResumeLimit: true })
    settleAndSnooze()
    limit.onUsageLimit(project.id, 'claude', { localId: 'x', resetsAt: daquiSegs(HORA), origin: 'operator' })
    expect(terminalState.get(project.id, 'claude').limitAction).toBe('armed')
    expect(onLimitNotice.mock.calls).toEqual([[project.id]])
    expectAwake()
  })

  it('limite que bate de novo com o aviso ainda aberto não acorda de novo', () => {
    limit.onUsageLimit(project.id, 'claude', { localId: 'x', resetsAt: daquiSegs(HORA), origin: 'operator' })
    expect(onLimitNotice).toHaveBeenCalledTimes(1)
    // O operador assentou e adiou com o aviso aberto; outro turno bate no limite.
    settleAndSnooze()
    limit.onUsageLimit(project.id, 'claude', { localId: 'x', resetsAt: daquiSegs(2 * HORA), origin: 'schedule' })
    expect(onLimitNotice).toHaveBeenCalledTimes(1)
    expectAsleep()
  })

  it('limite pelo manager acorda uma vez (usage_limit); de novo com o aviso aberto, não', async () => {
    // Manager com os dois ganchos, como no index.ts: o turno do limite chega com
    // is_error, e só o caminho do limite pode acordar por ele.
    const waker = createTriageWaker({ store, broadcast: (m) => triageMsgs.push(m as never) })
    const wakes: Array<[number, string]> = []
    let lim: UsageLimitService | undefined
    let results = 0
    const mgr2 = createSessionManager({
      db, sessionFactory: fakeFactory, broadcast: () => {},
      onNeedsOperator: (projectId, reason) => { wakes.push([projectId, reason]); waker.wake(projectId, reason) },
      onUsageLimit: (projectId, engine, p) => lim?.onUsageLimit(projectId, engine, p),
      onTurnResult: (projectId, engine, info) => { results++; lim?.onTurnResult(projectId, engine, info) },
    })
    const restart2 = createRestartService({
      db, manager: mgr2, store: terminalState,
      orchestrator: () => undefined, broadcast: () => {}, closeInterruptedRuns: () => 0, log: () => {},
    })
    lim = createUsageLimitService({
      manager: mgr2, store: terminalState, restart: restart2,
      setTimer: () => ({ clear() {} }), log: () => {},
      onLimitNotice: (projectId) => { wakes.push([projectId, 'usage_limit']); waker.wake(projectId, 'usage_limit') },
    })
    try {
      const { localId } = mgr2.start(project, {})
      await waitUntil(() => mgr2.get(localId)?.status === 'idle')
      settleAndSnooze()
      mgr2.send(localId, 'limite')
      await waitUntil(() => results === 1)
      expect(terminalState.get(project.id, 'claude').limitHitAt).not.toBeNull()
      expect(wakes).toEqual([[project.id, 'usage_limit']])
      expectAwake()

      // Com o aviso aberto, o operador assenta e adia de novo; outro turno bate no limite.
      triageMsgs.length = 0
      settleAndSnooze()
      mgr2.send(localId, 'limite')
      await waitUntil(() => results === 2)
      expect(wakes).toEqual([[project.id, 'usage_limit']])
      expectAsleep()
    } finally {
      lim.dispose()
      await mgr2.stopAll()
    }
  })

  it('um despertador que lança não impede o registro do limite', () => {
    onLimitNotice.mockImplementation(() => { throw new Error('banco travado') })
    limit.onUsageLimit(project.id, 'claude', { localId: 'x', resetsAt: daquiSegs(HORA), origin: 'operator' })
    expect(terminalState.get(project.id, 'claude').limitHitAt).not.toBeNull()
  })
})

describe('amarração no app', () => {
  it('o buildApp entrega o despertador e liga o aviso retido a ele', async () => {
    const appMsgs: Array<{ type: string; userId?: number }> = []
    let waker: TriageWaker | undefined
    let restart: RestartService | undefined
    const app = await buildApp({
      config: loadConfig({}), db, manager: mgr,
      wsHub: { broadcast: (m: object) => appMsgs.push(m as never), register: () => {} } as never,
      onTriageWakerReady: (w) => { waker = w },
      onRestartReady: (r) => { restart = r },
    })
    try {
      expect(waker).toBeDefined()
      settleAndSnooze()
      createTerminalStateStore(db).markInterrupted(project.id, 'claude', 'x', null)
      await restart!.boot()
      expect(appMsgs.filter((m) => m.type === 'triage').map((m) => m.userId)).toEqual([ANA, BETO])
      expectAwake()
    } finally {
      await app.close()
    }
  })

  it('o buildApp liga o aviso de limite de uso ao despertador', async () => {
    const appMsgs: Array<{ type: string; userId?: number }> = []
    let limit: UsageLimitService | undefined
    const app = await buildApp({
      config: loadConfig({}), db, manager: mgr,
      wsHub: { broadcast: (m: object) => appMsgs.push(m as never), register: () => {} } as never,
      onLimitReady: (l) => { limit = l },
    })
    try {
      settleAndSnooze()
      limit!.onUsageLimit(project.id, 'claude', { localId: 'x', resetsAt: Math.floor(Date.now() / 1000) + 3600, origin: 'operator' })
      expect(appMsgs.filter((m) => m.type === 'triage').map((m) => m.userId)).toEqual([ANA, BETO])
      expectAwake()
    } finally {
      await app.close()
    }
  })
})
