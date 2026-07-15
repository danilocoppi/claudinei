import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let projectId: number

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(async () => {
  db = openDb(':memory:')
  const manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  const post = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) },
  })
  projectId = post.json().id
})

// Alguns testes de preview setam CLAUDE_CONFIG_DIR (claudeEngine lê direto do
// process.env — self-contained) — não pode vazar para outros arquivos de teste.
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
})

describe('rotas de sessões', () => {
  it('cria sessão para projeto e lista', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })
    const list = await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(list.json().some((s: any) => s.localId === localId)).toBe(true)
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('cria sessão com body { continueConversation:false, permissionMode:"default" }', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { continueConversation: false, permissionMode: 'default' },
    })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    expect(res.json().permissionMode).toBe('default')
    const row = db.prepare('SELECT permission_mode FROM sessions WHERE local_id=?').get(localId) as any
    expect(row.permission_mode).toBe('default')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('cria sessão com model:"haiku" → 201 e persiste model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { model: 'haiku' },
    })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    const row = db.prepare('SELECT model FROM sessions WHERE local_id=?').get(localId) as any
    expect(row.model).toBe('haiku')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('cria sessão com model:"fable" → 201 e persiste model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { model: 'fable' },
    })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    const row = db.prepare('SELECT model FROM sessions WHERE local_id=?').get(localId) as any
    expect(row.model).toBe('fable')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('nome completo de modelo ("claude-fable-5") é aceito e persiste', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { model: 'claude-fable-5' },
    })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    const row = db.prepare('SELECT model FROM sessions WHERE local_id=?').get(localId) as any
    expect(row.model).toBe('claude-fable-5')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('nome completo com metachars ("claude-x; rm") é tratado como Padrão (model NULL)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { model: 'claude-x; rm' },
    })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    const row = db.prepare('SELECT model FROM sessions WHERE local_id=?').get(localId) as any
    expect(row.model == null).toBe(true)
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('model fora do allowlist ("evil; rm") é tratado como Padrão (sem crash, model NULL)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/sessions`,
      payload: { model: 'evil; rm' },
    })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    const row = db.prepare('SELECT model FROM sessions WHERE local_id=?').get(localId) as any
    expect(row.model == null).toBe(true)
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('segunda sessão do mesmo projeto → 409', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    expect(res.statusCode).toBe(409)
    await app.inject({ method: 'POST', url: `/api/sessions/${r1.json().localId}/stop` })
  })

  it('projeto inexistente → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/9999/sessions' })
    expect(res.statusCode).toBe(404)
  })

  it('history sem transcript retorna []', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const { localId } = r1.json()
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${localId}/history` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('stop retorna 204', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const { localId } = r1.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
    expect(res.statusCode).toBe(204)
  })

  it('revive de sessão ainda ativa retorna 400', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const { localId } = r1.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${localId}/revive` })
    expect(res.statusCode).toBe(400)
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('history de sessão inexistente retorna 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nao-existe/history' })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH /options troca modo e persiste', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const { localId } = r1.json()
    await waitUntil(() => { const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any; return row?.status === 'idle' })
    const res = await app.inject({ method: 'PATCH', url: `/api/sessions/${localId}/options`, payload: { permissionMode: 'plan' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().permissionMode).toBe('plan')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('PATCH /options persiste effort e devolve no SessionInfo', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const { localId } = r1.json()
    const res = await app.inject({ method: 'PATCH', url: `/api/sessions/${localId}/options`, payload: { effort: 'max' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().effort).toBe('max')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('PATCH /options com effort inválido → 400 (allowlist estrita — vai ao argv)', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const res = await app.inject({ method: 'PATCH', url: `/api/sessions/${r1.json().localId}/options`, payload: { effort: 'ultracode; rm -rf' } })
    expect(res.statusCode).toBe(400)
    await app.inject({ method: 'POST', url: `/api/sessions/${r1.json().localId}/stop` })
  })

  it('PATCH /options com modo inválido → 400', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const res = await app.inject({ method: 'PATCH', url: `/api/sessions/${r1.json().localId}/options`, payload: { permissionMode: 'evil' } })
    expect(res.statusCode).toBe(400)
    await app.inject({ method: 'POST', url: `/api/sessions/${r1.json().localId}/stop` })
  })

})

describe('preview de conversa anterior (sessão nova com --continue, antes do init)', () => {
  it('continue_latest=1 → devolve o transcript mais recente da pasta; =0 → []', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'))
    const projPath = mkdtempSync(join(tmpdir(), 'tm-'))
    const dir = join(cfgDir, 'projects', projPath.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sid-antiga.jsonl'),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"conversa anterior da pasta"}]}}\n')

    // claudeEngine resolve o config dir do próprio process.env (self-contained,
    // não depende do objeto config injetado) — ver server/src/engine/claude-engine.ts.
    process.env.CLAUDE_CONFIG_DIR = cfgDir
    // manager construído ANTES das rows (a varredura de órfãs do boot não pode vê-las)
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
    const app2 = await buildApp({ config: loadConfig({ CLAUDE_CONFIG_DIR: cfgDir }), db, manager: mgr })
    const proj = await app2.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P-preview', path: projPath } })
    const pid = proj.json().id

    // sessão nova em starting, sem claude_session_id (o init real só chega com a 1ª mensagem)
    db.prepare(
      `INSERT INTO sessions (local_id, project_id, status, continue_latest) VALUES ('prev-1', ?, 'starting', 1)`,
    ).run(pid)
    const h1 = await app2.inject({ method: 'GET', url: '/api/sessions/prev-1/history' })
    expect(h1.statusCode).toBe(200)
    expect(JSON.stringify(h1.json())).toContain('conversa anterior da pasta')

    // sem continue: nada de preview (a conversa antiga NÃO será retomada)
    db.prepare(
      `INSERT INTO sessions (local_id, project_id, status, continue_latest) VALUES ('prev-0', ?, 'starting', 0)`,
    ).run(pid)
    const h0 = await app2.inject({ method: 'GET', url: '/api/sessions/prev-0/history' })
    expect(h0.json()).toEqual([])

    await app2.close()
  })
})

describe('limite de eventos do histórico (transcripts gigantes não travam o navegador)', () => {
  it('preview devolve no máximo HISTORY_EVENT_LIMIT eventos, os mais recentes', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { HISTORY_EVENT_LIMIT } = await import('../src/routes/sessions.js')
    const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'))
    const projPath = mkdtempSync(join(tmpdir(), 'tm-'))
    const dir = join(cfgDir, 'projects', projPath.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const lines = Array.from({ length: HISTORY_EVENT_LIMIT + 50 }, (_, i) =>
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"msg-${i}"}]}}`)
    writeFileSync(join(dir, 'sid-grande.jsonl'), lines.join('\n') + '\n')

    // claudeEngine resolve o config dir do próprio process.env (self-contained).
    process.env.CLAUDE_CONFIG_DIR = cfgDir
    const mgr = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
    const app2 = await buildApp({ config: loadConfig({ CLAUDE_CONFIG_DIR: cfgDir }), db, manager: mgr })
    const proj = await app2.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P-cap', path: projPath } })
    db.prepare(
      `INSERT INTO sessions (local_id, project_id, status, continue_latest) VALUES ('cap-1', ?, 'starting', 1)`,
    ).run(proj.json().id)

    const res = await app2.inject({ method: 'GET', url: '/api/sessions/cap-1/history' })
    const events = res.json()
    expect(events).toHaveLength(HISTORY_EVENT_LIMIT)
    // são os MAIS RECENTES: o primeiro devolvido é o 50º do arquivo
    expect(JSON.stringify(events[0])).toContain('msg-50')
    expect(JSON.stringify(events[events.length - 1])).toContain(`msg-${HISTORY_EVENT_LIMIT + 49}`)
    await app2.close()
  })
})
