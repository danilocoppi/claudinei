import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
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
let dir: string

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  dir = mkdtempSync(join(tmpdir(), 'tm-'))
})

describe('rotas de projetos', () => {
  it('health responde ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('POST cria e GET lista', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    expect(post.statusCode).toBe(201)
    expect(post.json().name).toBe('P1')
    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.json()).toHaveLength(1)
  })

  it('POST com path inválido retorna 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X', path: '/nao/existe' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/diretório não existe/)
  })

  it('PATCH atualiza e DELETE remove', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    const id = post.json().id
    const patch = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { color: '#00ff00' } })
    expect(patch.json().color).toBe('#00ff00')
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del.statusCode).toBe(204)
  })

  it('DELETE de projeto com sessão ativa retorna 409', async () => {
    const db = openDb(':memory:')
    const manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
    const fakeApp = await buildApp({ config: loadConfig({}), db, manager })
    const post = await fakeApp.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    const id = post.json().id
    const sessionRes = await fakeApp.inject({ method: 'POST', url: `/api/projects/${id}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })

    const del = await fakeApp.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del.statusCode).toBe(409)
    expect(del.json().error).toBeTruthy()

    await fakeApp.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'stopped'
    })

    const del2 = await fakeApp.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del2.statusCode).toBe(204)
  })
})
