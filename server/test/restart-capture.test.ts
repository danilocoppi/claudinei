import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import { createSchedulesStore } from '../src/schedules/store.js'
import { createTerminalStateStore, RESTART_FAIL_TEXT, type TerminalStateStore } from '../src/restart/terminal-state.js'
import { captureShutdown } from '../src/restart/capture.js'
import type { OrchestratorHooks } from '../src/routes/orchestrator.js'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

let db: Db
let mgr: ReturnType<typeof createSessionManager>
let store: TerminalStateStore
let p1: Project
let p2: Project

const newProject = (name: string) =>
  createProjectsService(db).create({ name, path: mkdtempSync(join(tmpdir(), 'cap-')) })

beforeEach(() => {
  db = openDb(':memory:')
  mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
  store = createTerminalStateStore(db)
  p1 = newProject('P1')
  p2 = newProject('P2')
})

afterEach(async () => { await mgr.stopAll() })

const startIdle = async (project: Project) => {
  const { localId } = mgr.start(project, {})
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  return localId
}

describe('captureShutdown', () => {
  it('marca só quem estava trabalhando', async () => {
    const working = await startIdle(p1)
    await startIdle(p2)
    mgr.send(working, 'demorada')
    await waitUntil(() => mgr.get(working)?.status === 'working')

    expect(captureShutdown(mgr, store)).toBe(1)
    expect(mgr.isShuttingDown()).toBe(true)
    const marcada = store.get(p1.id, 'claude')
    expect(marcada.interruptedAt).not.toBeNull()
    expect(marcada.interruptedLocalId).toBe(working)
    expect(marcada.lostQuestion).toBeNull()
    expect(store.get(p2.id, 'claude').interruptedAt).toBeNull()
  })

  it('leva a pergunta aberta', async () => {
    const localId = await startIdle(p1)
    mgr.send(localId, 'faz-pergunta')
    await waitUntil(() => !!mgr.get(localId)?.pendingQuestion)

    expect(captureShutdown(mgr, store)).toBe(1)
    const row = store.get(p1.id, 'claude')
    expect(row.lostQuestion?.[0].question).toBe('Qual cor você prefere?')
  })
})

describe('agendamentos no reinício', () => {
  it('closeInterruptedRuns destrava o agendamento', () => {
    const schedules = createSchedulesStore(db, { dir: mkdtempSync(join(tmpdir(), 'cap-sch-')) })
    const s = schedules.create(p1.id, { name: 'Preços', task: 'buscar', cadence: { kind: 'daily', at: '12:00' } })
    const run = schedules.startRun(s.id, {})
    expect(schedules.hasRunning(s.id)).toBe(true)

    expect(schedules.closeInterruptedRuns()).toBe(1)
    expect(schedules.hasRunning(s.id)).toBe(false)
    const [fechada] = schedules.listRuns(s.id)
    expect(fechada.id).toBe(run.id)
    expect(fechada.status).toBe('error')
    expect(fechada.error).toBe(RESTART_FAIL_TEXT)
    expect(fechada.finishedAt).not.toBeNull()
    // Mesmo formato do finishRun (ISO), para a tela calcular a duração.
    expect(new Date(fechada.finishedAt!).toISOString()).toBe(fechada.finishedAt)
    // Nada mais aberto: rodar de novo não toca em nada.
    expect(schedules.closeInterruptedRuns()).toBe(0)
  })
})

describe('tarefas encaminhadas no reinício', () => {
  it('inProgressFor e listInProgress acham só as tarefas em andamento', () => {
    const tasks = createTasksService(db)
    const a = tasks.create(p2.id, p1.id, 'a', 'in_progress').id
    tasks.setToEngine(a, 'claude')
    const b = tasks.create(p2.id, p1.id, 'b', 'in_progress').id
    tasks.setToEngine(b, 'codex')
    tasks.create(p2.id, p1.id, 'c', 'queued')
    const d = tasks.create(p2.id, p1.id, 'd', 'in_progress').id
    tasks.setToEngine(d, 'claude')
    tasks.setResult(d, 'completed', 'ok')

    expect(tasks.inProgressFor(p1.id, 'claude').map((t) => t.id)).toEqual([a])
    expect(tasks.inProgressFor(p1.id, 'codex').map((t) => t.id)).toEqual([b])
    expect(tasks.inProgressFor(p2.id, 'claude')).toEqual([])
    expect(tasks.listInProgress().map((t) => t.id)).toEqual([a, b])
  })

  const buildWithOrchestrator = async () => {
    const broadcasts: any[] = []
    let orch: OrchestratorHooks | undefined
    await buildApp({
      config: loadConfig({}), db, manager: mgr,
      wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as any,
      onOrchestratorReady: (o) => { orch = o },
    })
    return { orch: orch!, broadcasts }
  }

  it('reattach fecha a tarefa como concluída no fim do turno', async () => {
    const { orch, broadcasts } = await buildWithOrchestrator()
    const tasks = createTasksService(db)
    const { id } = tasks.create(p2.id, p1.id, 'faça algo', 'in_progress')
    const localId = await startIdle(p1)

    expect(orch.reattach(id, localId)).toBe(true)
    mgr.sendAsClaudinei(localId, 'oi')
    await waitUntil(() => tasks.get(id)?.status === 'completed')
    expect(tasks.get(id)?.result).toBe('eco: oi')
    expect(broadcasts.some((b) => b.type === 'task_update' && b.task.id === id && b.task.status === 'completed')).toBe(true)
  })

  it('reattach devolve false se a sessão não está viva ou a tarefa não está em andamento', async () => {
    const { orch } = await buildWithOrchestrator()
    const tasks = createTasksService(db)
    const { id } = tasks.create(p2.id, p1.id, 'faça algo', 'in_progress')
    expect(orch.reattach(id, 'nao-existe')).toBe(false)

    const localId = await startIdle(p1)
    tasks.setResult(id, 'completed', 'já foi')
    expect(orch.reattach(id, localId)).toBe(false)
    expect(orch.reattach(9999, localId)).toBe(false)
  })

  it('failInterrupted fecha como falha com o texto do reinício', async () => {
    const { orch, broadcasts } = await buildWithOrchestrator()
    const tasks = createTasksService(db)
    const { id } = tasks.create(p2.id, p1.id, 'faça algo', 'in_progress')

    orch.failInterrupted(id)
    const t = tasks.get(id)!
    expect(t.status).toBe('failed')
    expect(t.result).toBe(RESTART_FAIL_TEXT)
    expect(broadcasts.some((b) => b.type === 'task_update' && b.task.id === id && b.task.status === 'failed')).toBe(true)

    // Tarefa que já fechou guarda o próprio resultado.
    const done = tasks.create(p2.id, p1.id, 'outra', 'in_progress').id
    tasks.setResult(done, 'completed', 'pronto')
    orch.failInterrupted(done)
    expect(tasks.get(done)).toMatchObject({ status: 'completed', result: 'pronto' })
  })
})
