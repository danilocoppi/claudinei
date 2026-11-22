import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp, WS_MAX_PAYLOAD } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { createWsHub } from '../src/routes/ws.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
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

/** Abre o /ws e espera o snapshot: a conexão está pronta para receber frames. */
async function conectar(): Promise<{ ws: WebSocket; msgs: any[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } })
  const msgs: any[] = []
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())))
  const inicio = Date.now()
  while (!msgs.some((m) => m.type === 'sessions_snapshot')) {
    if (Date.now() - inicio > 5000) throw new Error('sem snapshot')
    await new Promise((r) => setTimeout(r, 20))
  }
  return { ws, msgs }
}

describe('teto de mensagem dos WebSockets', () => {
  it('é de 8 MiB', () => {
    expect(WS_MAX_PAYLOAD).toBe(8 * 1024 * 1024)
  })

  it('frame acima do teto fecha com 1009 e o servidor segue atendendo', async () => {
    const { ws } = await conectar()
    const fechou = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    ws.send(Buffer.alloc(WS_MAX_PAYLOAD + 1, 0x61))
    expect(await fechou).toBe(1009)

    // O processo não caiu: HTTP responde e um /ws novo recebe o snapshot.
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(res.status).toBe(200)
    const outro = await conectar()
    outro.ws.close()
  })

  it('mensagem grande abaixo do teto chega ao handler', async () => {
    const { ws, msgs } = await conectar()
    // ~7,5 MiB de texto num send_message: a sessão não existe, e o erro que volta
    // com o localId prova que o frame foi aceito e lido.
    const texto = 'x'.repeat(WS_MAX_PAYLOAD - 512 * 1024)
    const frame = JSON.stringify({ type: 'send_message', localId: 'sem-sessao', text: texto })
    expect(Buffer.byteLength(frame)).toBeLessThan(WS_MAX_PAYLOAD)
    ws.send(frame)
    const inicio = Date.now()
    while (!msgs.some((m) => m.type === 'error' && m.localId === 'sem-sessao')) {
      if (Date.now() - inicio > 10_000) throw new Error('sem resposta ao frame grande')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})
