import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { createWsHub } from '../src/routes/ws.js'
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
let manager: SessionManager
let db: Db
let port: number

beforeEach(async () => {
  db = openDb(':memory:')
  const hub = createWsHub()
  manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => hub.broadcast(m) })
  app = await buildApp({ config: loadConfig({}), db, manager, wsHub: hub })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as { port: number }).port
})

afterEach(async () => {
  await manager.stopAll()
  await app.close()
})

function collect(ws: WebSocket): object[] {
  const msgs: object[] = []
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())))
  return msgs
}

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('websocket hub', () => {
  it('envia snapshot ao conectar e retransmite eventos de sessão', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs = collect(ws)
    await waitUntil(() => msgs.some((m: any) => m.type === 'sessions_snapshot'))

    const post = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) },
    })
    const sess = await app.inject({ method: 'POST', url: `/api/projects/${post.json().id}/sessions` })
    const { localId } = sess.json()
    await waitUntil(() => msgs.some((m: any) => m.type === 'session_status' && m.status === 'idle'))

    ws.send(JSON.stringify({ type: 'send_message', localId, text: 'olá' }))
    await waitUntil(() => msgs.some((m: any) => m.type === 'session_event' && m.event?.kind === 'result'))
    expect(msgs.some((m: any) => m.type === 'session_event' && m.event?.kind === 'assistant')).toBe(true)
    ws.close()
  })

  it('interrupt pelo socket aborta o turno em andamento (status vira needs_attention)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs = collect(ws)
    await waitUntil(() => msgs.some((m: any) => m.type === 'sessions_snapshot'))

    const post = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'P2', path: mkdtempSync(join(tmpdir(), 'tm-')) },
    })
    const sess = await app.inject({ method: 'POST', url: `/api/projects/${post.json().id}/sessions` })
    const { localId } = sess.json()
    await waitUntil(() => msgs.some((m: any) => m.type === 'session_status' && m.localId === localId && m.status === 'idle'))

    ws.send(JSON.stringify({ type: 'send_message', localId, text: 'tarefa demorada' }))
    await waitUntil(() => msgs.some((m: any) => m.type === 'session_status' && m.localId === localId && m.status === 'working'))

    ws.send(JSON.stringify({ type: 'interrupt', localId }))
    await waitUntil(() => msgs.some((m: any) => m.type === 'session_status' && m.localId === localId && m.status === 'needs_attention'))
    ws.close()
  })

  it('interrupt para sessão inexistente devolve erro só ao solicitante', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs = collect(ws)
    await waitUntil(() => msgs.some((m: any) => m.type === 'sessions_snapshot'))
    ws.send(JSON.stringify({ type: 'interrupt', localId: 'nao-existe' }))
    await waitUntil(() => msgs.some((m: any) => m.type === 'error'))
    ws.close()
  })

  it('send_message para sessão inexistente devolve erro só ao solicitante', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs = collect(ws)
    await waitUntil(() => msgs.some((m: any) => m.type === 'sessions_snapshot'))
    ws.send(JSON.stringify({ type: 'send_message', localId: 'nao-existe', text: 'x' }))
    await waitUntil(() => msgs.some((m: any) => m.type === 'error'))
    ws.close()
  })

  it('POST /api/hermes/board faz broadcast de board_post para clientes conectados', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs = collect(ws)
    await waitUntil(() => msgs.some((m: any) => m.type === 'sessions_snapshot'))

    const post = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'BoardProj', path: mkdtempSync(join(tmpdir(), 'tm-')) },
    })
    const projectId = post.json().id

    await app.inject({
      method: 'POST', url: '/api/hermes/board',
      payload: { projectId, title: 'Aviso', content: 'texto do board' },
    })

    await waitUntil(() => msgs.some((m: any) => m.type === 'board_post' && m.title === 'Aviso'))
    const msg = msgs.find((m: any) => m.type === 'board_post') as any
    expect(msg.projectName).toBe('BoardProj')
    ws.close()
  })
})
