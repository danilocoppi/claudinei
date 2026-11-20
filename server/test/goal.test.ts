import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createTerminalStateStore, toDto, type TerminalStateDto, type TerminalStateStore } from '../src/restart/terminal-state.js'
import { createRestartService, type RestartService } from '../src/restart/boot.js'
import { registerOrchestratorRoutes, type OrchestratorHooks } from '../src/routes/orchestrator.js'
import { registerHermesRoutes } from '../src/routes/hermes.js'
import { createNextSend, holdsForNotice, type NextSend } from '../src/queue/next-send.js'
import { createOperatorQueueService, createOperatorQueueStore, type OperatorQueueService } from '../src/queue/operator-queue.js'
import { createTasksService } from '../src/tasks.js'
import { createTaskWake } from '../src/delegate/task-wake.js'
import { TASK_RESULT_PREFIX } from '../src/delegate/texts.js'
import { createUsageLimitService, type UsageLimitService } from '../src/limit/usage-limit.js'
import { LIMIT_RESUME_PREFIX } from '../src/limit/texts.js'
import { createGoalService } from '../src/goal/goal.js'
import { GOAL_PREFIX, GOAL_START_PREFIX, GOAL_MAX_TURNS, goalContinueText, goalStartText } from '../src/goal/texts.js'
import { UserError } from '../src/user-error.js'
import '../src/engine/index.js'

/**
 * Goals (lugar 6 do árbitro): `/goal <critério>` faz o terminal seguir turno
 * após turno até o agente chamar `goal_done`, com teto de 20 turnos e pausas.
 * Monta o mesmo que o app.ts e o index.ts vão amarrar (Task 5): o CLI falso,
 * o orchestrator e as rotas do Hermes num Fastify próprio, o reinício, o
 * limite, a fila do operador (lugar 3), o aviso de tarefa (lugar 4), as
 * tarefas de outros agentes (lugar 5, o drain) e um agendamento de mentira
 * (também no lugar 5), num árbitro real, com o cutucão quando o estado do
 * terminal é publicado e os ganchos do manager como o index.ts os liga.
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = async (cond: () => boolean, ms = 8000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 15))
  }
}
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms))

const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

let db: Db
let mgr: SessionManager
let store: TerminalStateStore
let restart: RestartService
let nextSend: NextSend
let orch: OrchestratorHooks
let app: FastifyInstance
let wake: ReturnType<typeof createTaskWake>
let goal: ReturnType<typeof createGoalService>
let queue: OperatorQueueService
let limit: UsageLimitService
let origem: Project
let destino: Project
/** O que o manager publica (eventos das sessões). */
let mgrEvents: any[]
let states: TerminalStateDto[]
let logs: string[]
/** Agendamento de mentira no lugar 5: o próximo texto a mandar como o agendador manda. */
let scheduleNext: string | null
/** Limiar do auto-compact (0 = desligado). */
let compactPct: number
/** O motor aceita mensagem no meio do turno (false = como o Kimi e o OpenCode). */
let midTurn: boolean
let clock: number
let timers: { fn: () => unknown; ms: number; cleared: boolean }[]

const tasks = () => createTasksService(db)

/** O que a sessão recebeu, na ordem (todo envio do teste ecoa como `user`). */
const received = (localId: string): string[] => mgrEvents
  .filter((m) => m.type === 'session_event' && m.localId === localId && m.event?.kind === 'user')
  .map((m) => m.event.message?.content?.[0]?.text ?? '')
const continues = (localId: string) => received(localId).filter((t) => t.startsWith(`${GOAL_PREFIX}:`))
const resultsOf = (localId: string): string[] => mgrEvents
  .filter((m) => m.type === 'session_event' && m.localId === localId && m.event?.kind === 'result')
  .map((m) => String(m.event.resultText ?? ''))
const isFree = (localId: string) => ['idle', 'needs_attention'].includes(mgr.get(localId)?.status ?? '')
const goalOf = () => store.get(origem.id, 'claude')
const lastState = () => [...states].reverse().find((s) => s.projectId === origem.id && s.engine === 'claude')

beforeEach(() => {
  db = openDb(':memory:')
  mgrEvents = []
  states = []
  logs = []
  scheduleNext = null
  compactPct = 0
  midTurn = true
  clock = Date.now()
  timers = []
  const projects = createProjectsService(db)
  origem = projects.create({ name: 'Origem', path: mkdtempSync(join(tmpdir(), 'goal-o-')) })
  destino = projects.create({ name: 'Destino', path: mkdtempSync(join(tmpdir(), 'goal-d-')) })
  store = createTerminalStateStore(db)
  build()
})

afterEach(async () => {
  delete process.env.CLAUDE_FAKE_CTX
  mgr.beginShutdown()
  limit.dispose()
  await mgr.stopAll()
  await app.close()
})

function build(): void {
  let arbiter: NextSend | undefined
  mgr = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: (m) => mgrEvents.push(m),
    autoCompactPct: () => compactPct,
    onSessionAvailable: (projectId, ctx) => { if (ctx) arbiter?.onSessionAvailable({ projectId, ...ctx }) },
    // Os ganchos como o index.ts os amarra (Task 5).
    onTurnResult: (projectId, engine, info) => {
      restart?.onTurnResult(projectId, engine)
      limit?.onTurnResult(projectId, engine, info)
      queue?.onTurnResult(projectId, engine, info)
      wake?.onTurnResult(projectId, engine, info)
      goal?.onTurnResult(projectId, engine, info)
    },
    onOperatorMessage: (projectId, engine, info) => {
      restart?.onOperatorMessage(projectId, engine)
      limit?.onOperatorMessage(projectId, engine)
      goal?.onOperatorMessage(projectId, engine, info)
    },
    onUsageLimit: (projectId, engine, p) => limit?.onUsageLimit(projectId, engine, p),
    interceptCommand: (ctx, text) => goal?.command(ctx, text) ?? false,
  })

  // A mesma amarração do app.ts.
  const holds = (projectId: number, engine: string): boolean =>
    mgr.isShuttingDown() || holdsForNotice(store.get(projectId, engine))
  const liveLocalId = (projectId: number, engine: string): string | null =>
    mgr.list().find((s) => s.projectId === projectId && s.engine === engine && ACTIVE.has(s.status))?.localId ?? null

  app = Fastify({ logger: false })
  orch = registerOrchestratorRoutes(app, {
    db, manager: mgr,
    canTake: (projectId, engine) => !holds(projectId, engine),
    onTaskEnded: (id) => wake.onTaskEnded(id),
  })
  registerHermesRoutes(app, { db, manager: mgr, goal: () => goal })
  const queueStore = createOperatorQueueStore(db)
  queue = createOperatorQueueService({
    store: queueStore, manager: mgr, broadcast: () => {}, holds,
    acceptsMidTurn: () => midTurn, liveLocalId, isShuttingDown: () => mgr.isShuttingDown(),
  })
  nextSend = arbiter = createNextSend({
    providers: [
      { name: 'operator-queue', slot: 3, offer: (ctx) => queue.offer(ctx) },
      { name: 'agent-tasks', slot: 5, offer: (ctx) => orch.drain(ctx.projectId, ctx.localId) },
      {
        // O agendador: manda como ele (sendAndWait, origem `schedule`).
        name: 'schedule-stub', slot: 5,
        offer: (ctx) => {
          if (scheduleNext == null || ctx.projectId !== origem.id) return false
          const text = scheduleNext
          scheduleNext = null
          void mgr.sendAndWait(ctx.localId, text, { wait: false })
          return true
        },
      },
    ],
    holds,
    isFree: (localId) => {
      const s = mgr.get(localId)
      return !!s && mgr.hasFreeSession(s.projectId, { localId }) && !mgr.compactionPending(localId)
    },
    liveLocalId,
    log: (m) => logs.push(m),
  })
  restart = createRestartService({
    db, manager: mgr, store,
    orchestrator: () => orch,
    // Como o publishTerminalState do app.ts: publica e cutuca o árbitro na microtask.
    broadcast: (m) => {
      const state = (m as { type?: string; state?: TerminalStateDto }).state
      if (!state) return
      states.push(state)
      queueMicrotask(() => nextSend.poke(state.projectId, state.engine))
    },
    closeInterruptedRuns: () => 0,
    log: (m) => logs.push(m),
    decorate: (projectId, engine) => wake.decorate(projectId, engine),
    decoratedTerminals: () => wake.terminals(),
  })
  limit = createUsageLimitService({
    manager: mgr, store, restart,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return { clear() { t.cleared = true } }
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
  })
  goal = createGoalService({
    db, manager: mgr, store, restart, nextSend: () => nextSend, log: (m) => logs.push(m),
    hasPendingResults: (projectId, engine) => wake?.hasPending(projectId, engine) ?? false,
    queueInterrupted: (projectId, engine) => queue.wasOwnInterrupt(projectId, engine),
  })
  wake = createTaskWake({
    db, manager: mgr, store, restart, nextSend: () => nextSend, holds, log: (m) => logs.push(m),
    onDelivered: (projectId, engine) => goal.onTaskResultDelivered(projectId, engine),
  })
  nextSend.register(wake.provider)
  nextSend.register(goal.provider)
}

/** Sobe uma sessão do terminal e espera ficar livre. */
async function up(project: Project): Promise<string> {
  const { localId } = mgr.start(project, { engine: 'claude' })
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  return localId
}

/** Encaminha uma tarefa pela rota, como o Hermes faz. */
async function dispatch(description: string, from: Project, to: Project): Promise<number> {
  const res = await app.inject({
    method: 'POST', url: '/api/orchestrator/dispatch',
    payload: { fromProjectId: from.id, fromEngine: 'claude', toProjectName: to.name, description },
  })
  expect(res.statusCode).toBe(200)
  return res.json().id as number
}

/** O goal_done do agente, pela rota do Hermes. */
const goalDone = (evidence: string, projectId = origem.id, engine = 'claude') =>
  app.inject({ method: 'POST', url: '/api/hermes/goal-done', payload: { projectId, engine, evidence } })

/** A reabertura do limite: avança o relógio até o timer pendente e o dispara. */
async function reopen(): Promise<void> {
  const live = timers.filter((t) => !t.cleared)
  expect(live).toHaveLength(1)
  live[0].cleared = true
  clock += live[0].ms
  await live[0].fn()
}

describe('textos do goal', () => {
  it('partida e continue verbatim', () => {
    expect(GOAL_MAX_TURNS).toBe(20)
    expect(goalStartText('testes verdes')).toBe(
      '[Claudinei: goal start]: New goal: testes verdes. Work toward it turn after turn. Only when it is entirely met, call goal_done with the evidence.')
    expect(goalContinueText('testes verdes', 3)).toBe(
      '[Claudinei: goal]: Continue toward the goal: testes verdes. Turn 3/20. When it is fully met, call goal_done with the evidence.')
  })
})

describe('estado do goal no terminal', () => {
  it('sem goal: DTO com goal null; o store grava, conta, encerra e limpa', () => {
    expect(toDto(store.get(origem.id, 'claude')).goal).toBeNull()
    store.startGoal(origem.id, 'claude', 'critério')
    let row = store.get(origem.id, 'claude')
    expect(row.goalStartedAt).not.toBeNull()
    expect(toDto(row).goal).toEqual({ criterion: 'critério', status: 'active', pause: null, turns: 0, max: 20, evidence: null })
    expect(store.bumpGoalTurn(origem.id, 'claude')).toBe(1)
    expect(store.bumpGoalTurn(origem.id, 'claude')).toBe(2)
    store.setGoalStatus(origem.id, 'claude', 'paused', 'limit')
    expect(toDto(store.get(origem.id, 'claude')).goal).toMatchObject({ status: 'paused', pause: 'limit', turns: 2 })
    store.setGoalStatus(origem.id, 'claude', 'active')
    expect(toDto(store.get(origem.id, 'claude')).goal).toMatchObject({ status: 'active', pause: null })
    store.finishGoal(origem.id, 'claude', 'npm test: 12 passed')
    expect(toDto(store.get(origem.id, 'claude')).goal).toMatchObject({ status: 'done', evidence: 'npm test: 12 passed', turns: 2 })
    // Um goal novo zera tudo.
    store.startGoal(origem.id, 'claude', 'outro')
    row = store.get(origem.id, 'claude')
    expect(toDto(row).goal).toEqual({ criterion: 'outro', status: 'active', pause: null, turns: 0, max: 20, evidence: null })
    store.clearGoal(origem.id, 'claude')
    expect(toDto(store.get(origem.id, 'claude')).goal).toBeNull()
    expect(store.get(origem.id, 'claude').goalStartedAt).toBeNull()
  })

  it('o goal não mexe nos interruptores nem no limite', () => {
    store.setPrefs(origem.id, 'claude', { autoResume: true })
    store.startGoal(origem.id, 'claude', 'x')
    store.clearGoal(origem.id, 'claude')
    const row = store.get(origem.id, 'claude')
    expect(row.autoResume).toBe(true)
    expect(row.limitHitAt).toBeNull()
  })
})

describe('/goal: partida e laço', () => {
  it('/goal inicia, manda a partida e não pausa a si mesmo', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal devagar meta')
    // Gravado antes da partida, e a partida (que conta como do operador) não o pausa.
    expect(goalOf().goalStatus).toBe('active')
    expect(goalOf().goalCriterion).toBe('devagar meta')
    expect(received(o)).toEqual([goalStartText('devagar meta')])
    expect(lastState()?.goal).toMatchObject({ criterion: 'devagar meta', status: 'active', turns: 0, max: 20 })
    // O turno da partida conta (1) e o continue sai com o turno 2.
    await waitUntil(() => continues(o).length === 1)
    expect(goalOf().goalTurns).toBe(1)
    expect(continues(o)[0]).toBe(goalContinueText('devagar meta', 2))
    expect(goalOf().goalStatus).toBe('active')
    // O /goal não foi à sessão como texto.
    expect(received(o).some((t) => t.startsWith('/goal'))).toBe(false)
  })

  it('/goal sem critério ou com mais de 2000 caracteres: goal_invalid, nada enviado', async () => {
    const o = await up(origem)
    for (const text of ['/goal', '/goal   ', `/goal ${'x'.repeat(2001)}`]) {
      let err: unknown
      try { mgr.send(o, text) } catch (e) { err = e }
      expect(err).toBeInstanceOf(UserError)
      expect((err as UserError).code).toBe('goal_invalid')
    }
    await pause()
    expect(received(o)).toEqual([])
    expect(goalOf().goalCriterion).toBeNull()
    // 2000 exatos passa.
    mgr.send(o, `/goal devagar ${'y'.repeat(1992)}`)
    expect(goalOf().goalStatus).toBe('active')
  })

  it('fim de turno com goal ativo manda o continue com Turn n/20', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal devagar passo')
    await waitUntil(() => continues(o).length === 2)
    expect(continues(o)).toEqual([goalContinueText('devagar passo', 2), goalContinueText('devagar passo', 3)])
    // Cada continue vem só depois do result do turno anterior: um envio por folga.
    const r = received(o)
    expect(r[0]).toBe(goalStartText('devagar passo'))
    expect(r.slice(1, 3)).toEqual(continues(o))
    expect(goalOf().goalTurns).toBe(2)
  })

  it('goal_done encerra o laço: nenhum continue depois', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal devagar terminar')
    await waitUntil(() => continues(o).length === 1)
    // No meio do turno 2, o agente declara o objetivo cumprido.
    const res = await goalDone('npm test: 40 passed')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(goalOf().goalStatus).toBe('done')
    expect(goalOf().goalEvidence).toBe('npm test: 40 passed')
    expect(lastState()?.goal).toMatchObject({ status: 'done', evidence: 'npm test: 40 passed' })
    // O turno 2 termina e nada mais sai.
    await waitUntil(() => resultsOf(o).length === 2)
    await pause(500)
    expect(continues(o)).toHaveLength(1)
    // O turno que terminou depois do done não conta.
    expect(goalOf().goalTurns).toBe(1)
    // Um segundo done: não há mais goal ativo.
    expect((await goalDone('de novo')).statusCode).toBe(409)
  })

  it('teto: 20 turnos sem goal_done → cap, sem continue', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal girar')
    await waitUntil(() => goalOf().goalStatus === 'cap', 15000)
    expect(goalOf().goalTurns).toBe(20)
    // Partida (1) + 19 continues = 20 turnos.
    expect(continues(o)).toHaveLength(19)
    expect(continues(o)[18]).toBe(goalContinueText('girar', 20))
    await pause(400)
    expect(continues(o)).toHaveLength(19)
    expect(lastState()?.goal).toMatchObject({ status: 'cap', turns: 20, max: 20 })
  })
})

describe('/goal: pausas não mandam continue', () => {
  it('mensagem do operador pausa', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal devagar operador')
    await waitUntil(() => continues(o).length === 1)
    mgr.send(o, 'mudei de ideia')
    expect(goalOf().goalStatus).toBe('paused')
    expect(goalOf().goalPause).toBe('operator')
    await waitUntil(() => resultsOf(o).length >= 3)
    await pause(500)
    expect(continues(o)).toHaveLength(1)
    expect(lastState()?.goal).toMatchObject({ status: 'paused', pause: 'operator' })
  })

  describe('goal e a fila do operador', () => {
    /** Motivos de pausa que o goal publicou, na ordem. */
    const pauses = () => states
      .filter((s) => s.projectId === origem.id && s.engine === 'claude' && s.goal?.status === 'paused')
      .map((s) => s.goal!.pause)

    it('Alt+Enter: o item sai depois do turno, o goal não pausa e o continue vem depois dele', async () => {
      const o = await up(origem)
      mgr.send(o, '/goal devagar alt')
      await waitUntil(() => mgr.get(o)?.status === 'working')
      queue.add(origem.id, 'claude', 'enfileirado de propósito', 'alt-enter')
      await waitUntil(() => continues(o).length === 1)
      const r = received(o)
      expect(r.indexOf('enfileirado de propósito')).toBeGreaterThan(-1)
      expect(r.indexOf('enfileirado de propósito')).toBeLessThan(r.indexOf(continues(o)[0]))
      expect(goalOf().goalStatus).toBe('active')
      expect(pauses()).toEqual([])
      expect((await goalDone('ok')).statusCode).toBe(200)
    })

    it('Enter com o motor ocupado (Kimi/OpenCode): o item sai como mensagem do operador e pausa o goal', async () => {
      const o = await up(origem)
      mgr.send(o, '/goal devagar ocupado')
      await waitUntil(() => mgr.get(o)?.status === 'working')
      queue.add(origem.id, 'claude', 'digitado com o motor ocupado', 'enter-busy')
      await waitUntil(() => received(o).includes('digitado com o motor ocupado'))
      expect(goalOf()).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
      await pause(500)
      expect(continues(o)).toEqual([])
    })

    it('Claude digitado no meio do turno pausa por operador', async () => {
      const o = await up(origem)
      mgr.send(o, '/goal devagar digitado')
      await waitUntil(() => mgr.get(o)?.status === 'working')
      mgr.send(o, 'mudei de ideia')
      expect(goalOf()).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
    })

    it('"Enviar agora" no Claude (injeta no turno) pausa por operador', async () => {
      const o = await up(origem)
      mgr.send(o, '/goal devagar agora')
      await waitUntil(() => mgr.get(o)?.status === 'working')
      queue.add(origem.id, 'claude', 'agora mesmo', 'alt-enter')
      queue.sendNow(queue.dto(origem.id, 'claude').items[0].id)
      expect(goalOf()).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
      expect(pauses()).toEqual(['operator'])
    })

    it('"Enviar agora" no Kimi (interrompe e manda): pausa uma vez, por operador, e não pela interrupção', async () => {
      midTurn = false
      const o = await up(origem)
      mgr.send(o, '/goal demorada kimi')
      await waitUntil(() => mgr.get(o)?.status === 'working')
      queue.add(origem.id, 'claude', 'agora no kimi', 'alt-enter')
      queue.sendNow(queue.dto(origem.id, 'claude').items[0].id)
      await waitUntil(() => received(o).includes('agora no kimi'))
      expect(goalOf()).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
      expect(pauses()).toEqual(['operator'])
    })
  })

  it('turno com erro pausa', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal turno-com-erro')
    await waitUntil(() => goalOf().goalStatus === 'paused')
    expect(goalOf().goalPause).toBe('error')
    await pause(400)
    expect(continues(o)).toEqual([])
    // O turno com erro não conta.
    expect(goalOf().goalTurns).toBe(0)
  })

  it('Esc pausa', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal demorada')
    await waitUntil(() => mgr.get(o)?.status === 'working')
    await mgr.interrupt(o)
    await waitUntil(() => goalOf().goalStatus === 'paused')
    expect(goalOf().goalPause).toBe('interrupt')
    await pause(400)
    expect(continues(o)).toEqual([])
  })

  it('limite pausa', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal limite meta')
    await waitUntil(() => goalOf().goalStatus === 'paused')
    expect(goalOf().goalPause).toBe('limit')
    expect(goalOf().limitHitAt).not.toBeNull()
    await pause(400)
    expect(continues(o)).toEqual([])
  })

  it('aviso aberto (trabalho interrompido esperando o operador) segura o continue', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal devagar aviso')
    await waitUntil(() => mgr.get(o)?.status === 'working')
    store.markInterrupted(origem.id, 'claude', o, null)
    await waitUntil(() => resultsOf(o).length === 1)
    await pause(500)
    expect(continues(o)).toEqual([])
    expect(goalOf().goalStatus).toBe('active')
    // O × do aviso libera: o continue sai.
    restart.dismiss(origem.id, 'claude')
    await waitUntil(() => continues(o).length === 1)
    expect(continues(o)[0]).toBe(goalContinueText('devagar aviso', 2))
  })

  it('com a compactação começando, nenhum continue; a compactação não conta', async () => {
    process.env.CLAUDE_FAKE_CTX = '150000' // 75% da janela de 200k
    const o = await up(origem)
    mgr.send(o, '/goal devagar compactar')
    await waitUntil(() => continues(o).length === 1)
    // O fim do turno 2 (do Claudinei) passa do limiar: a compactação começa.
    compactPct = 50
    await waitUntil(() => continues(o).length === 2)
    const r = received(o)
    // A compactação (lugar 1) veio antes do continue, que esperou o turno dela.
    expect(r.slice(0, 4)).toEqual([
      goalStartText('devagar compactar'),
      goalContinueText('devagar compactar', 2),
      '/compact',
      goalContinueText('devagar compactar', 3),
    ])
    // O turno da compactação (origem herdada do continue) não contou.
    expect(goalOf().goalTurns).toBe(2)
  })
})

describe('/goal resume e /goal stop', () => {
  it('/goal resume volta a 0 e continua; /goal stop limpa', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal devagar retomar')
    await waitUntil(() => continues(o).length === 2)
    mgr.send(o, 'pare um pouco')
    expect(goalOf().goalStatus).toBe('paused')
    await waitUntil(() => isFree(o) && resultsOf(o).length >= 4)
    await pause(300)
    expect(goalOf().goalTurns).toBeGreaterThan(0)
    const before = received(o).length

    mgr.send(o, '/goal resume')
    expect(goalOf().goalStatus).toBe('active')
    expect(goalOf().goalPause).toBeNull()
    expect(goalOf().goalTurns).toBe(0)
    // O /goal resume não pausou nada (não é mensagem do operador para o goal).
    await waitUntil(() => received(o).length === before + 1)
    expect(received(o)[before]).toBe(goalContinueText('devagar retomar', 1))
    expect(lastState()?.goal).toMatchObject({ status: 'active', turns: 0 })

    mgr.send(o, '/goal Stop ')
    expect(goalOf().goalCriterion).toBeNull()
    expect(goalOf().goalStatus).toBeNull()
    expect(lastState()?.goal).toBeNull()
    // Partida, turnos 2 e 3, a mensagem do operador e o continue do resume.
    await waitUntil(() => isFree(o) && resultsOf(o).length === 5)
    await pause(500)
    expect(received(o)).toHaveLength(before + 1)
  })

  it('/goal resume depois do teto ganha mais 20 turnos', async () => {
    const o = await up(origem)
    store.startGoal(origem.id, 'claude', 'devagar teto')
    store.setGoalStatus(origem.id, 'claude', 'cap')
    mgr.send(o, '/goal resume')
    await waitUntil(() => continues(o).length === 1)
    expect(continues(o)[0]).toBe(goalContinueText('devagar teto', 1))
    await waitUntil(() => goalOf().goalTurns === 1)
    expect(goalOf().goalStatus).toBe('active')
  })

  it('/goal stop vindo da fila do operador não trava a fila', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal devagar fila')
    await waitUntil(() => mgr.get(o)?.status === 'working')
    // A fila (lugar 3) entrega o /goal stop pelo manager.send e o conta como entregue.
    queue.add(origem.id, 'claude', '/goal stop')
    queue.add(origem.id, 'claude', 'depois do stop')
    await waitUntil(() => received(o).includes('depois do stop'))
    expect(goalOf().goalCriterion).toBeNull()
    expect(continues(o)).toEqual([])
    expect(queue.dto(origem.id, 'claude').items).toEqual([])
  })

  it('/goal resume sem goal: nada enviado, e a fila segue', async () => {
    const o = await up(origem)
    mgr.send(o, 'devagar ocupar', { echo: true })
    await waitUntil(() => mgr.get(o)?.status === 'working')
    queue.add(origem.id, 'claude', '/goal resume')
    queue.add(origem.id, 'claude', 'seguinte')
    await waitUntil(() => received(o).includes('seguinte'))
    expect(received(o)).toEqual(['devagar ocupar', 'seguinte'])
    expect(goalOf().goalCriterion).toBeNull()
  })
})

describe('/goal: o que conta no teto', () => {
  it('turno de tarefa de outro agente ou de agendamento não conta', async () => {
    const o = await up(origem)
    await up(destino)
    mgr.send(o, '/goal devagar contar')
    await waitUntil(() => mgr.get(o)?.status === 'working')
    // Uma tarefa de outro agente para este terminal espera o turno da partida.
    await dispatch('tarefa alheia', destino, origem)
    await waitUntil(() => continues(o).length === 1)
    let r = received(o)
    expect(r.findIndex((t) => t.includes('tarefa alheia'))).toBeLessThan(r.indexOf(continues(o)[0]))
    // A tarefa não contou: o continue é o do turno 2.
    expect(continues(o)[0]).toBe(goalContinueText('devagar contar', 2))
    // Um agendamento no meio do goal também não conta.
    scheduleNext = 'agendado agora'
    await waitUntil(() => continues(o).length === 2)
    r = received(o)
    expect(r.indexOf('agendado agora')).toBeGreaterThan(r.indexOf(continues(o)[0]))
    expect(r.indexOf('agendado agora')).toBeLessThan(r.indexOf(continues(o)[1]))
    expect(continues(o)[1]).toBe(goalContinueText('devagar contar', 3))
  })
})

describe('/goal com tarefas delegadas', () => {
  it('goal esperando tarefas delegadas não manda continue; o aviso do resultado conta e o laço volta', async () => {
    const o = await up(origem)
    // Destino sem sessão: a tarefa fica na fila.
    const id = await dispatch('trabalho delegado', origem, destino)
    expect(tasks().openFrom(origem.id, 'claude')).toBe(1)
    mgr.send(o, '/goal devagar delegar')
    await waitUntil(() => goalOf().goalStatus === 'waiting')
    expect(goalOf().goalTurns).toBe(1)
    expect(lastState()?.goal).toMatchObject({ status: 'waiting', turns: 1 })
    await pause(500)
    expect(continues(o)).toEqual([])
    // O destino sobe, faz a tarefa, e o aviso acorda a origem.
    // Sem esperar o "livre": a fila do orchestrator entrega a tarefa assim que ele sobe.
    mgr.start(destino, { engine: 'claude' })
    await waitUntil(() => continues(o).length === 1)
    expect(tasks().get(id)!.notify).toBe('delivered')
    const r = received(o)
    const notice = r.findIndex((t) => t.startsWith(TASK_RESULT_PREFIX))
    expect(notice).toBeGreaterThan(0)
    expect(notice).toBeLessThan(r.indexOf(continues(o)[0]))
    // O turno do aviso contou (2) e o laço voltou com o turno 3.
    expect(continues(o)[0]).toBe(goalContinueText('devagar delegar', 3))
  })

  it('aviso pendente e goal no mesmo fim de turno: sai só o aviso', async () => {
    const o = await up(origem)
    await up(destino)
    mgr.send(o, '/goal devagar junto')
    await waitUntil(() => mgr.get(o)?.status === 'working')
    const id = await dispatch('rapidinho', origem, destino)
    await waitUntil(() => tasks().get(id)?.notify === 'pending')
    // Fim do turno da partida: o aviso sai; o continue só no fim do turno do aviso.
    await waitUntil(() => continues(o).length === 1)
    const r = received(o)
    expect(r[0]).toBe(goalStartText('devagar junto'))
    expect(r[1].startsWith(TASK_RESULT_PREFIX)).toBe(true)
    expect(r[2]).toBe(goalContinueText('devagar junto', 3))
    expect(continues(o).some((t) => t.includes('Turn 2/20'))).toBe(false)
  })
})

describe('/goal e o limite de uso', () => {
  it('limite armado que retoma reativa o goal e conta o turno', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal limite meta')
    await waitUntil(() => goalOf().goalStatus === 'paused')
    expect(goalOf().goalPause).toBe('limit')
    expect(goalOf().goalTurns).toBe(0)
    limit.arm(origem.id, 'claude')
    await reopen()
    // A retomada (do Claudinei) termina bem: o goal volta a ativo e conta o turno.
    await waitUntil(() => continues(o).length === 1)
    const r = received(o)
    expect(r[1].startsWith(LIMIT_RESUME_PREFIX)).toBe(true)
    expect(continues(o)[0]).toBe(goalContinueText('limite meta', 2))
    // O continue bate no limite de novo: pausa outra vez.
    await waitUntil(() => goalOf().goalStatus === 'paused' && resultsOf(o).length === 3)
    expect(goalOf().goalPause).toBe('limit')
    expect(goalOf().goalTurns).toBe(1)
  })

  it('goal pausado pelo limite: mensagem do operador troca a pausa, e um turno do Claudinei depois não o reativa', async () => {
    const o = await up(origem)
    mgr.send(o, '/goal limite meta')
    await waitUntil(() => goalOf().goalStatus === 'paused')
    limit.cancel(origem.id, 'claude')
    mgr.send(o, 'eu assumo')
    expect(goalOf().goalPause).toBe('operator')
    await waitUntil(() => resultsOf(o).length === 2)
    mgr.sendAsClaudinei(o, 'mensagem do claudinei')
    await waitUntil(() => resultsOf(o).length === 3)
    await pause(300)
    expect(goalOf().goalStatus).toBe('paused')
    expect(continues(o)).toEqual([])
  })
})

describe('goal: encerramento, tarefa sumida e partida que falha', () => {
  it('no encerramento do serviço, o fim de turno não mexe no goal', () => {
    store.startGoal(origem.id, 'claude', 'x')
    mgr.beginShutdown()
    goal.onTurnResult(origem.id, 'claude', { isError: true, interrupted: false, limited: false, origin: 'claudinei' })
    goal.onTurnResult(origem.id, 'claude', { isError: false, interrupted: false, limited: false, origin: 'claudinei' })
    expect(goalOf()).toMatchObject({ goalStatus: 'active', goalPause: null, goalTurns: 0 })
  })

  it('goal esperando por tarefa cujo destino foi apagado (a tarefa sumiu): volta a ativo e o laço segue', async () => {
    const o = await up(origem)
    // Destino sem sessão: a tarefa fica na fila.
    const id = await dispatch('trabalho delegado', origem, destino)
    mgr.send(o, '/goal devagar orfa')
    await waitUntil(() => goalOf().goalStatus === 'waiting')
    // Apagar o projeto de destino leva a tarefa junto (ON DELETE CASCADE).
    db.prepare('DELETE FROM projects WHERE id=?').run(destino.id)
    expect(tasks().get(id)).toBeFalsy()
    nextSend.poke(origem.id, 'claude')
    await waitUntil(() => continues(o).length === 1)
    expect(goalOf().goalStatus).toBe('active')
    expect(continues(o)[0]).toBe(goalContinueText('devagar orfa', 2))
  })

  it('goal esperando com resultado pendente (segurado pelo Esc, R19) segue esperando', async () => {
    const o = await up(origem)
    store.startGoal(origem.id, 'claude', 'x')
    store.setGoalStatus(origem.id, 'claude', 'waiting')
    const { id } = tasks().create(origem.id, destino.id, 'feita', 'in_progress', 'claude')
    tasks().setResult(id, 'completed', 'ok')
    tasks().setNotify([id], 'pending')
    wake.onTurnResult(origem.id, 'claude', { isError: false, interrupted: true, limited: false, origin: 'operator' })
    nextSend.poke(origem.id, 'claude')
    await pause()
    expect(goalOf().goalStatus).toBe('waiting')
    expect(continues(o)).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
  })

  it('partida que falha (motor recusa no meio do turno) devolve o goal anterior', async () => {
    const o = await up(origem)
    store.startGoal(origem.id, 'claude', 'antigo')
    store.bumpGoalTurn(origem.id, 'claude')
    store.bumpGoalTurn(origem.id, 'claude')
    store.setGoalStatus(origem.id, 'claude', 'paused', 'operator')
    const antes = goalOf()
    const send = mgr.send
    mgr.send = (() => { throw new Error('mid-turn') }) as typeof mgr.send
    try {
      expect(() => goal.command({ projectId: origem.id, engine: 'claude', localId: o }, '/goal novo')).toThrow('mid-turn')
    } finally { mgr.send = send }
    expect(goalOf()).toEqual(antes)
    expect(lastState()?.goal).toMatchObject({ criterion: 'antigo', status: 'paused', pause: 'operator', turns: 2 })
    // Sem goal antes: segue sem goal.
    store.clearGoal(origem.id, 'claude')
    mgr.send = (() => { throw new Error('mid-turn') }) as typeof mgr.send
    try {
      expect(() => goal.command({ projectId: origem.id, engine: 'claude', localId: o }, '/goal novo')).toThrow('mid-turn')
    } finally { mgr.send = send }
    expect(goalOf().goalCriterion).toBeNull()
  })
})

describe('goal_done (rota)', () => {
  it('goal_done sem goal ativo: erro legível', async () => {
    await up(origem)
    const res = await goalDone('feito')
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'no_active_goal' })
    expect(res.json().error).toMatch(/no active goal/i)
    expect(goal.done(origem.id, 'claude', 'feito')).toEqual({ ok: false, error: 'no_active_goal' })
    // Outro motor do mesmo projeto não vê o goal deste.
    store.startGoal(origem.id, 'claude', 'x')
    expect((await goalDone('feito', origem.id, 'codex')).statusCode).toBe(409)
  })

  it('evidência vazia ou acima de 4000: 400; projeto inexistente: 404', async () => {
    store.startGoal(origem.id, 'claude', 'x')
    expect((await goalDone('')).statusCode).toBe(400)
    expect((await goalDone('e'.repeat(4001))).statusCode).toBe(400)
    expect((await goalDone('ok', 9999)).statusCode).toBe(404)
    expect(goalOf().goalStatus).toBe('active')
    expect((await goalDone('e'.repeat(4000))).statusCode).toBe(200)
  })

  it('goal pausado também pode ser declarado cumprido', async () => {
    store.startGoal(origem.id, 'claude', 'x')
    store.setGoalStatus(origem.id, 'claude', 'paused', 'operator')
    expect((await goalDone('feito na conversa com o operador')).statusCode).toBe(200)
    expect(goalOf().goalStatus).toBe('done')
  })
})
