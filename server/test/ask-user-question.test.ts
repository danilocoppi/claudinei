import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
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
let broadcasts: any[]

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  broadcasts = []
})

const statusesOf = (localId: string) => broadcasts.filter((b) => b.type === 'session_status' && b.localId === localId)
const resultsOf = (localId: string) => broadcasts.filter((b) => b.type === 'session_event' && b.localId === localId && b.event?.kind === 'result')

const askAndWait = async () => {
  const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
  const { localId } = mgr.start(project, {})
  await waitUntil(() => mgr.get(localId)?.status === 'idle')
  mgr.send(localId, 'faz-pergunta')
  await waitUntil(() => mgr.get(localId)?.pendingQuestion !== undefined)
  return { mgr, localId }
}

describe('perguntas do agente (AskUserQuestion) no manager', () => {
  it('a pergunta chega aos clientes pelo session_status e está no list() (snapshot)', async () => {
    const { mgr, localId } = await askAndWait()
    const comPergunta = statusesOf(localId).filter((s) => s.pendingQuestion)
    expect(comPergunta.length).toBeGreaterThan(0)
    expect(comPergunta.at(-1).pendingQuestion).toMatchObject({ toolUseId: 'toolu_q_1' })
    expect(comPergunta.at(-1).pendingQuestion.questions).toHaveLength(2)
    expect(comPergunta.at(-1).status).toBe('working')
    expect(mgr.list().find((s) => s.localId === localId)?.pendingQuestion?.toolUseId).toBe('toolu_q_1')
    await mgr.stopAll()
  })

  it('answerQuestion pelo manager: o turno continua e o status seguinte vai SEM a pendência', async () => {
    const { mgr, localId } = await askAndWait()
    mgr.answerQuestion(localId, { 'Qual cor você prefere?': 'Verde', 'Quais frutas você gosta?': 'Banana' })
    await waitUntil(() => resultsOf(localId).length === 1)
    expect(resultsOf(localId)[0].event.resultText).toContain('"Qual cor você prefere?"="Verde"')
    expect(mgr.get(localId)?.pendingQuestion).toBeUndefined()
    expect(statusesOf(localId).at(-1).pendingQuestion).toBeUndefined()
    await mgr.stopAll()
  })

  it('dismissQuestion pelo manager nega a pergunta', async () => {
    const { mgr, localId } = await askAndWait()
    mgr.dismissQuestion(localId)
    await waitUntil(() => resultsOf(localId).length === 1)
    expect(resultsOf(localId)[0].event.resultText).toMatch(/negado/)
    expect(mgr.get(localId)?.pendingQuestion).toBeUndefined()
    await mgr.stopAll()
  })

  it('sessão inexistente / sem pendência → erro claro', async () => {
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
    expect(() => mgr.answerQuestion('nao-existe', { a: 'b' })).toThrow(/não está ativa/)
    const { localId } = mgr.start(project, {})
    await waitUntil(() => mgr.get(localId)?.status === 'idle')
    expect(() => mgr.answerQuestion(localId, { a: 'b' })).toThrow(/pendente/)
    await mgr.stopAll()
  })
})
