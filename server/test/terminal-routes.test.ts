import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { registerTerminalRoutes, isAllowedOrigin } from '../src/routes/terminal.js'
import { WebSocket } from 'ws'

const waitUntil = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function fakeManager() {
  const calls: string[] = []
  const touches: { localId: string; opts?: { atMostEveryMs?: number } }[] = []
  return {
    calls,
    touches,
    touchInput(localId: string, opts?: { atMostEveryMs?: number }) { touches.push({ localId, opts }) },
    get(localId: string) {
      return { localId, projectId: 1, status: 'ready', engineSessionId: 'sid', updatedAt: '' }
    },
    async openInTerminal(localId: string) {
      calls.push(`open:${localId}`)
      if (localId === 'sem-conversa') throw new Error('esta sessão ainda não tem uma conversa para abrir no terminal')
      return { localId, projectId: 1, status: 'in_terminal', engineSessionId: 'sid', updatedAt: '', token: 'tok-123' }
    },
  }
}
function fakeTerminal() {
  const closed: string[] = []
  const written: string[] = []
  return { closed, written, close: (id: string) => closed.push(id), closeAndWait: async (id: string) => { closed.push(id) }, has: () => true, attach: () => true, detach: () => {}, write: (_id: string, d: string) => { written.push(d) }, resize: () => {}, open: () => 'tok', refreshToken: (_id: string) => null as string | null }
}

async function makeApp(mgr: any, tm: any) {
  const app = Fastify()
  await app.register(websocket)
  registerTerminalRoutes(app, { manager: mgr, terminalManager: tm })
  return app
}

let mgr: ReturnType<typeof fakeManager>
let tm: ReturnType<typeof fakeTerminal>
beforeEach(() => { mgr = fakeManager(); tm = fakeTerminal() })

describe('rotas do terminal', () => {
  it('POST abre e devolve token + wsUrl', async () => {
    const app = await makeApp(mgr, tm)
    const res = await app.inject({ method: 'POST', url: '/api/sessions/l1/terminal' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ token: 'tok-123', wsUrl: '/ws/terminal/l1' })
    await app.close()
  })

  it('POST reconecta (idempotente) sem chamar openInTerminal quando já há PTY vivo', async () => {
    const tmLive = { ...fakeTerminal(), refreshToken: (_id: string) => 'tok-live' as string | null }
    const app = await makeApp(mgr, tmLive)
    const res = await app.inject({ method: 'POST', url: '/api/sessions/l1/terminal' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ token: 'tok-live', wsUrl: '/ws/terminal/l1' })
    expect(mgr.calls).toEqual([]) // openInTerminal NÃO foi chamado
    await app.close()
  })

  /**
   * Abrir no terminal sobe o programa: conta como mexer no terminal. Reconectar a
   * um PTY que já roda é só voltar a olhar, e não conta.
   */
  it('POST que abre o terminal marca a última interação; reconectar não', async () => {
    const app = await makeApp(mgr, tm)
    await app.inject({ method: 'POST', url: '/api/sessions/l1/terminal' })
    expect(mgr.touches.map((x) => x.localId)).toEqual(['l1'])
    const tmLive = { ...fakeTerminal(), refreshToken: (_id: string) => 'tok-live' as string | null }
    const app2 = await makeApp(mgr, tmLive)
    await app2.inject({ method: 'POST', url: '/api/sessions/l1/terminal' })
    expect(mgr.touches).toHaveLength(1)
    await app.close(); await app2.close()
  })

  it('digitar no terminal marca a última interação no máximo uma vez por minuto; foco e mouse não', async () => {
    const app = await makeApp(mgr, tm)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/l1?token=tok`)
    await new Promise((r) => ws.once('open', r))
    ws.send(Buffer.from('\x1b[I'))
    ws.send(Buffer.from('\x1b[<64;10;5M'))
    ws.send(Buffer.from('ls\r'))
    await waitUntil(() => tm.written.length === 3)
    // Tudo chega ao programa; só a digitação conta como mexer.
    expect(tm.written).toEqual(['\x1b[I', '\x1b[<64;10;5M', 'ls\r'])
    expect(mgr.touches).toEqual([{ localId: 'l1', opts: { atMostEveryMs: 60_000 } }])
    ws.close()
    await app.close()
  })

  it('POST em sessão sem conversa retorna 400', async () => {
    const app = await makeApp(mgr, tm)
    const res = await app.inject({ method: 'POST', url: '/api/sessions/sem-conversa/terminal' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/conversa/)
    await app.close()
  })

  it('DELETE encerra o terminal e retorna 204', async () => {
    const app = await makeApp(mgr, tm)
    const res = await app.inject({ method: 'DELETE', url: '/api/sessions/l1/terminal' })
    expect(res.statusCode).toBe(204)
    expect(tm.closed).toEqual(['l1'])
    await app.close()
  })
})

describe('isAllowedOrigin', () => {
  it('loopback sempre passa', () => {
    expect(isAllowedOrigin('http://localhost:9100', '127.0.0.1:9105')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:9105', undefined)).toBe(true)
  })
  it('mesmo host:porta da requisição passa (LAN)', () => {
    expect(isAllowedOrigin('http://192.168.0.10:9105', '192.168.0.10:9105')).toBe(true)
  })
  it('host diferente é bloqueado; origin ausente passa (clientes não-browser)', () => {
    expect(isAllowedOrigin('http://evil.tld', '192.168.0.10:9105')).toBe(false)
    expect(isAllowedOrigin(undefined, 'x')).toBe(true)
    expect(isAllowedOrigin('lixo-não-url', 'x')).toBe(false)
  })
})
