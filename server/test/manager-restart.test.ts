import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { RESTART_FAIL_TEXT } from '../src/restart/terminal-state.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
let project: Project
let mgr: ReturnType<typeof createSessionManager>
const onTurnResult = vi.fn()
const onOperatorMessage = vi.fn()

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  onTurnResult.mockReset()
  onOperatorMessage.mockReset()
  mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {}, onTurnResult, onOperatorMessage })
})

afterEach(async () => { await mgr.stopAll() })

const startIdle = async () => {
  const { localId } = mgr.start(project, {})
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  return localId
}

const pendingQuestionOf = (localId: string) =>
  (db.prepare('SELECT pending_question FROM sessions WHERE local_id=?').get(localId) as { pending_question: string | null }).pending_question

describe('manager no reinício do serviço', () => {
  it('pergunta pendente vai ao banco e sai quando respondida', async () => {
    const localId = await startIdle()
    mgr.send(localId, 'faz-pergunta')
    await waitUntil(() => pendingQuestionOf(localId) !== null)
    const gravada = JSON.parse(pendingQuestionOf(localId)!)
    expect(gravada).toHaveLength(2)
    expect(gravada[0].question).toBe('Qual cor você prefere?')

    mgr.answerQuestion(localId, { 'Qual cor você prefere?': 'Verde', 'Quais frutas você gosta?': 'Banana' })
    await waitUntil(() => pendingQuestionOf(localId) === null)
  })

  it('no encerramento, a pergunta gravada fica no banco mesmo com o processo saindo', async () => {
    const localId = await startIdle()
    mgr.send(localId, 'faz-pergunta')
    await waitUntil(() => pendingQuestionOf(localId) !== null)
    mgr.beginShutdown()
    await mgr.stopAll()
    expect(pendingQuestionOf(localId)).not.toBeNull()
  })

  it('no encerramento, a tarefa encaminhada não fecha como falha', async () => {
    await startIdle()
    const onComplete = vi.fn()
    expect(mgr.dispatchTask(project.id, 'Origem', 'demorada', onComplete)).toBe('claude')
    await waitUntil(() => mgr.list()[0]?.status === 'working')
    mgr.beginShutdown()
    expect(mgr.isShuttingDown()).toBe(true)
    await mgr.stopAll()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('no encerramento, quem espera o turno recebe o texto do reinício', async () => {
    const localId = await startIdle()
    const waited = mgr.sendAndWait(localId, 'demorada')
    await waitUntil(() => mgr.get(localId)?.status === 'working')
    mgr.beginShutdown()
    await mgr.stopAll()
    await expect(waited).rejects.toThrow(RESTART_FAIL_TEXT)
  })

  it('watchTurn fecha com o result do turno', async () => {
    const localId = await startIdle()
    const cb = vi.fn()
    expect(mgr.watchTurn(localId, cb)).toBe(true)
    mgr.sendAsClaudinei(localId, 'oi')
    await waitUntil(() => cb.mock.calls.length > 0)
    expect(cb).toHaveBeenCalledWith('completed', 'eco: oi')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('watchTurn devolve false para sessão que não está viva', () => {
    expect(mgr.watchTurn('nao-existe', vi.fn())).toBe(false)
  })

  it('sendAsClaudinei não conta como mensagem do operador; send conta', async () => {
    const localId = await startIdle()
    mgr.sendAsClaudinei(localId, 'oi')
    await waitUntil(() => onTurnResult.mock.calls.length === 1)
    expect(onOperatorMessage).not.toHaveBeenCalled()

    mgr.send(localId, 'oi de novo')
    expect(onOperatorMessage).toHaveBeenCalledTimes(1)
    expect(onOperatorMessage).toHaveBeenCalledWith(project.id, 'claude', { queued: false, localId, text: 'oi de novo' })
  })

  it('send com echo repassa echoToClients à sessão e conta como mensagem do operador', async () => {
    let session: ClaudeSession | undefined
    const echoMgr = createSessionManager({
      db,
      sessionFactory: (opts: SessionOptions) => (session = fakeFactory(opts)),
      broadcast: () => {},
      onOperatorMessage,
    })
    const { localId } = echoMgr.start(project, {})
    await waitUntil(() => echoMgr.get(localId)?.status === 'idle')
    const spy = vi.spyOn(session!, 'send')
    echoMgr.send(localId, 'da fila', { echo: true })
    expect(spy).toHaveBeenLastCalledWith('da fila', { echoToClients: true })
    expect(onOperatorMessage).toHaveBeenCalledWith(project.id, 'claude', { queued: false, localId, text: 'da fila' })
    await waitUntil(() => echoMgr.get(localId)?.status !== 'working')
    // Sem a opção, a chamada à sessão continua a de sempre.
    echoMgr.send(localId, 'normal')
    expect(spy).toHaveBeenLastCalledWith('normal')
    await echoMgr.stopAll()
  })

  it('onTurnResult dispara a cada result', async () => {
    const localId = await startIdle()
    mgr.send(localId, 'um')
    await waitUntil(() => onTurnResult.mock.calls.length === 1)
    await waitUntil(() => mgr.get(localId)?.status !== 'working')
    mgr.send(localId, 'dois')
    await waitUntil(() => onTurnResult.mock.calls.length === 2)
    expect(onTurnResult).toHaveBeenNthCalledWith(1, project.id, 'claude', { isError: false, interrupted: false, limited: false, origin: 'operator' })
    expect(onTurnResult).toHaveBeenNthCalledWith(2, project.id, 'claude', { isError: false, interrupted: false, limited: false, origin: 'operator' })
  })
})
