import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createSchedulesStore } from '../src/schedules/store.js'
import { createScheduler } from '../src/schedules/scheduler.js'
import { usageLimitFailText, USAGE_LIMIT_FAIL_PREFIX } from '../src/limit/texts.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import '../src/engine/index.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const sessions: ClaudeSession[] = []
const fakeFactory = (opts: SessionOptions) => {
  const s = new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
  sessions.push(s)
  return s
}

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})

let db: Db
let project: Project
let mgr: ReturnType<typeof createSessionManager>
const onUsageLimit = vi.fn()
const onTurnResult = vi.fn()
let lastRejected: number | null = null

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  onUsageLimit.mockReset()
  onTurnResult.mockReset()
  lastRejected = null
  sessions.length = 0
  mgr = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: () => {}, onUsageLimit, onTurnResult,
    lastRejectedResetsAt: () => lastRejected,
  })
})

afterEach(async () => { await mgr.stopAll() })

const startIdle = async () => {
  const { localId } = mgr.start(project, {})
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  return localId
}
const turnDone = (localId: string) => waitUntil(() => mgr.get(localId)?.status !== 'working')
const nowSec = () => Math.floor(Date.now() / 1000)

describe('detecção do limite na sessão do Claude', () => {
  it('limite com evento: onUsageLimit recebe resetsAt do evento e origem operator', async () => {
    lastRejected = 42 // o evento do turno manda; o uso guardado é só o recurso
    const localId = await startIdle()
    const antes = nowSec()
    mgr.send(localId, 'limite')
    await waitUntil(() => onUsageLimit.mock.calls.length === 1)
    const depois = nowSec()
    const [pid, engine, p] = onUsageLimit.mock.calls[0]
    expect(pid).toBe(project.id)
    expect(engine).toBe('claude')
    expect(p.localId).toBe(localId)
    expect(p.origin).toBe('operator')
    expect(p.resetsAt).toBeGreaterThanOrEqual(antes + 60)
    expect(p.resetsAt).toBeLessThanOrEqual(depois + 60)
  })

  it('limite só pelo texto: resetsAt vem de lastRejectedResetsAt', async () => {
    lastRejected = 1_900_000_000
    const localId = await startIdle()
    mgr.send(localId, 'limite-sem-evento')
    await waitUntil(() => onUsageLimit.mock.calls.length === 1)
    expect(onUsageLimit.mock.calls[0][2]).toEqual({ localId, resetsAt: 1_900_000_000, origin: 'operator' })
  })

  it('limite só pelo texto e sem horário conhecido: resetsAt null', async () => {
    const localId = await startIdle()
    mgr.send(localId, 'limite-sem-evento')
    await waitUntil(() => onUsageLimit.mock.calls.length === 1)
    expect(onUsageLimit.mock.calls[0][2]).toEqual({ localId, resetsAt: null, origin: 'operator' })
  })

  it('origem: tarefa encaminhada → task; sendAsClaudinei → claudinei; agendamento → schedule', async () => {
    const localId = await startIdle()
    mgr.dispatchTask(project.id, 'Origem', 'limite', () => {})
    await waitUntil(() => onUsageLimit.mock.calls.length === 1)
    await turnDone(localId)

    mgr.sendAsClaudinei(localId, 'limite')
    await waitUntil(() => onUsageLimit.mock.calls.length === 2)
    await turnDone(localId)

    await expect(mgr.sendAndWait(localId, 'limite')).rejects.toThrow(USAGE_LIMIT_FAIL_PREFIX)
    expect(onUsageLimit.mock.calls.map((c) => c[2].origin)).toEqual(['task', 'claudinei', 'schedule'])
  })

  it('tarefa encaminhada que bate no limite fecha failed com o texto do limite e a hora', async () => {
    await startIdle()
    const onComplete = vi.fn()
    mgr.dispatchTask(project.id, 'Origem', 'limite', onComplete)
    await waitUntil(() => onComplete.mock.calls.length === 1)
    const resetsAt = onUsageLimit.mock.calls[0][2].resetsAt as number
    const d = new Date(resetsAt * 1000)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(onComplete).toHaveBeenCalledWith('failed', `limite de uso do Claude — a janela reabre às ${hhmm}`)
    expect(onComplete.mock.calls[0][1]).toBe(usageLimitFailText(resetsAt))
  })

  it('ask_agent recebe o texto do limite como erro', async () => {
    lastRejected = 1_900_000_000
    await startIdle()
    await expect(mgr.askAgent(project.id, 'Origem', 'limite-sem-evento')).rejects.toThrow(usageLimitFailText(1_900_000_000))
  })

  it('agendamento que bate no limite: error sem contar falha seguida', async () => {
    const store = createSchedulesStore(db, { dir: mkdtempSync(join(tmpdir(), 'sched-')) })
    const s = store.create(project.id, { name: 'Lote', task: 'limite-sem-evento', cadence: { kind: 'daily', at: '12:00' } })
    db.prepare(`UPDATE schedules SET consecutive_failures=1 WHERE id=?`).run(s.id)
    await startIdle()
    await createScheduler({ db, store, manager: mgr }).runNow(s.id)
    const [run] = store.listRuns(s.id, 1)
    expect(run.status).toBe('error')
    expect(run.error).toBe(USAGE_LIMIT_FAIL_PREFIX)
    expect(store.get(s.id)!.consecutiveFailures).toBe(1)
    expect(onUsageLimit.mock.calls[0][2].origin).toBe('schedule')
  })

  it('só o assistant de erro de API casa o texto e o result falha com outro texto: liga o limite', async () => {
    const localId = await startIdle()
    const session = sessions[0]
    mgr.send(localId, 'limite-so-assistant')
    await waitUntil(() => onTurnResult.mock.calls.length === 1)
    expect(onTurnResult).toHaveBeenLastCalledWith(project.id, 'claude', { isError: true })
    expect(onUsageLimit).toHaveBeenCalledTimes(1)
    expect(onUsageLimit.mock.calls[0][2]).toEqual({ localId, resetsAt: null, origin: 'operator' })
    expect(session.usageLimit).toEqual({ resetsAt: null })
  })

  it('assistant casa o texto, mas o turno termina bem: sem limite e quem espera recebe a resposta', async () => {
    lastRejected = 1_900_000_000 // nem o horário guardado pode ressuscitar o limite
    await startIdle()
    const session = sessions[0]
    await expect(mgr.askAgent(project.id, 'Origem', 'limite-recuperado')).resolves.toBe('resposta final')
    expect(onUsageLimit).not.toHaveBeenCalled()
    expect(session.usageLimit).toBeUndefined()
  })

  it('turno comum não liga o limite; o limite zera no send seguinte', async () => {
    const localId = await startIdle()
    const session = sessions[0]
    mgr.send(localId, 'oi')
    await waitUntil(() => onTurnResult.mock.calls.length === 1)
    await turnDone(localId)
    expect(session.usageLimit).toBeUndefined()

    // Erro comum (result error_during_execution) sem evento rejeitado também não liga.
    mgr.send(localId, 'pergunta-abandonada')
    await waitUntil(() => onTurnResult.mock.calls.length === 2)
    expect(onTurnResult).toHaveBeenLastCalledWith(project.id, 'claude', { isError: true })
    expect(session.usageLimit).toBeUndefined()

    await turnDone(localId)
    mgr.send(localId, 'limite')
    await waitUntil(() => onTurnResult.mock.calls.length === 3)
    expect(session.usageLimit?.resetsAt).toBeGreaterThan(nowSec())

    await turnDone(localId)
    mgr.send(localId, 'oi de novo')
    expect(session.usageLimit).toBeUndefined()
    await waitUntil(() => onTurnResult.mock.calls.length === 4)
    expect(session.usageLimit).toBeUndefined()
    expect(onUsageLimit).toHaveBeenCalledTimes(1)
  })

  it('onTurnResult recebe isError', async () => {
    const localId = await startIdle()
    mgr.send(localId, 'oi')
    await waitUntil(() => onTurnResult.mock.calls.length === 1)
    expect(onTurnResult).toHaveBeenLastCalledWith(project.id, 'claude', { isError: false })
    await turnDone(localId)
    mgr.send(localId, 'limite')
    await waitUntil(() => onTurnResult.mock.calls.length === 2)
    expect(onTurnResult).toHaveBeenLastCalledWith(project.id, 'claude', { isError: true })
    // O limite é avisado antes do fim do turno: o serviço registra e só depois o result decide.
    expect(onUsageLimit.mock.invocationCallOrder[0]).toBeLessThan(onTurnResult.mock.invocationCallOrder[1])
  })
})
