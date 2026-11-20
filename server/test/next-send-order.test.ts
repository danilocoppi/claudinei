import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
import type { RestartService } from '../src/restart/boot.js'
import type { UsageLimitService } from '../src/limit/usage-limit.js'
import type { OrchestratorHooks } from '../src/routes/orchestrator.js'
import type { NextSend } from '../src/queue/next-send.js'
import type { OperatorQueueService } from '../src/queue/operator-queue.js'
import type { TaskWake } from '../src/delegate/task-wake.js'
import type { GoalService } from '../src/goal/goal.js'
import { createTasksService } from '../src/tasks.js'
import { TASK_RESULT_PREFIX } from '../src/delegate/texts.js'
import { GOAL_PREFIX, goalContinueText } from '../src/goal/texts.js'

/**
 * A ordem única do "próximo envio" com as três trilhas da onda B juntas: a fila
 * do operador (lugar 3, campo-e-fila), o aviso de resultado de tarefa delegada
 * (lugar 4) e o "continue" do goal (lugar 6, delegar-e-goals), no app real
 * (buildApp com o manager real e o CLI falso, os ganchos ligados como em
 * index.ts). Com os três esperando no mesmo terminal livre, cada fim de turno
 * entrega um só, nesta ordem; com o aviso do reinício aberto, nada sai.
 */
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = (cond: () => boolean, ms = 8000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let db: Db
let auth: AuthService
let store: TerminalStateStore
let alfa: Project, beta: Project
let cookies: Record<string, string>
let app: Awaited<ReturnType<typeof buildApp>>
let manager: SessionManager
let mgrBroadcasts: any[]
let limit: UsageLimitService | undefined

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  store = createTerminalStateStore(db)
  mgrBroadcasts = []
  // Os ganchos do manager leem as referências que o buildApp preenche, como em index.ts.
  let drain: OrchestratorHooks['drain'] | undefined
  let nextSend: NextSend | undefined
  let queue: OperatorQueueService | undefined
  let restart: RestartService | undefined
  let taskWake: TaskWake | undefined
  let goal: GoalService | undefined
  const both = (...calls: Array<() => void>) => { for (const c of calls) { try { c() } catch (err) { console.error(err) } } }
  manager = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m),
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
    onOperatorMessage: (projectId, engine, info) => both(
      () => restart?.onOperatorMessage(projectId, engine),
      () => limit?.onOperatorMessage(projectId, engine),
      () => goal?.onOperatorMessage(projectId, engine, info)),
    onUsageLimit: (projectId, engine, p) => limit?.onUsageLimit(projectId, engine, p),
    onSessionDied: (projectId, engine) => queue?.onSessionDied(projectId, engine),
    interceptCommand: (ctx, text) => goal?.command(ctx, text) ?? false,
  })
  app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: () => {}, register: () => {} } as never,
    onOrchestratorReady: (o) => { drain = o.drain },
    onNextSendReady: (n) => { nextSend = n },
    onQueueReady: (q) => { queue = q },
    onRestartReady: (r) => { restart = r },
    onLimitReady: (l) => { limit = l },
    onTaskWakeReady: (w) => { taskWake = w },
    onGoalReady: (g) => { goal = g },
  })
  const projects = createProjectsService(db)
  alfa = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'nso1-')) })
  beta = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'nso2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } })
  const c = login.cookies.find((x: any) => x.name === COOKIE_NAME)
  cookies = c ? { [COOKIE_NAME]: c.value } : {}
})

afterEach(async () => {
  manager.beginShutdown()
  limit?.dispose()
  await manager.stopAll()
  await app.close()
})

const req = (method: 'POST' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, cookies, ...(payload ? { payload } : {}) })

/** Textos que entraram no chat do terminal, na ordem (fila e Claudinei ecoam; o operador digitando, não). */
const userTexts = (localId: string) => mgrBroadcasts
  .filter((b) => b.type === 'session_event' && b.localId === localId && b.event?.kind === 'user')
  .map((b) => String(b.event.message?.content?.[0]?.text ?? ''))
  .filter((t) => t)
const eventsOf = (localId: string) =>
  mgrBroadcasts.filter((b) => b.type === 'session_event' && b.localId === localId).map((b) => b.event)
const echoAt = (events: any[], pred: (t: string) => boolean) =>
  events.findIndex((e) => e?.kind === 'user' && pred(String(e.message?.content?.[0]?.text ?? '')))
const resultAt = (events: any[], pred: (t: string) => boolean) =>
  events.findIndex((e) => e?.kind === 'result' && pred(String(e.resultText ?? '')))

describe('ordem única do próximo envio com as três trilhas', () => {
  it('fila do operador → aviso de resultado → continue do goal, um por fim de turno; nada com o aviso do reinício aberto', async () => {
    const tasks = createTasksService(db)
    const { localId: a } = manager.start(alfa)
    await waitUntil(() => manager.get(a)?.status === 'idle')
    await sleep(20)

    // O operador abre um turno longo (a pergunta segura o turno até ser dispensada).
    manager.send(a, 'faz-pergunta da origem')
    await waitUntil(() => manager.get(a)?.pendingQuestion !== undefined)

    // Durante ele, as três trilhas ficam esperando no mesmo terminal:
    // um item na fila do operador (lugar 3)...
    const added = await req('POST', `/api/projects/${alfa.id}/terminals/claude/queue`, { text: 'item da fila' })
    expect(added.statusCode).toBe(201)
    // ...o resultado de uma tarefa que Alfa delegou a Beta (lugar 4)...
    const { id: taskId } = tasks.create(alfa.id, beta.id, 'trabalho de Beta', 'in_progress', 'claude')
    tasks.setResult(taskId, 'completed', 'resultado de Beta')
    tasks.setNotify([taskId], 'pending')
    // ...e um goal ativo (lugar 6), ligado sem a partida para o laço não girar antes.
    store.startGoal(alfa.id, 'claude', 'ordem única')
    // E o aviso do reinício aberto, esperando o operador: segura os lugares 3 a 6.
    store.markInterrupted(alfa.id, 'claude', a, null)

    // O turno termina com o aviso aberto: a sessão fica livre e nada sai.
    manager.dismissQuestion(a)
    await waitUntil(() => eventsOf(a).some((e) => e?.kind === 'result') && manager.get(a)?.status !== 'working')
    await sleep(200)
    expect(userTexts(a)).toEqual([])
    expect((await app.inject({ method: 'GET', url: `/api/projects/${alfa.id}/terminals/claude/queue`, cookies })).json().items)
      .toHaveLength(1)
    expect(tasks.get(taskId)?.notify).toBe('pending')
    expect(store.get(alfa.id, 'claude')).toMatchObject({ goalStatus: 'active', goalTurns: 0 })

    // O operador fecha o aviso (×): a sessão livre recebe uma coisa por fim de turno.
    expect((await req('DELETE', `/api/projects/${alfa.id}/terminals/claude/interruption`)).statusCode).toBe(200)
    await waitUntil(() => userTexts(a).some((t) => t.startsWith(`${GOAL_PREFIX}:`)))
    const texts = userTexts(a)
    expect(texts[0]).toBe('item da fila')
    expect(texts[1].startsWith(TASK_RESULT_PREFIX)).toBe(true)
    // O item da fila não conta nem pausa o goal; o aviso (turno do Claudinei) conta: o continue é o 2.
    expect(texts[2]).toBe(goalContinueText('ordem única', 2))
    expect(tasks.get(taskId)?.notify).toBe('delivered')

    // Um por turno: cada envio só depois do result do turno anterior.
    const events = eventsOf(a)
    const item = echoAt(events, (t) => t === 'item da fila')
    const itemResult = resultAt(events, (t) => t.includes('item da fila'))
    const notice = echoAt(events, (t) => t.startsWith(TASK_RESULT_PREFIX))
    const noticeResult = resultAt(events, (t) => t.includes(TASK_RESULT_PREFIX))
    const cont = echoAt(events, (t) => t.startsWith(`${GOAL_PREFIX}:`))
    expect(item).toBeGreaterThan(-1)
    expect(itemResult).toBeGreaterThan(item)
    expect(notice).toBeGreaterThan(itemResult)
    expect(noticeResult).toBeGreaterThan(notice)
    expect(cont).toBeGreaterThan(noticeResult)

    // Encerra o laço pelo Hermes.
    expect((await req('POST', '/api/hermes/goal-done', { projectId: alfa.id, engine: 'claude', evidence: 'ok' })).statusCode).toBe(200)
  })
})
