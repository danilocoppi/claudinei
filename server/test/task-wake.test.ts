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
import { createTerminalStateStore, type TerminalStateDto, type TerminalStateStore } from '../src/restart/terminal-state.js'
import { createRestartService, type RestartService } from '../src/restart/boot.js'
import { registerOrchestratorRoutes, type OrchestratorHooks } from '../src/routes/orchestrator.js'
import { createNextSend, holdsForNotice, type NextSend } from '../src/queue/next-send.js'
import { createTasksService } from '../src/tasks.js'
import { createTaskWake } from '../src/delegate/task-wake.js'
import { createUsageLimitService, type UsageLimitService } from '../src/limit/usage-limit.js'
import { TASK_RESULT_PREFIX, TASK_RESULT_MAX, taskResultText } from '../src/delegate/texts.js'
import '../src/engine/index.js'

/**
 * O aviso de resultado (lugar 4 do árbitro): a tarefa encaminhada termina e o
 * terminal que a encaminhou é acordado com o resultado, na hora certa. Monta só
 * o necessário, com a mesma amarração do app.ts (holds, isFree, liveLocalId e o
 * cutucão do árbitro quando o estado do terminal é publicado): o CLI falso, o
 * orchestrator num Fastify próprio, o reinício e um árbitro real com o lugar 4
 * (este serviço) e o lugar 5 (as tarefas de outros agentes, o drain).
 */

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
/** Com `tardio`, o CLI falso só manda o init junto da 1ª mensagem: a sessão fica em `starting`, como a revivida na subida. */
let tardio = false
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: tardio ? [FAKE, '--init-tardio'] : [FAKE] })

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
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
let origem: Project
let destino: Project
/** O que o Claudinei mandou (sendAsClaudinei), por sessão. */
let sent: { localId: string; text: string }[]
/** Estados publicados (`terminal_state`). */
let states: TerminalStateDto[]
let logs: string[]
/** O que o manager publica (eventos das sessões): prova que a mensagem chegou ao agente. */
let mgrEvents: any[]
let limit: UsageLimitService
/** Relógio e timers falsos do serviço do limite (a reabertura é disparada à mão). */
let clock: number
let timers: { fn: () => unknown; ms: number; cleared: boolean }[]

const tasks = () => createTasksService(db)
const notices = () => sent.filter((s) => s.text.startsWith(TASK_RESULT_PREFIX))
const lastState = (projectId: number, engine = 'claude') =>
  [...states].reverse().find((s) => s.projectId === projectId && s.engine === engine)

beforeEach(async () => {
  db = openDb(':memory:')
  sent = []
  states = []
  logs = []
  mgrEvents = []
  clock = Date.now()
  timers = []
  tardio = false
  const projects = createProjectsService(db)
  origem = projects.create({ name: 'Origem', path: mkdtempSync(join(tmpdir(), 'tw-o-')) })
  destino = projects.create({ name: 'Destino', path: mkdtempSync(join(tmpdir(), 'tw-d-')) })
  store = createTerminalStateStore(db)
  build()
})

/**
 * Monta o serviço sobre o banco atual: manager, orchestrator, árbitro, reinício,
 * limite e o aviso de tarefa. Chamar de novo simula o Claudinei subindo outra vez.
 */
function build(): void {
  let arbiter: NextSend | undefined
  mgr = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: (m) => mgrEvents.push(m),
    onSessionAvailable: (projectId, ctx) => { if (ctx) arbiter?.onSessionAvailable({ projectId, ...ctx }) },
    // Os ganchos como o index.ts os amarra (o do aviso de tarefa entra na Task 5).
    onTurnResult: (projectId, engine, info) => {
      restart?.onTurnResult(projectId, engine)
      limit?.onTurnResult(projectId, engine, info)
      wake?.onTurnResult(projectId, engine, info)
    },
    onOperatorMessage: (projectId, engine) => {
      restart?.onOperatorMessage(projectId, engine)
      limit?.onOperatorMessage(projectId, engine)
    },
    onUsageLimit: (projectId, engine, p) => limit?.onUsageLimit(projectId, engine, p),
  })
  // Registra o que o Claudinei manda, sem mudar o envio.
  const original = mgr.sendAsClaudinei.bind(mgr)
  mgr.sendAsClaudinei = (localId: string, text: string) => { sent.push({ localId, text }); original(localId, text) }

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
  nextSend = arbiter = createNextSend({
    providers: [{ name: 'agent-tasks', slot: 5, offer: (ctx) => orch.drain(ctx.projectId, ctx.localId) }],
    holds,
    isFree: (localId) => {
      const s = mgr.get(localId)
      return !!s && mgr.hasFreeSession(s.projectId, { localId })
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
  wake = createTaskWake({ db, manager: mgr, store, restart, nextSend: () => nextSend, holds, log: (m) => logs.push(m) })
  nextSend.register(wake.provider)
}

/** Derruba o serviço montado (o encerramento antes de uma nova subida). */
async function teardown(): Promise<void> {
  limit.dispose()
  await mgr.stopAll()
  await app.close()
}

/** A reabertura do limite: avança o relógio até o timer pendente e o dispara. */
async function reopen(): Promise<void> {
  const live = timers.filter((t) => !t.cleared)
  expect(live).toHaveLength(1)
  live[0].cleared = true
  clock += live[0].ms
  await live[0].fn()
}

afterEach(async () => {
  await teardown()
})

/** Sobe uma sessão do terminal e espera ficar livre. */
async function up(project: Project): Promise<string> {
  const { localId } = mgr.start(project, { engine: 'claude' })
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  return localId
}

/** Encaminha uma tarefa pela rota, como o Hermes faz. */
async function dispatch(description: string, from: { fromProjectId?: number; fromEngine?: string } = { fromProjectId: origem.id, fromEngine: 'claude' }): Promise<number> {
  const res = await app.inject({
    method: 'POST', url: '/api/orchestrator/dispatch',
    payload: { ...from, toProjectName: 'Destino', description },
  })
  expect(res.statusCode).toBe(200)
  return res.json().id as number
}

const ended = (id: number) => () => ['completed', 'failed'].includes(tasks().get(id)?.status ?? '')

describe('textos do aviso de resultado', () => {
  it('uma tarefa: selo, cabeçalho e o resultado', () => {
    expect(taskResultText([{ id: 7, toProjectName: 'Destino', status: 'completed', result: 'pronto' }]))
      .toBe('[Claudinei: task result]: Task #7 sent to Destino completed.\npronto')
    expect(taskResultText([{ id: 8, toProjectName: 'Destino', status: 'failed', result: null }]))
      .toBe('[Claudinei: task result]: Task #8 sent to Destino failed.')
  })

  it('resultado de 5000 caracteres é cortado em 4000 com o rodapé', () => {
    const longo = 'x'.repeat(5000)
    const text = taskResultText([{ id: 9, toProjectName: 'Destino', status: 'completed', result: longo }])
    expect(TASK_RESULT_MAX).toBe(4000)
    expect(text).toBe(`[Claudinei: task result]: Task #9 sent to Destino completed.\n${'x'.repeat(4000)}\n(full text: list_tasks #9)`)
    // Exatamente 4000: não corta nem põe rodapé.
    const justo = taskResultText([{ id: 10, toProjectName: 'Destino', status: 'completed', result: 'y'.repeat(4000) }])
    expect(justo.endsWith('y'.repeat(4000))).toBe(true)
    expect(justo).not.toContain('full text')
  })
})

describe('aviso de resultado ao terminal que delegou', () => {
  it('tarefa encaminhada que termina acorda o terminal de origem livre com o resultado', async () => {
    const o = await up(origem)
    await up(destino)
    const id = await dispatch('faça algo')
    await waitUntil(() => notices().length === 1)
    const t = tasks().get(id)!
    expect(t.status).toBe('completed')
    expect(notices()[0]).toEqual({
      localId: o,
      text: `${TASK_RESULT_PREFIX}: Task #${id} sent to Destino completed.\n${t.result}`,
    })
    expect(t.result).toMatch(/eco: \[Task from Origem\]: faça algo/)
    expect(tasks().get(id)!.notify).toBe('delivered')
    // A mensagem chegou de fato ao agente de origem (o CLI falso ecoa).
    await waitUntil(() => mgrEvents.some((m) => m.localId === o && m.event?.kind === 'result' &&
      String(m.event.resultText).startsWith(`eco: ${TASK_RESULT_PREFIX}: Task #${id}`)))
    expect(lastState(origem.id)?.taskResults).toEqual([])
  })

  it('origem trabalhando: o aviso sai no fim do turno, não no meio', async () => {
    const o = await up(origem)
    await up(destino)
    mgr.send(o, 'demorada')   // turno que só fecha com o Esc
    await waitUntil(() => mgr.get(o)?.status === 'working')
    const id = await dispatch('faça algo')
    await waitUntil(ended(id))
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
    expect(lastState(origem.id)?.taskResults).toEqual([{ id, toProjectName: 'Destino', status: 'completed' }])
    // O turno acaba: o aviso sai na folga.
    await mgr.interrupt(o)
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('origem parada com retomar ligado: revive e entrega', async () => {
    const o = await up(origem)
    await up(destino)
    await mgr.stop(o)
    await waitUntil(() => !ACTIVE.has(mgr.get(o)?.status ?? 'stopped'))
    store.setPrefs(origem.id, 'claude', { autoResume: true })
    const id = await dispatch('faça algo')
    await waitUntil(() => notices().length === 1)
    // A sessão revivida (a mesma) recebeu o aviso.
    expect(notices()[0].localId).toBe(o)
    expect(ACTIVE.has(mgr.get(o)!.status)).toBe(true)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('origem parada com retomar desligado: taskResults no DTO e nada enviado; continueNow entrega', async () => {
    const o = await up(origem)
    await up(destino)
    await mgr.stop(o)
    await waitUntil(() => !ACTIVE.has(mgr.get(o)?.status ?? 'stopped'))
    const id = await dispatch('faça algo')
    await waitUntil(ended(id))
    await pause()
    expect(notices()).toEqual([])
    expect(ACTIVE.has(mgr.get(o)!.status)).toBe(false)
    expect(tasks().get(id)!.notify).toBe('pending')
    const want = [{ id, toProjectName: 'Destino', status: 'completed' }]
    expect(lastState(origem.id)?.taskResults).toEqual(want)
    // A lista que a tela lê ao abrir traz o terminal, mesmo sem linha de estado.
    expect(restart.list().find((s) => s.projectId === origem.id && s.engine === 'claude')?.taskResults).toEqual(want)
    expect(wake.decorate(origem.id, 'claude')).toEqual({ taskResults: want })

    // O Continuar do aviso: revive e entrega.
    expect(wake.continueNow(origem.id, 'claude')).toBe(true)
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(id)!.notify).toBe('delivered')
    expect(wake.decorate(origem.id, 'claude')).toEqual({ taskResults: [] })
    // Nada mais pendente: false.
    expect(wake.continueNow(origem.id, 'claude')).toBe(false)
  })

  it('dismiss tira do DTO e o resultado segue em list_tasks', async () => {
    const o = await up(origem)
    await up(destino)
    await mgr.stop(o)
    await waitUntil(() => !ACTIVE.has(mgr.get(o)?.status ?? 'stopped'))
    const id = await dispatch('faça algo')
    await waitUntil(() => tasks().get(id)?.notify === 'pending')
    const result = tasks().get(id)!.result
    wake.dismiss(origem.id, 'claude')
    expect(tasks().get(id)!.notify).toBe('dismissed')
    expect(lastState(origem.id)?.taskResults).toEqual([])
    expect(wake.terminals()).toEqual([])
    // O list_tasks (a rota) segue com o resultado inteiro.
    const res = await app.inject({ method: 'GET', url: '/api/orchestrator/tasks' })
    expect(res.json().find((t: any) => t.id === id)).toMatchObject({ status: 'completed', result })
    await pause()
    expect(notices()).toEqual([])
    expect(wake.continueNow(origem.id, 'claude')).toBe(false)
  })

  // Ajustado pela decisão R11 (linha 178 do desenho): antes, o limite limpo
  // entregava na hora; agora o resultado espera o terminal voltar a trabalhar.
  it('origem em limite: segura; limite limpo sem trabalho não entrega; o turno do operador entrega na folga seguinte', async () => {
    const o = await up(origem)
    await up(destino)
    store.recordUsageLimit(origem.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) + 3600, origin: 'operator' })
    const id = await dispatch('faça algo')
    await waitUntil(ended(id))
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
    expect(lastState(origem.id)?.taskResults).toEqual([{ id, toProjectName: 'Destino', status: 'completed' }])
    // O aviso do limite sai sem ninguém trabalhar: o estado publicado cutuca o
    // árbitro, mas o lugar 4 segura (o Claudinei não gasta tokens sozinho).
    store.clearLimit(origem.id, 'claude')
    restart.publish(origem.id, 'claude')
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
    // O operador volta a trabalhar: no fim do turno dele, o aviso sai.
    mgr.send(o, 'oi')
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  /** A origem bate no limite de verdade (o CLI falso) e uma tarefa termina durante ele. */
  async function limitedWithPending(): Promise<{ o: string; id: number }> {
    const o = await up(origem)
    await up(destino)
    mgr.send(o, 'limite')
    await waitUntil(() => store.get(origem.id, 'claude').limitHitAt != null && mgr.get(o)?.status !== 'working')
    const id = await dispatch('faça algo')
    await waitUntil(ended(id))
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
    return { o, id }
  }

  it('limite adiado que reabre não entrega sozinho; o turno do operador entrega', async () => {
    const { o, id } = await limitedWithPending()
    limit.snooze(origem.id, 'claude')
    await reopen()
    expect(store.get(origem.id, 'claude').limitHitAt).toBeNull()
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
    mgr.send(o, 'oi')
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('× no aviso do limite não entrega; o turno do operador entrega', async () => {
    const { o, id } = await limitedWithPending()
    limit.cancel(origem.id, 'claude')
    expect(store.get(origem.id, 'claude').limitHitAt).toBeNull()
    await pause()
    expect(notices()).toEqual([])
    mgr.send(o, 'oi')
    await waitUntil(() => notices().length === 1)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('depois do limite, o Continuar do aviso da tarefa é o operador pedindo: entrega', async () => {
    const { o, id } = await limitedWithPending()
    // Com o limite ainda ativo, o Continuar não tira a marca: segue segurado.
    expect(wake.continueNow(origem.id, 'claude')).toBe(true)
    await pause()
    expect(notices()).toEqual([])
    limit.cancel(origem.id, 'claude')
    await pause()
    expect(notices()).toEqual([])
    expect(wake.continueNow(origem.id, 'claude')).toBe(true)
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('retomada armada do limite conta como volta ao trabalho: o aviso sai depois do turno dela', async () => {
    const { o, id } = await limitedWithPending()
    limit.arm(origem.id, 'claude')
    await reopen()
    // A retomada (do Claudinei) saiu primeiro; o aviso, só no fim do turno dela.
    expect(sent.filter((m) => !m.text.startsWith(TASK_RESULT_PREFIX))).toHaveLength(1)
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(sent.findIndex((m) => m.text.startsWith(TASK_RESULT_PREFIX))).toBe(1)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('boot refaz a marca do limite: limite limpo depois da subida não entrega sozinho', async () => {
    const o = await up(origem)
    const { id } = tasks().create(origem.id, destino.id, 'antes do reinício', 'queued', 'claude')
    tasks().setResult(id, 'completed', 'feito')
    tasks().setNotify([id], 'pending')
    store.recordUsageLimit(origem.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) + 3600, origin: 'operator' })
    await wake.boot()
    store.clearLimit(origem.id, 'claude')
    restart.publish(origem.id, 'claude')
    await pause()
    expect(notices()).toEqual([])
    mgr.send(o, 'oi')
    await waitUntil(() => notices().length === 1)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('origem parada em limite com retomar ligado: não revive, só publica', async () => {
    const o = await up(origem)
    await up(destino)
    await mgr.stop(o)
    await waitUntil(() => !ACTIVE.has(mgr.get(o)?.status ?? 'stopped'))
    store.setPrefs(origem.id, 'claude', { autoResume: true })
    store.recordUsageLimit(origem.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) + 3600, origin: 'operator' })
    const id = await dispatch('faça algo')
    await waitUntil(ended(id))
    await pause()
    expect(notices()).toEqual([])
    expect(ACTIVE.has(mgr.get(o)!.status)).toBe(false)
    expect(lastState(origem.id)?.taskResults).toHaveLength(1)
  })

  it('várias pendentes saem numa mensagem só, uma por bloco', async () => {
    const o = await up(origem)
    await up(destino)
    mgr.send(o, 'demorada')
    await waitUntil(() => mgr.get(o)?.status === 'working')
    const a = await dispatch('primeira')
    const b = await dispatch('segunda')
    await waitUntil(() => ended(a)() && ended(b)())
    await pause()
    expect(notices()).toEqual([])
    expect(lastState(origem.id)?.taskResults?.map((t) => t.id)).toEqual([a, b])
    await mgr.interrupt(o)
    await waitUntil(() => notices().length === 1)
    await pause()
    expect(notices()).toHaveLength(1)
    const ta = tasks().get(a)!
    const tb = tasks().get(b)!
    expect(notices()[0].text).toBe(
      `${TASK_RESULT_PREFIX}: Task #${a} sent to Destino completed.\n${ta.result}\n\nTask #${b} sent to Destino completed.\n${tb.result}`,
    )
    expect([ta.notify, tb.notify]).toEqual(['delivered', 'delivered'])
  })

  it('resultado de 5000 caracteres chega cortado em 4000 com o rodapé', async () => {
    await up(origem)
    await up(destino)
    const id = await dispatch('z'.repeat(5000))
    await waitUntil(() => notices().length === 1)
    const full = tasks().get(id)!.result!
    expect(full.length).toBeGreaterThan(5000)
    expect(notices()[0].text).toBe(
      `${TASK_RESULT_PREFIX}: Task #${id} sent to Destino completed.\n${full.slice(0, 4000)}\n(full text: list_tasks #${id})`,
    )
    // O banco guarda o resultado inteiro.
    expect(tasks().get(id)!.result).toBe(full)
  })

  it('tarefa sem origem não acorda ninguém; fromEngine nulo usa a sessão viva mais recente', async () => {
    const o = await up(origem)
    await up(destino)
    // Sem origem (o operador): ninguém é acordado.
    const semOrigem = await dispatch('do operador', {})
    await waitUntil(ended(semOrigem))
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(semOrigem)!.notify).toBe('none')

    // Motor de origem desconhecido: a sessão viva mais recente do projeto.
    const semMotor = await dispatch('sem motor', { fromProjectId: origem.id })
    expect(tasks().get(semMotor)!.fromEngine).toBeNull()
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(semMotor)!.notify).toBe('delivered')

    // Sem nenhuma sessão viva no projeto de origem: ninguém é acordado.
    await mgr.stop(o)
    await waitUntil(() => !ACTIVE.has(mgr.get(o)?.status ?? 'stopped'))
    const orfa = await dispatch('ninguém vivo', { fromProjectId: origem.id })
    await waitUntil(ended(orfa))
    await pause()
    expect(tasks().get(orfa)!.notify).toBe('none')
    expect(notices()).toHaveLength(1)
  })

  it('projeto de origem apagado: ninguém é acordado', async () => {
    const d = await up(destino)
    const outro = createProjectsService(db).create({ name: 'Some', path: mkdtempSync(join(tmpdir(), 'tw-s-')) })
    // Destino ocupado: a tarefa fica na fila enquanto o projeto de origem é apagado.
    mgr.send(d, 'demorada')
    await waitUntil(() => mgr.get(d)?.status === 'working')
    const id = await dispatch('faça algo', { fromProjectId: outro.id, fromEngine: 'claude' })
    expect(tasks().get(id)!.status).toBe('queued')
    db.prepare('DELETE FROM projects WHERE id=?').run(outro.id)
    expect(tasks().get(id)!.fromProjectId).toBeNull()
    await mgr.interrupt(d)
    await waitUntil(ended(id))
    await pause()
    expect(tasks().get(id)!.notify).toBe('none')
    expect(notices()).toEqual([])
  })

  it('motor de origem escondido recebe o aviso mesmo assim', async () => {
    const o = await up(origem)
    await up(destino)
    // O Claude sai da lista de motores do terminal (fica só o Codex).
    db.prepare('UPDATE projects SET engines=? WHERE id=?').run(JSON.stringify(['codex']), origem.id)
    const id = await dispatch('faça algo')
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('tarefa que falha também acorda, com o status failed', async () => {
    const o = await up(origem)
    const d = await up(destino)
    await mgr.stop(d)
    await waitUntil(() => !ACTIVE.has(mgr.get(d)?.status ?? 'stopped'))
    // Uma tarefa que o reinício deixou em andamento e a subida fecha como interrompida.
    const id = tasks().create(origem.id, destino.id, 'presa', 'in_progress', 'claude').id
    orch.failInterrupted(id)
    await waitUntil(() => notices().length === 1)
    expect(notices()[0]).toMatchObject({ localId: o })
    expect(notices()[0].text).toContain(`Task #${id} sent to Destino failed.`)
  })

  it('boot: pendentes da vez anterior seguem as mesmas regras', async () => {
    const projects = createProjectsService(db)
    const terceiro = projects.create({ name: 'Terceiro', path: mkdtempSync(join(tmpdir(), 'tw-t-')) })
    const quarto = projects.create({ name: 'Quarto', path: mkdtempSync(join(tmpdir(), 'tw-q-')) })
    // Origem viva e livre; Terceiro parado com retomar ligado; Quarto parado com retomar desligado.
    const o = await up(origem)
    const t3 = await up(terceiro)
    await mgr.stop(t3)
    await waitUntil(() => !ACTIVE.has(mgr.get(t3)?.status ?? 'stopped'))
    store.setPrefs(terceiro.id, 'claude', { autoResume: true })
    const pend = (from: number) => {
      const { id } = tasks().create(from, destino.id, 'antes do reinício', 'queued', 'claude')
      tasks().setResult(id, 'completed', `feito ${id}`)
      tasks().setNotify([id], 'pending')
      return id
    }
    const a = pend(origem.id)
    const b = pend(terceiro.id)
    const c = pend(quarto.id)
    await wake.boot()
    await waitUntil(() => notices().length === 2)
    await pause()
    expect(notices().map((n) => n.localId).sort()).toEqual([o, t3].sort())
    expect(tasks().get(a)!.notify).toBe('delivered')
    expect(tasks().get(b)!.notify).toBe('delivered')
    // Retomar desligado: segue pendente, à vista no aviso.
    expect(tasks().get(c)!.notify).toBe('pending')
    expect(lastState(quarto.id)?.taskResults).toEqual([{ id: c, toProjectName: 'Destino', status: 'completed' }])
    expect(mgr.list().some((s) => s.projectId === quarto.id && ACTIVE.has(s.status))).toBe(false)
  })

  /**
   * O Claudinei sobe de novo com um resultado pendente e um limite adiado que
   * venceu enquanto ele estava fora: a subida do limite (antes da do aviso, como
   * no startAfterListen) limpa o limite e publica. Nada pode sair sozinho.
   */
  async function restartWithOverdueSnooze(): Promise<number> {
    const o = await up(origem)
    await teardown()
    expect(ACTIVE.has(mgr.get(o)?.status ?? 'stopped')).toBe(false)
    store.setPrefs(origem.id, 'claude', { autoResume: true })
    store.recordUsageLimit(origem.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) - 3600, origin: 'operator' })
    store.setLimitAction(origem.id, 'claude', 'snoozed')
    const { id } = tasks().create(origem.id, destino.id, 'antes do reinício', 'queued', 'claude')
    tasks().setResult(id, 'completed', 'feito')
    tasks().setNotify([id], 'pending')
    build()
    return id
  }

  it('subida: limite adiado vencido fora do ar não faz o aviso sair sozinho (origem parada, retomar ligado)', async () => {
    const id = await restartWithOverdueSnooze()
    await limit.boot()   // processDue: o adiado vencido sai e publica
    expect(store.get(origem.id, 'claude').limitHitAt).toBeNull()
    await wake.boot()
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
    expect(mgr.list().some((s) => s.projectId === origem.id && ACTIVE.has(s.status))).toBe(false)
    expect(lastState(origem.id)?.taskResults).toEqual([{ id, toProjectName: 'Destino', status: 'completed' }])
  })

  it('subida: limite adiado vencido fora do ar não faz o aviso sair sozinho (origem já de pé); o turno do operador entrega', async () => {
    const id = await restartWithOverdueSnooze()
    // A origem já subiu pela subida do reinício ("iniciar com o Claudinei") e
    // segue em `starting`: livre para o árbitro, sem fim de turno que a ofereça antes.
    tardio = true
    const { localId: o } = mgr.start(origem, { engine: 'claude' })
    await pause()
    expect(mgr.get(o)?.status).toBe('starting')
    await limit.boot()
    await wake.boot()
    await pause()
    expect(notices()).toEqual([])
    mgr.send(o, 'oi')
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
    expect(tasks().get(id)!.notify).toBe('delivered')
  })

  it('o provedor é o lugar 4 e cede ao 3 (fila do operador) na mesma folga', async () => {
    expect(wake.provider).toMatchObject({ name: 'task-results', slot: 4 })
    const o = await up(origem)
    await up(destino)
    const calls: string[] = []
    nextSend.register({
      name: 'stub-3', slot: 3,
      // Um item só, e só no terminal de origem.
      offer: (ctx) => {
        if (ctx.projectId !== origem.id || calls.length > 0) return false
        calls.push('3')
        mgr.send(ctx.localId, 'demorada da fila')   // só fecha com o Esc
        return true
      },
    })
    const id = await dispatch('faça algo')
    await waitUntil(ended(id))
    // A folga foi do lugar 3: o aviso espera a próxima.
    await waitUntil(() => calls.length === 1)
    await pause()
    expect(notices()).toEqual([])
    expect(tasks().get(id)!.notify).toBe('pending')
    await mgr.interrupt(o)
    await waitUntil(() => notices().length === 1)
    expect(notices()[0].localId).toBe(o)
  })
})
