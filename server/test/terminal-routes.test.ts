import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { registerTerminalRoutes } from '../src/routes/terminal.js'
import { isAllowedOrigin, originAllowed } from '../src/auth/origin.js'

function fakeManager() {
  const calls: string[] = []
  return {
    calls,
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
  return { closed, close: (id: string) => closed.push(id), closeAndWait: async (id: string) => { closed.push(id) }, has: () => true, attach: () => true, detach: () => {}, write: () => {}, resize: () => {}, open: () => 'tok', refreshToken: (_id: string) => null as string | null }
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
  it('outra porta do localhost é outra origem: recusada', () => {
    // Uma página num servidor de desenvolvimento (localhost:3000) não fala com o Claudinei.
    expect(isAllowedOrigin('http://localhost:9100', '127.0.0.1:9105')).toBe(false)
    expect(isAllowedOrigin('http://localhost:3000', 'localhost:9105')).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:9106', '127.0.0.1:9105')).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:9105', undefined)).toBe(false)
  })
  it('mesmo host:porta da requisição passa (localhost, LAN, Vite)', () => {
    expect(isAllowedOrigin('http://127.0.0.1:9105', '127.0.0.1:9105')).toBe(true)
    expect(isAllowedOrigin('http://192.168.0.10:9105', '192.168.0.10:9105')).toBe(true)
    // Dev via Vite: o proxy preserva o Host do navegador.
    expect(isAllowedOrigin('http://localhost:9100', 'localhost:9100')).toBe(true)
    expect(isAllowedOrigin('http://[::1]:9105', '[::1]:9105')).toBe(true)
  })
  it('porta padrão e maiúsculas não atrapalham', () => {
    expect(isAllowedOrigin('http://localhost', 'localhost:80')).toBe(true)
    expect(isAllowedOrigin('https://claudinei.example', 'claudinei.example:443')).toBe(true)
    expect(isAllowedOrigin('https://claudinei.example', 'Claudinei.Example')).toBe(true)
  })
  it('host diferente é bloqueado; origin ausente passa (clientes não-browser)', () => {
    expect(isAllowedOrigin('http://evil.tld', '192.168.0.10:9105')).toBe(false)
    expect(isAllowedOrigin(undefined, 'x')).toBe(true)
    expect(isAllowedOrigin('lixo-não-url', 'x')).toBe(false)
    expect(isAllowedOrigin('null', 'x')).toBe(false)
  })
  it('X-Forwarded-Host conta só quando passado (behindProxy)', () => {
    expect(isAllowedOrigin('https://claudinei.example', '127.0.0.1:9105', 'claudinei.example')).toBe(true)
    expect(isAllowedOrigin('https://claudinei.example', '127.0.0.1:9105', 'claudinei.example, interno:8080')).toBe(true)
    expect(isAllowedOrigin('https://claudinei.example', '127.0.0.1:9105')).toBe(false)
    expect(isAllowedOrigin('https://outro.example', '127.0.0.1:9105', 'claudinei.example')).toBe(false)
  })
})

describe('originAllowed', () => {
  const req = (headers: Record<string, string>, behindProxy?: boolean) => ({ headers, behindProxy })
  it('lê o X-Forwarded-Host só com behindProxy', () => {
    const h = { host: '127.0.0.1:9105', 'x-forwarded-host': 'claudinei.example', origin: 'https://claudinei.example' }
    expect(originAllowed(req(h, true))).toBe(true)
    expect(originAllowed(req(h, false))).toBe(false)
    expect(originAllowed(req(h))).toBe(false)
    expect(originAllowed(req({ host: '127.0.0.1:9105' }))).toBe(true)
  })
})
