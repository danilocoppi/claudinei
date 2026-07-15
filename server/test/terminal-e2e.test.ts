import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createTerminalManager } from '../src/terminal/manager.js'
import type { PtyProcess } from '../src/terminal/pty.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

// PTY-fake: registra callbacks e expõe emit/writes/resizes para o teste dirigir
// o canal fim-a-fim sem depender do módulo nativo node-pty.
function makeFakePty() {
  let dataCb: (d: string) => void = () => {}
  let exitCb: (e: { exitCode: number }) => void = () => {}
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []
  let killed = false
  const proc: PtyProcess = {
    onData: (cb) => { dataCb = cb },
    onExit: (cb) => { exitCb = cb },
    write: (d) => { writes.push(d) },
    resize: (cols, rows) => { resizes.push({ cols, rows }) },
    kill: () => { killed = true; exitCb({ exitCode: 0 }) },
  }
  return { proc, emit: (d: string) => dataCb(d), writes, resizes, get killed() { return killed } }
}

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let port: number
let lastPty: ReturnType<typeof makeFakePty>

beforeEach(async () => {
  db = openDb(':memory:')
  const terminalManager = createTerminalManager({
    ptyFactory: () => { lastPty = makeFakePty(); return lastPty.proc },
  })
  const manager = createSessionManager({
    db,
    sessionFactory: fakeFactory,
    broadcast: () => {},
    terminalLauncher: (opts) => terminalManager.open(opts.localId, {
      cwd: opts.cwd,
      file: opts.file,
      args: opts.args,
      onExit: opts.onExit,
    }),
  })
  app = await buildApp({ config: loadConfig({}), db, manager, terminalManager })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterEach(async () => {
  await app.close()
})

describe('terminal E2E (transporte real: HTTP + WebSocket, PTY fake)', () => {
  it('POST abre → WS replaya buffer, recebe bytes ao vivo, envia teclas e resize; DELETE encerra', async () => {
    // cria projeto e inicia uma sessão headless (fake-claude)
    const proj = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) },
    })
    const projectId = proj.json().id
    const start = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const localId = start.json().localId
    await waitUntil(() => {
      const row = db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(localId) as any
      return !!row?.claude_session_id
    })

    // abre o terminal → para o headless, cria o PTY fake, devolve token+wsUrl
    const open = await app.inject({ method: 'POST', url: `/api/sessions/${localId}/terminal` })
    expect(open.statusCode).toBe(200)
    const { token, wsUrl } = open.json() as { token: string; wsUrl: string }
    expect(wsUrl).toBe(`/ws/terminal/${localId}`)

    // dados emitidos ANTES da conexão devem entrar no buffer e ser replayados
    lastPty.emit('BUFFER-ANTES\r\n')

    const received: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsUrl}?token=${encodeURIComponent(token)}`)
    ws.on('message', (data) => received.push(data.toString('utf8')))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // replay do buffer
    await waitUntil(() => received.join('').includes('BUFFER-ANTES'))
    // bytes ao vivo depois de conectado
    lastPty.emit('AO-VIVO\r\n')
    await waitUntil(() => received.join('').includes('AO-VIVO'))

    // tecla como binário → chega no pty.write
    ws.send(Buffer.from('y\r', 'utf8'), { binary: true })
    await waitUntil(() => lastPty.writes.join('').includes('y\r'))

    // resize como texto JSON → chega no pty.resize
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    await waitUntil(() => lastPty.resizes.some((r) => r.cols === 120 && r.rows === 40))

    ws.close()

    // DELETE encerra o PTY
    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${localId}/terminal` })
    expect(del.statusCode).toBe(204)
    expect(lastPty.killed).toBe(true)
  })

  it('WS com token inválido é recusado', async () => {
    const proj = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'P2', path: mkdtempSync(join(tmpdir(), 'tm-')) },
    })
    const projectId = proj.json().id
    const start = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const localId = start.json().localId
    await waitUntil(() => {
      const row = db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(localId) as any
      return !!row?.claude_session_id
    })
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/terminal` })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${localId}?token=errado`)
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('close', (code) => resolve(code))
      ws.on('error', reject)
    })
    expect(closeCode).toBe(1008)
  })
})
