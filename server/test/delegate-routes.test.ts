import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createTerminalStateStore, type TerminalStateStore } from '../src/restart/terminal-state.js'
import { captureShutdown } from '../src/restart/capture.js'
import { RESUME_PREFIX, startAfterListen, type RestartService } from '../src/restart/boot.js'
import type { UsageLimitService } from '../src/limit/usage-limit.js'
import type { OrchestratorHooks } from '../src/routes/orchestrator.js'
import type { NextSend } from '../src/queue/next-send.js'
import type { OperatorQueueService } from '../src/queue/operator-queue.js'
import type { TaskWake } from '../src/delegate/task-wake.js'
import type { GoalService } from '../src/goal/goal.js'
import { createTasksService } from '../src/tasks.js'
import { TASK_RESULT_PREFIX, taskResultText } from '../src/delegate/texts.js'
import { GOAL_PREFIX, goalContinueText, goalStartText } from '../src/goal/texts.js'

/**
 * A amarração do aviso de resultado (lugar 4) e do goal (lugar 6) no app real:
 * o buildApp com o manager real e o CLI falso, e os ganchos do manager ligados
 * como em index.ts (fim de turno, mensagem do operador, `/goal`). Cobre as rotas
 * de task-results, a ordem do árbitro com tudo junto e a subida depois de um
 * reinício com aviso pendente e goal ativo.
 */
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
/** `initTardio`: o CLI só emite o init junto da 1ª mensagem (a sessão revivida fica em `starting`). */
let initTardio = false
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: initTardio ? [FAKE, '--init-tardio'] : [FAKE] })

const waitUntil = (cond: () => boolean, ms = 8000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

let db: Db
let auth: AuthService
let store: TerminalStateStore
let alfa: Project, beta: Project
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>
/** Limiar do auto-compact (0 = desligado). */
let compactPct = 0

/** Um "processo" do serviço: manager, app e as referências que index.ts amarra. */
interface Instance {
  app: Awaited<ReturnType<typeof buildApp>>
  manager: SessionManager
  mgrBroadcasts: any[]
  broadcasts: any[]
  restart?: RestartService
  limit?: UsageLimitService
  taskWake?: TaskWake
  goal?: GoalService
}
let inst: Instance
const instances: Instance[] = []

/** Monta o serviço como index.ts: os ganchos do manager leem as referências que o buildApp preenche. */
async function boot(): Promise<Instance> {
  const mgrBroadcasts: any[] = []
  const broadcasts: any[] = []
  let drain: OrchestratorHooks['drain'] | undefined
  let nextSend: NextSend | undefined
  let queue: OperatorQueueService | undefined
  let restart: RestartService | undefined
  let limit: UsageLimitService | undefined
  let taskWake: TaskWake | undefined
  let goal: GoalService | undefined
  const both = (...calls: Array<() => void>) => { for (const c of calls) { try { c() } catch (err) { console.error(err) } } }
  const manager = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m),
    autoCompactPct: () => compactPct,
    onSessionAvailable: (projectId, ctx) => {
      if (ctx && nextSend) nextSend.onSessionAvailable({ projectId, ...ctx })
      else drain?.(projectId)
    },
    onTurnResult: (projectId, engine, info) => both(
      () => restart?.onTurnResult(projectId, engine),
      () => limit?.onTurnResult(projectId, engine, info),
      () => queue?.onTurnResult(projectId, engine, info),
      () => taskWake?.onTurnResult(projectId, engine, info),
      () => goal?.onTurnResult(projectId, engine, info)),
    onOperatorMessage: (projectId, engine) => both(
      () => restart?.onOperatorMessage(projectId, engine),
      () => limit?.onOperatorMessage(projectId, engine),
      () => goal?.onOperatorMessage(projectId, engine)),
    onUsageLimit: (projectId, engine, p) => limit?.onUsageLimit(projectId, engine, p),
    onSessionDied: (projectId, engine) => queue?.onSessionDied(projectId, engine),
    interceptCommand: (ctx, text) => goal?.command(ctx, text) ?? false,
  })
  const app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as never,
    onOrchestratorReady: (o) => { drain = o.drain },
    onNextSendReady: (n) => { nextSend = n },
    onQueueReady: (q) => { queue = q },
    onRestartReady: (r) => { restart = r },
    onLimitReady: (l) => { limit = l },
    onTaskWakeReady: (w) => { taskWake = w },
    onGoalReady: (g) => { goal = g },
  })
  const i: Instance = { app, manager, mgrBroadcasts, broadcasts, restart, limit, taskWake, goal }
  instances.push(i)
  return i
}

/** Fecha o processo atual (como o SIGTERM de index.ts, depois do captureShutdown). */
async function shutdown(i: Instance): Promise<void> {
  await i.manager.stopAll()
  await i.app.close()
  instances.splice(instances.indexOf(i), 1)
}

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  store = createTerminalStateStore(db)
  initTardio = false
  compactPct = 0
  instances.length = 0
  inst = await boot()
  const projects = createProjectsService(db)
  alfa = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'dlr1-')) })
  beta = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'dlr2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [alfa.id] })
  adminCookie = cookieOf(await inst.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await inst.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
})

afterEach(async () => {
  delete process.env.CLAUDE_FAKE_CTX
  for (const i of [...instances]) {
    i.manager.beginShutdown()
    i.limit?.dispose()
    await i.manager.stopAll()
    await i.app.close()
  }
})

const tasks = () => createTasksService(db)
const req = (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object, cookies = adminCookie) =>
  inst.app.inject({ method, url: path, cookies, ...(payload ? { payload } : {}) })
const resultsUrl = (pid: number, rest = '', engine = 'claude') => `/api/projects/${pid}/terminals/${engine}/task-results${rest}`

/** Textos que entraram no chat, na ordem (todo envio ecoa como `user`). */
const userTexts = (i: Instance, localId?: string) => i.mgrBroadcasts
  .filter((b) => b.type === 'session_event' && (!localId || b.localId === localId) && b.event?.kind === 'user')
  .map((b) => String(b.event.message?.content?.[0]?.text ?? ''))
  .filter((t) => t)
/** Eventos da sessão (para comparar a posição de um envio com o result do turno anterior). */
const eventsOf = (i: Instance, localId: string) =>
  i.mgrBroadcasts.filter((b) => b.type === 'session_event' && b.localId === localId).map((b) => b.event)
const echoAt = (events: any[], pred: (t: string) => boolean) =>
  events.findIndex((e) => e?.kind === 'user' && pred(String(e.message?.content?.[0]?.text ?? '')))
const resultAt = (events: any[], pred: (t: string) => boolean) =>
  events.findIndex((e) => e?.kind === 'result' && pred(String(e.resultText ?? '')))

async function startIdle(i: Instance, project: Project): Promise<string> {
  const { localId } = i.manager.start(project)
  await waitUntil(() => i.manager.get(localId)?.status === 'idle')
  // O "livre" do arranque já passou pelo árbitro.
  await sleep(20)
  return localId
}

/** Encaminha uma tarefa pela rota HTTP, como o Hermes faz. */
async function dispatch(from: Project | null, to: Project, description: string, i = inst): Promise<number> {
  const res = await i.app.inject({
    method: 'POST', url: '/api/orchestrator/dispatch', cookies: adminCookie,
    payload: { ...(from ? { fromProjectId: from.id, fromEngine: 'claude' } : {}), toProjectName: to.name, description },
  })
  expect(res.statusCode).toBe(200)
  return res.json().id as number
}

/** Uma tarefa de Alfa que já terminou e cujo aviso está pendente (sem passar pelo orchestrator). */
function pendingResult(result = 'feito'): number {
  const { id } = tasks().create(alfa.id, beta.id, 'trabalho de Beta', 'in_progress', 'claude')
  tasks().setResult(id, 'completed', result)
  tasks().setNotify([id], 'pending')
  return id
}

const terminalStates = async (cookies = adminCookie) =>
  (await inst.app.inject({ method: 'GET', url: '/api/terminals/state', cookies })).json() as any[]
const stateOf = async (pid: number) => (await terminalStates()).find((s) => s.projectId === pid && s.engine === 'claude')

describe('amarrado', () => {
  it('amarrado: delegar e ser acordado entre dois terminais pelo dispatch HTTP', async () => {
    const a = await startIdle(inst, alfa)
    const b = await startIdle(inst, beta)
    const id = await dispatch(alfa, beta, 'conte os arquivos')
    // O destino executa; quando o turno dele termina, a origem é acordada com o resultado.
    await waitUntil(() => userTexts(inst, a).some((t) => t.startsWith(TASK_RESULT_PREFIX)))
    expect(userTexts(inst, b)).toEqual(['[Task from Alfa]: conte os arquivos'])
    const task = tasks().get(id)!
    expect(task).toMatchObject({ status: 'completed', notify: 'delivered' })
    expect(userTexts(inst, a)).toEqual([taskResultText([{ id, toProjectName: 'Beta', status: 'completed', result: task.result }])])
    expect(task.result).toBe('eco: [Task from Alfa]: conte os arquivos')
    // Entregue: o estado do terminal não mostra aviso.
    expect((await stateOf(alfa.id))?.taskResults ?? []).toEqual([])
  })

  it('amarrado: resultado pendente + tarefa na fila → sai só o aviso; a tarefa vai na próxima folga', async () => {
    const a = await startIdle(inst, alfa)
    await startIdle(inst, beta)
    // A origem trabalha (turno aberto até a resposta à pergunta): o resultado da
    // tarefa dela e uma tarefa para ela esperam o fim do turno. Não é o Esc: o Esc
    // no terminal que delegou segura o aviso (R19).
    inst.manager.send(a, 'faz-pergunta da origem')
    await waitUntil(() => inst.manager.get(a)?.pendingQuestion !== undefined)
    // `devagar` no resultado deixa o turno do aviso lento: dá para ver a tarefa ainda na fila durante ele.
    const id = await dispatch(alfa, beta, 'devagar parte de Beta')
    await waitUntil(() => tasks().get(id)?.notify === 'pending')
    const queued = await dispatch(beta, alfa, 'tarefa para Alfa')
    expect(tasks().get(queued)?.status).toBe('queued')
    await sleep(50)
    // (O envio do operador não ecoa; o do Claudinei e o da tarefa, sim.)
    expect(userTexts(inst, a)).toEqual([])

    // O turno termina (bem): a sessão livre recebe uma coisa só.
    inst.manager.dismissQuestion(a)
    await waitUntil(() => userTexts(inst, a).some((t) => t.startsWith(TASK_RESULT_PREFIX)))
    // Na mesma folga só o aviso: a tarefa segue na fila até o fim do turno dele.
    expect(tasks().get(queued)?.status).toBe('queued')
    expect(userTexts(inst, a).filter((t) => t.startsWith('[Task from Beta]'))).toEqual([])

    await waitUntil(() => tasks().get(queued)?.status === 'completed')
    const events = eventsOf(inst, a)
    const notice = echoAt(events, (t) => t.startsWith(TASK_RESULT_PREFIX))
    const noticeResult = resultAt(events, (t) => t.includes(TASK_RESULT_PREFIX))
    const task = echoAt(events, (t) => t === '[Task from Beta]: tarefa para Alfa')
    expect(notice).toBeGreaterThan(-1)
    expect(noticeResult).toBeGreaterThan(notice)
    expect(task).toBeGreaterThan(noticeResult)
  })

  it('a auto-compactação decidida no fim do turno vai antes do continue do goal (isFree do app)', async () => {
    process.env.CLAUDE_FAKE_CTX = '150000' // 75% da janela de 200k
    const a = await startIdle(inst, alfa)
    inst.manager.send(a, '/goal devagar compactar')
    await waitUntil(() => userTexts(inst, a).filter((t) => t.startsWith(`${GOAL_PREFIX}:`)).length === 1)
    // O fim do turno do continue passa do limiar: a compactação começa.
    compactPct = 50
    await waitUntil(() => userTexts(inst, a).filter((t) => t.startsWith(`${GOAL_PREFIX}:`)).length === 2)
    expect(userTexts(inst, a).slice(0, 4)).toEqual([
      goalStartText('devagar compactar'),
      goalContinueText('devagar compactar', 2),
      '/compact',
      goalContinueText('devagar compactar', 3),
    ])
  })

  it('goal_done pelo Hermes chega ao goal do app', async () => {
    const a = await startIdle(inst, alfa)
    inst.manager.send(a, '/goal devagar terminar')
    await waitUntil(() => userTexts(inst, a).some((t) => t.startsWith(`${GOAL_PREFIX}:`)))
    const res = await req('POST', '/api/hermes/goal-done', { projectId: alfa.id, engine: 'claude', evidence: 'pronto' })
    expect(res.statusCode).toBe(200)
    expect(store.get(alfa.id, 'claude')).toMatchObject({ goalStatus: 'done', goalEvidence: 'pronto' })
    // O estado publicado leva o goal (e a lista também).
    expect((await stateOf(alfa.id))?.goal).toMatchObject({ status: 'done', evidence: 'pronto' })
  })
})

describe('rotas de task-results', () => {
  it('rotas de task-results: continue entrega; sem pendentes 409; DELETE dispensa; acesso por projeto 403', async () => {
    // Alfa parado (retomar desligado, o padrão): o resultado fica à vista.
    const prev = randomUUID()
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES (?, ?, 'claude', 'stopped')`).run(prev, alfa.id)
    await startIdle(inst, beta)
    const id = await dispatch(alfa, beta, 'primeira')
    await waitUntil(() => tasks().get(id)?.notify === 'pending')
    expect((await stateOf(alfa.id))?.taskResults).toEqual([{ id, toProjectName: 'Beta', status: 'completed' }])
    // O estado publicado também leva o aviso.
    expect(inst.broadcasts.some((m) => m.type === 'terminal_state' && m.state.projectId === alfa.id && m.state.taskResults.length === 1)).toBe(true)

    // Continuar: revive o terminal e entrega.
    const cont = await req('POST', resultsUrl(alfa.id, '/continue'))
    expect(cont.statusCode).toBe(200)
    expect(cont.json()).toEqual({ ok: true })
    await waitUntil(() => tasks().get(id)?.notify === 'delivered')
    expect(userTexts(inst, prev)[0]?.startsWith(TASK_RESULT_PREFIX)).toBe(true)

    // Nada pendente: 409.
    const none = await req('POST', resultsUrl(alfa.id, '/continue'))
    expect(none.statusCode).toBe(409)
    expect(none.json().code).toBe('nothing_to_continue')

    // DELETE dispensa (o resultado segue na tarefa).
    await inst.manager.stop(prev)
    const id2 = await dispatch(alfa, beta, 'segunda')
    await waitUntil(() => tasks().get(id2)?.notify === 'pending')
    const del = await req('DELETE', resultsUrl(alfa.id))
    expect(del.statusCode).toBe(200)
    expect(tasks().get(id2)).toMatchObject({ notify: 'dismissed', status: 'completed' })
    expect((await stateOf(alfa.id))?.taskResults ?? []).toEqual([])

    // Acesso por projeto: ana só tem Alfa.
    const forbidden = [
      await req('POST', resultsUrl(beta.id, '/continue'), undefined, anaCookie),
      await req('DELETE', resultsUrl(beta.id), undefined, anaCookie),
    ]
    for (const r of forbidden) expect(r.statusCode).toBe(403)
    // Motor desconhecido e projeto inexistente.
    expect((await req('POST', resultsUrl(alfa.id, '/continue', 'nope'))).statusCode).toBe(400)
    expect((await req('DELETE', resultsUrl(9999))).statusCode).toBe(404)
  })

  it('continue no encerramento do serviço: 409 shutting_down, e o aviso fica', async () => {
    const id = pendingResult()
    inst.manager.beginShutdown()
    const res = await req('POST', resultsUrl(alfa.id, '/continue'))
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('shutting_down')
    expect(tasks().get(id)?.notify).toBe('pending')
  })

  it('DELETE com o goal esperando tarefas: o goal pausa por operador (R14)', async () => {
    pendingResult()
    store.startGoal(alfa.id, 'claude', 'esperar Beta')
    store.setGoalStatus(alfa.id, 'claude', 'waiting')
    const res = await req('DELETE', resultsUrl(alfa.id))
    expect(res.statusCode).toBe(200)
    expect(store.get(alfa.id, 'claude')).toMatchObject({ goalStatus: 'paused', goalPause: 'operator' })
    expect((await stateOf(alfa.id))?.goal).toMatchObject({ status: 'paused', pause: 'operator' })
    // Goal ativo (não esperando) não muda com o ×.
    store.startGoal(beta.id, 'claude', 'outro')
    const r2 = await req('DELETE', resultsUrl(beta.id))
    expect(r2.statusCode).toBe(200)
    expect(store.get(beta.id, 'claude').goalStatus).toBe('active')
  })

  it('DELETE sem nada pendente não pausa o goal esperando; no encerramento, 409 e o aviso fica', async () => {
    store.startGoal(alfa.id, 'claude', 'esperar Beta')
    store.setGoalStatus(alfa.id, 'claude', 'waiting')
    const res = await req('DELETE', resultsUrl(alfa.id))
    expect(res.statusCode).toBe(200)
    expect(store.get(alfa.id, 'claude').goalStatus).toBe('waiting')
    // Encerrando: o × é recusado como o Continuar, e nada muda.
    const id = pendingResult()
    inst.manager.beginShutdown()
    const r2 = await req('DELETE', resultsUrl(alfa.id))
    expect(r2.statusCode).toBe(409)
    expect(r2.json().code).toBe('shutting_down')
    expect(tasks().get(id)?.notify).toBe('pending')
    expect(store.get(alfa.id, 'claude').goalStatus).toBe('waiting')
  })

  it('a rota do limite devolve o estado decorado (com os resultados pendentes)', async () => {
    const id = pendingResult()
    store.recordUsageLimit(alfa.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) + 3600, origin: 'operator' })
    const res = await req('POST', `/api/projects/${alfa.id}/terminals/claude/limit`, { action: 'snooze' })
    expect(res.statusCode).toBe(200)
    expect(res.json().taskResults).toEqual([{ id, toProjectName: 'Beta', status: 'completed' }])
    expect(res.json().usageLimit).toMatchObject({ action: 'snoozed' })
  })
})

describe('subida', () => {
  it('startAfterListen: reinício → limite → aviso de tarefas → agendador', async () => {
    const order: string[] = []
    await startAfterListen({
      restart: { boot: async () => { order.push('reinício') } },
      limit: { boot: async () => { order.push('limite') } },
      taskWake: { boot: async () => { order.push('aviso') } },
      scheduler: { start: () => { order.push('agendador') } },
    })
    expect(order).toEqual(['reinício', 'limite', 'aviso', 'agendador'])

    // A falha de uma subida não impede as seguintes; o encerramento no meio para o resto.
    const logs: string[] = []
    order.length = 0
    await startAfterListen({
      restart: { boot: async () => { order.push('reinício') } },
      limit: { boot: async () => { order.push('limite') } },
      taskWake: { boot: async () => { order.push('aviso'); throw new Error('quebrou') } },
      scheduler: { start: () => { order.push('agendador') } },
      log: (m) => logs.push(m),
    })
    expect(order).toEqual(['reinício', 'limite', 'aviso', 'agendador'])
    expect(logs.some((m) => m.includes('quebrou'))).toBe(true)

    order.length = 0
    let down = false
    await startAfterListen({
      restart: { boot: async () => { order.push('reinício') } },
      limit: { boot: async () => { order.push('limite') } },
      taskWake: { boot: async () => { order.push('aviso'); down = true } },
      scheduler: { start: () => { order.push('agendador') } },
      isShuttingDown: () => down,
    })
    expect(order).toEqual(['reinício', 'limite', 'aviso'])
  })

  it('o aviso nasce no buildApp: limite adiado vencido na subida não entrega o resultado sozinho', async () => {
    // Antes da subida: retomar ligado, um resultado pendente e um limite adiado que venceu com o Claudinei fora.
    await shutdown(inst)
    store.setPrefs(alfa.id, 'claude', { autoResume: true })
    const id = pendingResult()
    store.recordUsageLimit(alfa.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) - 60, origin: 'operator' })
    store.setLimitAction(alfa.id, 'claude', 'snoozed')

    inst = await boot()
    await startAfterListen({ restart: inst.restart, limit: inst.limit, taskWake: inst.taskWake, scheduler: undefined })
    // A subida do limite limpou o adiado vencido...
    expect(store.get(alfa.id, 'claude').limitHitAt).toBeNull()
    await sleep(200)
    // ...e o resultado espera o terminal voltar a trabalhar: nada subiu, nada foi mandado.
    expect(tasks().get(id)?.notify).toBe('pending')
    expect(userTexts(inst)).toEqual([])
    expect(inst.manager.list().filter((s) => s.projectId === alfa.id && ['starting', 'idle', 'working'].includes(s.status))).toEqual([])
  })

  it('subida com aviso pendente e goal ativo: a retomada do reinício vai primeiro; aviso e continue só depois do turno dela', async () => {
    store.setPrefs(alfa.id, 'claude', { autoResume: true })
    const a = await startIdle(inst, alfa)
    // O operador manda um turno longo; o goal é ligado no meio dele (sem a partida, para o laço não girar antes).
    inst.manager.send(a, 'demorada até o reinício')
    await waitUntil(() => inst.manager.get(a)?.status === 'working')
    store.startGoal(alfa.id, 'claude', 'devagar reiniciar')
    const id = pendingResult('resultado de Beta')

    // O encerramento do serviço, como no SIGTERM de index.ts.
    expect(captureShutdown(inst.manager, store)).toBe(1)
    inst.limit?.dispose()
    await shutdown(inst)
    // O encerramento no meio do turno não pausa o goal (nem por erro, nem por interrupção).
    expect(store.get(alfa.id, 'claude')).toMatchObject({ goalStatus: 'active', goalPause: null, goalTurns: 0 })

    inst = await boot()
    await startAfterListen({ restart: inst.restart, limit: inst.limit, taskWake: inst.taskWake, scheduler: undefined })
    await waitUntil(() => userTexts(inst).some((t) => t.startsWith(`${GOAL_PREFIX}:`)))
    const local = inst.manager.list().find((s) => s.projectId === alfa.id)!.localId
    const texts = userTexts(inst, local)
    expect(texts[0].startsWith(RESUME_PREFIX)).toBe(true)
    expect(texts[1].startsWith(TASK_RESULT_PREFIX)).toBe(true)
    // A retomada e o aviso contaram como turnos do goal: o continue é o terceiro.
    expect(texts[2]).toBe(goalContinueText('devagar reiniciar', 3))
    expect(tasks().get(id)?.notify).toBe('delivered')
    // Cada um só depois do result do turno anterior.
    const events = eventsOf(inst, local)
    const resumeResult = resultAt(events, (t) => t.includes(RESUME_PREFIX))
    const notice = echoAt(events, (t) => t.startsWith(TASK_RESULT_PREFIX))
    const noticeResult = resultAt(events, (t) => t.includes(TASK_RESULT_PREFIX))
    const cont = echoAt(events, (t) => t.startsWith(`${GOAL_PREFIX}:`))
    expect(resumeResult).toBeGreaterThan(-1)
    expect(notice).toBeGreaterThan(resumeResult)
    expect(noticeResult).toBeGreaterThan(notice)
    expect(cont).toBeGreaterThan(noticeResult)
    // Encerra o laço pelo Hermes.
    expect((await req('POST', '/api/hermes/goal-done', { projectId: alfa.id, engine: 'claude', evidence: 'ok' })).statusCode).toBe(200)
  })

  it('com retomar desligado, aviso e continue seguram até o Continuar', async () => {
    initTardio = true
    // "Iniciar" ligado e "retomar" desligado: a subida revive a sessão e abre o aviso do reinício.
    const prev = randomUUID()
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES (?, ?, 'claude', 'stopped')`).run(prev, alfa.id)
    store.setPrefs(alfa.id, 'claude', { autostart: true, autoResume: false })
    store.markInterrupted(alfa.id, 'claude', prev, null)
    store.startGoal(alfa.id, 'claude', 'devagar segurar')
    const id = pendingResult()
    await startAfterListen({ restart: inst.restart, limit: inst.limit, taskWake: inst.taskWake, scheduler: undefined })
    expect(store.get(alfa.id, 'claude').holdReason).toBe('off')
    const local = inst.manager.list().find((s) => s.projectId === alfa.id)!.localId
    expect(inst.manager.get(local)?.status).toBe('starting')
    await sleep(150)
    // Aviso aberto: nem a retomada, nem o aviso de tarefa, nem o continue.
    expect(userTexts(inst, local)).toEqual([])
    expect(tasks().get(id)?.notify).toBe('pending')
    expect(store.get(alfa.id, 'claude').goalStatus).toBe('active')

    const res = await req('POST', `/api/projects/${alfa.id}/terminals/claude/continue`)
    expect(res.statusCode).toBe(200)
    await waitUntil(() => userTexts(inst, local).some((t) => t.startsWith(`${GOAL_PREFIX}:`)))
    const texts = userTexts(inst, local)
    expect(texts[0].startsWith(RESUME_PREFIX)).toBe(true)
    expect(texts[1].startsWith(TASK_RESULT_PREFIX)).toBe(true)
    expect(texts[2]).toBe(goalContinueText('devagar segurar', 3))
    expect((await req('POST', '/api/hermes/goal-done', { projectId: alfa.id, engine: 'claude', evidence: 'ok' })).statusCode).toBe(200)
  })
})
