import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let fromId: number
let toId: number

beforeEach(async () => {
  db = openDb(':memory:')
  const manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })

  const from = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'Origem', path: mkdtempSync(join(tmpdir(), 'tm-')) },
  })
  fromId = from.json().id

  const to = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'Destino', path: mkdtempSync(join(tmpdir(), 'tm-')) },
  })
  toId = to.json().id
})

describe('rotas hermes', () => {
  it('GET /api/hermes/projects lista projetos com hasActiveSession', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/hermes/projects' })
    expect(res.statusCode).toBe(200)
    const list = res.json()
    expect(list).toHaveLength(2)
    expect(list.every((p: any) => p.hasActiveSession === false)).toBe(true)

    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })

    const res2 = await app.inject({ method: 'GET', url: '/api/hermes/projects' })
    const destino = res2.json().find((p: any) => p.id === toId)
    expect(destino.hasActiveSession).toBe(true)
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('POST /api/hermes/board cria post, GET lista newest-first', async () => {
    const post1 = await app.inject({
      method: 'POST', url: '/api/hermes/board',
      payload: { projectId: fromId, title: 'Primeiro', content: 'conteúdo 1' },
    })
    expect(post1.statusCode).toBe(201)
    expect(typeof post1.json().id).toBe('number')

    const post2 = await app.inject({
      method: 'POST', url: '/api/hermes/board',
      payload: { projectId: toId, title: 'Segundo', content: 'conteúdo 2' },
    })
    expect(post2.statusCode).toBe(201)

    const list = await app.inject({ method: 'GET', url: '/api/hermes/board' })
    expect(list.statusCode).toBe(200)
    const body = list.json()
    expect(body).toHaveLength(2)
    expect(body[0].title).toBe('Segundo')
    expect(body[0].projectName).toBe('Destino')
  })

  it('POST /api/hermes/board com campos faltando retorna 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/hermes/board',
      payload: { projectId: fromId, title: 'Só título' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })

  it('POST /api/hermes/board com projeto inexistente retorna 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/hermes/board',
      payload: { projectId: 999999, title: 'T', content: 'C' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/hermes/ask happy path: agente alvo idle responde', async () => {
    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })

    const res = await app.inject({
      method: 'POST', url: '/api/hermes/ask',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', question: 'como vai?' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().answer).toMatch(/eco: \[Question from agent of Origem\]: como vai\?/)

    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('POST /api/hermes/ask com projeto alvo desconhecido retorna 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/hermes/ask',
      payload: { fromProjectId: fromId, toProjectName: 'Não Existe', question: 'oi?' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBeTruthy()
  })

  it('POST /api/hermes/ask sem sessão ativa no alvo retorna 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/hermes/ask',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', question: 'oi?' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/active session/)
  })

  it('POST /api/hermes/ask é case-insensitive no nome do projeto alvo', async () => {
    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })

    const res = await app.inject({
      method: 'POST', url: '/api/hermes/ask',
      payload: { fromProjectId: fromId, toProjectName: 'destino', question: 'oi?' },
    })
    expect(res.statusCode).toBe(200)

    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })
})
