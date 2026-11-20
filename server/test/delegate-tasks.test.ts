import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager, TASK_INTERRUPTED_TEXT } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { registerOrchestratorRoutes, type OrchestratorHooks } from '../src/routes/orchestrator.js'
import { createTasksService, type TasksService } from '../src/tasks.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { createNextSend } from '../src/queue/next-send.js'
import { createOperatorQueueService, createOperatorQueueStore } from '../src/queue/operator-queue.js'
import '../src/engine/index.js'

// Tarefa delegada sem prazo e o estado do aviso de resultado na linha da tarefa
// (trilha "Delegar e ser acordado + Goals", tarefa 1).

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

// setInterval fica de verdade: só setTimeout/clearTimeout são falsos nos testes
// com relógio, então esta espera continua andando.
const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

let db: Db
let origem: Project
let destino: Project
let tasks: TasksService
let mgr: ReturnType<typeof createSessionManager>
let orchestrator: OrchestratorHooks

beforeEach(async () => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  origem = projects.create({ name: 'Origem', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  destino = projects.create({ name: 'Destino', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  tasks = createTasksService(db)
  mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
  const app = Fastify()
  orchestrator = registerOrchestratorRoutes(app, { db, manager: mgr })
})

afterEach(async () => {
  vi.useRealTimers()
  await mgr.stopAll()
})

const startIdle = async (project: Project) => {
  const { localId } = mgr.start(project, {})
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  return localId
}

describe('tarefa delegada sem prazo', () => {
  it('tarefa sem prazo: o turno longo do destino não fecha a tarefa sozinho', async () => {
    const localId = await startIdle(destino)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // "demorada": o fake responde mas nunca emite o result; o turno segue aberto.
    const { id } = tasks.create(origem.id, destino.id, 'demorada', 'queued', 'claude')
    expect(orchestrator.drain(destino.id)).toBe(true)
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    vi.advanceTimersByTime(11 * 60_000)
    await new Promise((r) => setImmediate(r))
    expect(tasks.get(id)?.status).toBe('in_progress')
    expect(tasks.get(id)?.result).toBeNull()
  })

  it('tarefa religada (watchTurn) também não tem prazo', async () => {
    const localId = await startIdle(destino)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cb = vi.fn()
    expect(mgr.watchTurn(localId, cb)).toBe(true)
    mgr.sendAsClaudinei(localId, 'demorada')
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    vi.advanceTimersByTime(11 * 60_000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('destino que morre continua fechando a tarefa como failed', async () => {
    await startIdle(destino)
    const { id } = tasks.create(origem.id, destino.id, 'crash', 'queued', 'claude')
    expect(orchestrator.drain(destino.id)).toBe(true)
    await waitUntil(() => tasks.get(id)?.status === 'failed')
    expect(tasks.get(id)?.result).toBe('target agent exited')
  })

  it('quem passa um prazo explícito ainda tem o prazo', async () => {
    const localId = await startIdle(destino)
    const calls: [string, string][] = []
    mgr.dispatchTask(destino.id, 'Origem', 'devagar', (s, r) => calls.push([s, r]), 50)
    await waitUntil(() => calls.length > 0)
    expect(calls[0]).toEqual(['failed', 'timed out'])
    await waitUntil(() => mgr.get(localId)?.status === 'needs_attention')
  })
})

/**
 * Sessão como a do Kimi e a do OpenCode: o interrupt() resolve na hora, e o
 * turno interrompido fecha DEPOIS, indo a idle sem nenhum result.
 */
class TurnBasedStub extends EventEmitter {
  status = 'starting'
  sessionId?: string
  lastStderr = ''
  sent: string[] = []
  start() { this.set('idle') }
  send(text: string) { this.sent.push(text); this.set('working') }
  markRead() {}
  interrupt() { return Promise.resolve() }
  /** O processo do turno interrompido saiu: idle, sem result. */
  closeInterrupted() { this.set('idle') }
  finish() {
    this.emit('event', { kind: 'result', subtype: 'success', isError: false, resultText: 'feito', costUsd: 0, raw: {} })
    this.set('needs_attention')
  }
  setModel() { return Promise.resolve() }
  setPermissionMode() { return Promise.resolve() }
  setEffort() { return Promise.resolve() }
  stop() { this.set('stopped'); return Promise.resolve() }
  set(s: string) { if (s !== this.status) { this.status = s; this.emit('status', s) } }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('turno do destino interrompido pelo operador (R18)', () => {
  it('Esc no turno da tarefa (Claude, com result) fecha como failed com o texto da interrupção', async () => {
    const localId = await startIdle(destino)
    const { id } = tasks.create(origem.id, destino.id, 'demorada', 'queued', 'claude')
    expect(orchestrator.drain(destino.id)).toBe(true)
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    await mgr.interrupt(localId)
    await waitUntil(() => tasks.get(id)?.status !== 'in_progress')
    expect(tasks.get(id)).toMatchObject({ status: 'failed', result: TASK_INTERRUPTED_TEXT })
  })

  it('Esc com o serviço encerrando não fecha a tarefa: ela fica para ser religada', async () => {
    const localId = await startIdle(destino)
    const { id } = tasks.create(origem.id, destino.id, 'demorada', 'queued', 'claude')
    expect(orchestrator.drain(destino.id)).toBe(true)
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    mgr.beginShutdown()
    await mgr.interrupt(localId)
    await waitUntil(() => mgr.get(localId)?.status !== 'working')
    await new Promise((r) => setTimeout(r, 100))
    expect(tasks.get(id)).toMatchObject({ status: 'in_progress', result: null })
  })

  it('turno interrompido sem result (Kimi, OpenCode): failed, e o turno seguinte não toca a tarefa', async () => {
    const stub = new TurnBasedStub()
    const m = createSessionManager({ db, sessionFactory: () => stub as never, broadcast: () => {} })
    const { localId } = m.start(destino, { engine: 'kimi' })
    await tick()
    const done: [string, string][] = []
    expect(m.dispatchTask(destino.id, 'Origem', 'trabalho', (s, r) => done.push([s, r]))).toBe('kimi')
    await m.interrupt(localId)
    await tick()
    expect(done).toEqual([])
    stub.closeInterrupted()
    await tick()
    expect(done).toEqual([['failed', TASK_INTERRUPTED_TEXT]])
    // O turno seguinte, sem relação com a tarefa, não a fecha de novo.
    m.send(localId, 'outro')
    stub.finish()
    await tick()
    expect(done).toHaveLength(1)
    await m.stopAll()
  })

  it('encerramento durante a interrupção sem result não fecha a tarefa (religada depois)', async () => {
    const stub = new TurnBasedStub()
    const m = createSessionManager({ db, sessionFactory: () => stub as never, broadcast: () => {} })
    const { localId } = m.start(destino, { engine: 'kimi' })
    await tick()
    const done: [string, string][] = []
    m.dispatchTask(destino.id, 'Origem', 'trabalho', (s, r) => done.push([s, r]))
    m.beginShutdown()
    await m.interrupt(localId)
    stub.closeInterrupted()
    await tick()
    await m.stop(localId)
    await tick()
    expect(done).toEqual([])
  })

  it('enviar agora no destino (motor sem mensagem no meio do turno): o item da fila vai primeiro e a tarefa fecha como failed', async () => {
    const stub = new TurnBasedStub()
    let arbiter: ReturnType<typeof createNextSend> | undefined
    let queue: ReturnType<typeof createOperatorQueueService> | undefined
    const m = createSessionManager({
      db, sessionFactory: () => stub as never, broadcast: () => {},
      onSessionAvailable: (projectId, ctx) => { if (ctx) arbiter?.onSessionAvailable({ projectId, ...ctx }) },
      onTurnResult: (projectId, engine, info) => queue?.onTurnResult(projectId, engine, info),
    })
    const app = Fastify()
    const orch = registerOrchestratorRoutes(app, { db, manager: m })
    const liveLocalId = (projectId: number, engine: string) =>
      m.list().find((s) => s.projectId === projectId && s.engine === engine && ['starting', 'idle', 'working', 'needs_attention'].includes(s.status))?.localId ?? null
    queue = createOperatorQueueService({
      store: createOperatorQueueStore(db), manager: m, broadcast: () => {}, holds: () => false,
      acceptsMidTurn: () => false, liveLocalId, isShuttingDown: () => m.isShuttingDown(),
    })
    arbiter = createNextSend({
      providers: [
        { name: 'operator-queue', slot: 3, offer: (ctx) => queue!.offer(ctx) },
        { name: 'agent-tasks', slot: 5, offer: (ctx) => orch.drain(ctx.projectId, ctx.localId) },
      ],
      holds: () => false,
      isFree: (localId) => { const s = m.get(localId); return !!s && m.hasFreeSession(s.projectId, { localId }) },
      liveLocalId,
      log: () => {},
    })
    const { localId } = m.start(destino, { engine: 'kimi' })
    await tick()
    const { id } = tasks.create(origem.id, destino.id, 'trabalho', 'queued', 'claude')
    expect(orch.drain(destino.id)).toBe(true)
    // Outra tarefa espera na fila do orchestrator: não pode passar na frente do item.
    const outra = tasks.create(origem.id, destino.id, 'outra', 'queued', 'claude').id
    const dto = queue.add(destino.id, 'kimi', 'urgente')
    queue.sendNow(dto.items[0].id)
    await tick()
    stub.closeInterrupted()
    await waitUntil(() => tasks.get(id)?.status !== 'in_progress')
    await new Promise((r) => setImmediate(r))
    expect(tasks.get(id)).toMatchObject({ status: 'failed', result: TASK_INTERRUPTED_TEXT })
    expect(stub.sent).toEqual(['[Task from Origem]: trabalho', 'urgente'])
    expect(tasks.get(outra)?.status).toBe('queued')
    await m.stopAll()
    await app.close()
  })
})

describe('estado do aviso de resultado na tarefa', () => {
  it('setNotify e pendingNotifyFor por origem e motor', () => {
    const a = tasks.create(origem.id, destino.id, 'a', 'queued', 'claude').id
    const b = tasks.create(origem.id, destino.id, 'b', 'queued', 'codex').id
    const c = tasks.create(origem.id, destino.id, 'c', 'queued', null).id
    const d = tasks.create(origem.id, destino.id, 'd', 'queued', 'claude').id
    const e = tasks.create(destino.id, origem.id, 'e', 'queued', 'claude').id
    const semOrigem = tasks.create(null, destino.id, 'f').id

    // Tarefa nova (ou antiga, de antes da coluna) não tem estado de aviso.
    expect(tasks.get(a)?.notify).toBeNull()
    expect(tasks.get(semOrigem)?.notify).toBeNull()
    expect(tasks.pendingNotifyFor(origem.id, 'claude')).toEqual([])

    tasks.setNotify([d, a, b, c, e], 'pending')
    expect(tasks.get(a)?.notify).toBe('pending')
    // Por origem + motor, na ordem do id.
    expect(tasks.pendingNotifyFor(origem.id, 'claude').map((t) => t.id)).toEqual([a, d])
    expect(tasks.pendingNotifyFor(origem.id, 'codex').map((t) => t.id)).toEqual([b])
    // fromEngine nulo: só as tarefas sem motor de origem.
    expect(tasks.pendingNotifyFor(origem.id, null).map((t) => t.id)).toEqual([c])
    expect(tasks.pendingNotifyFor(destino.id, 'claude').map((t) => t.id)).toEqual([e])
    expect(tasks.allPendingNotify().map((t) => t.id)).toEqual([a, b, c, d, e])

    tasks.setNotify([a], 'delivered')
    tasks.setNotify([d], 'dismissed')
    tasks.setNotify([semOrigem], 'none')
    tasks.setNotify([], 'delivered') // lista vazia não quebra
    expect(tasks.get(a)?.notify).toBe('delivered')
    expect(tasks.get(d)?.notify).toBe('dismissed')
    expect(tasks.get(semOrigem)?.notify).toBe('none')
    expect(tasks.pendingNotifyFor(origem.id, 'claude')).toEqual([])
    expect(tasks.allPendingNotify().map((t) => t.id)).toEqual([b, c, e])
    expect(tasks.list().find((t) => t.id === b)?.notify).toBe('pending')
  })

  it('openFrom conta queued e in_progress da origem', () => {
    expect(tasks.openFrom(origem.id, 'claude')).toBe(0)
    const q = tasks.create(origem.id, destino.id, 'q', 'queued', 'claude').id
    const p = tasks.create(origem.id, destino.id, 'p', 'queued', 'claude').id
    tasks.markInProgress(p)
    const feita = tasks.create(origem.id, destino.id, 'feita', 'queued', 'claude').id
    tasks.setResult(feita, 'completed', 'ok')
    const falha = tasks.create(origem.id, destino.id, 'falha', 'queued', 'claude').id
    tasks.setResult(falha, 'failed', 'x')
    tasks.create(origem.id, destino.id, 'outro motor', 'queued', 'codex')
    tasks.create(origem.id, destino.id, 'sem motor', 'queued', null)
    tasks.create(destino.id, origem.id, 'outra origem', 'queued', 'claude')
    tasks.create(null, destino.id, 'sem origem')
    expect(tasks.openFrom(origem.id, 'claude')).toBe(2)
    expect(tasks.openFrom(origem.id, 'codex')).toBe(1)
    tasks.setResult(q, 'completed', 'ok')
    expect(tasks.openFrom(origem.id, 'claude')).toBe(1)
  })

  it('a coluna notify sobrevive a reabrir o banco (migração idempotente)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-db-'))
    const file = join(dir, 'c.db')
    const db1 = openDb(file)
    const p = createProjectsService(db1).create({ name: 'X', path: dir })
    const svc1 = createTasksService(db1)
    const { id } = svc1.create(p.id, p.id, 't', 'queued', 'claude')
    svc1.setNotify([id], 'pending')
    db1.close()
    const db2 = openDb(file)
    expect(createTasksService(db2).get(id)?.notify).toBe('pending')
    db2.close()
  })
})
