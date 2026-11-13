import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createWsHub } from '../src/routes/ws.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import '../src/engine/index.js'

/** As duas entradas da tela para os avisos: o botão (WebSocket) e o interruptor do terminal (REST). */
const FAKE = join(fileURLToPath(new URL('.', import.meta.url)), 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) => new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
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
afterEach(async () => { await manager.stopAll(); await app.close() })
const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)) }
}
async function abrirComAviso() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const msgs: any[] = []
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())))
  await waitUntil(() => msgs.some((m) => m.type === 'sessions_snapshot'))
  const projectId = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Avisos', path: mkdtempSync(join(tmpdir(), 'hu-')) } })).json().id
  const { localId } = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions`, payload: {} })).json()
  await waitUntil(() => msgs.some((m) => m.type === 'session_status' && m.localId === localId && m.status === 'idle'))
  ws.send(JSON.stringify({ type: 'send_message', localId, text: 'faz-aviso' }))
  await waitUntil(() => msgs.some((m) => m.type === 'heads_up' && m.localId === localId && m.tree))
  return { ws, msgs, projectId, localId }
}
const avisos = (msgs: any[], localId: string) => msgs.filter((m) => m.type === 'heads_up' && m.localId === localId)

describe('avisos pela tela', () => {
  it('heads_up_press pelo socket chega ao plugin, e o cartão sai', async () => {
    const { ws, msgs, localId } = await abrirComAviso()
    ws.send(JSON.stringify({ type: 'heads_up_press', localId, press: { plugin: 'cc-plugin-you-should-know', handle: 1, key: 'b1' } }))
    await waitUntil(() => avisos(msgs, localId).length === 2)
    expect(avisos(msgs, localId)[1].tree).toBeNull()
    ws.close()
  })

  it('heads_up_press malformado é ignorado sem derrubar nada', async () => {
    const { ws, msgs, localId } = await abrirComAviso()
    ws.send(JSON.stringify({ type: 'heads_up_press', localId, press: { plugin: 1, handle: 'x' } }))
    ws.send(JSON.stringify({ type: 'heads_up_press', localId }))
    await new Promise((r) => setTimeout(r, 150))
    expect(avisos(msgs, localId)).toHaveLength(1)
    expect(msgs.some((m) => m.type === 'error')).toBe(false)
    ws.close()
  })

  it('o snapshot de quem chega depois já traz o aviso', async () => {
    const { ws, localId } = await abrirComAviso()
    const late = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const lateMsgs: any[] = []
    late.on('message', (d) => lateMsgs.push(JSON.parse(d.toString())))
    await waitUntil(() => lateMsgs.some((m) => m.type === 'sessions_snapshot'))
    const snap = lateMsgs.find((m) => m.type === 'sessions_snapshot').sessions.find((s: any) => s.localId === localId)
    expect(JSON.stringify(snap.headsUp)).toContain('O lucro de 27%')
    ws.close(); late.close()
  })

  it('PATCH /heads-up grava, solta a superfície e o aviso some; corpo inválido → 400', async () => {
    const { ws, msgs, projectId, localId } = await abrirComAviso()
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/heads-up`, payload: { headsUp: false } })
    expect(res.statusCode).toBe(200)
    expect(res.json().headsUp).toBe(false)
    await waitUntil(() => avisos(msgs, localId).length === 2)
    expect(avisos(msgs, localId)[1].tree).toBeNull()
    const list = (await app.inject({ method: 'GET', url: '/api/projects' })).json()
    expect(list.find((p: any) => p.id === projectId).headsUp).toBe(false)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/heads-up`, payload: { headsUp: 'sim' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/api/projects/9999/heads-up', payload: { headsUp: true } })).statusCode).toBe(404)
    ws.close()
  })
})
