import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createWsHub } from '../src/routes/ws.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'

/**
 * Escrita em /api vinda de outra origem. Uma página aberta em OUTRA porta do
 * localhost (o servidor de desenvolvimento de um projeto, por exemplo) é
 * outra origem, mas o navegador manda o cookie do Claudinei junto num POST
 * `no-cors`: sem essa recusa, ela abria a aba do navegador do agente. Só passa
 * a origem cujo host:porta é o da própria requisição (com `--behind-proxy`,
 * também o X-Forwarded-Host). Sem Origin (Hermes, curl) segue como sempre.
 */

const CROSS = { error: 'cross_origin' }

let db: Db
const apps: Awaited<ReturnType<typeof buildApp>>[] = []
const temps: string[] = []

const build = async (o: { auth?: AuthService; behindProxy?: boolean } = {}) => {
  const hub = createWsHub()
  const manager = createSessionManager({ db, broadcast: (m) => hub.broadcast(m) })
  const pagesDir = mkdtempSync(join(tmpdir(), 'origin-guard-'))
  temps.push(pagesDir)
  const app = await buildApp({
    config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager, wsHub: hub,
    ...(o.auth ? { auth: o.auth } : {}),
    ...(o.behindProxy ? { behindProxy: true } : {}),
  })
  apps.push(app)
  return app
}

beforeEach(() => { db = openDb(':memory:') })
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

// POST /api/projects sem corpo: passando pela origem, cai no 400 da rota.
const post = (app: Awaited<ReturnType<typeof buildApp>>, url: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url, headers, payload: {} })

describe('escrita em /api de outra origem', () => {
  it('outra porta do localhost: 403, inclusive com /%61pi', async () => {
    const app = await build()
    for (const origin of ['http://localhost:9100', 'http://localhost:3000', 'http://127.0.0.1', 'https://malicioso.example']) {
      for (const url of ['/api/projects', '/%61pi/projects']) {
        const res = await post(app, url, { host: '127.0.0.1:9105', origin })
        expect(res.statusCode, `${origin} ${url}`).toBe(403)
        expect(res.json()).toEqual(CROSS)
      }
    }
    // PUT/PATCH/DELETE também.
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/projects/1', headers: { host: '127.0.0.1:9105', origin: 'http://localhost:3000' } })
      expect(res.statusCode, method).toBe(403)
    }
  })

  it('com o cookie do admin, ainda 403 (é o ataque)', async () => {
    const auth = createAuthService({ db })
    const app = await build({ auth })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } })
    const c = login.cookies.find((x: any) => x.name === COOKIE_NAME)!
    const cookie = `${COOKIE_NAME}=${c.value}`
    const res = await post(app, '/api/projects', { cookie, host: 'localhost:9105', origin: 'http://localhost:5173' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual(CROSS)
    // A mesma origem passa e chega à rota.
    expect((await post(app, '/api/projects', { cookie, host: 'localhost:9105', origin: 'http://localhost:9105' })).statusCode).toBe(400)
  })

  it('mesma origem passa (inclusive porta padrão omitida e o Host do inject)', async () => {
    const app = await build()
    expect((await post(app, '/api/projects', { host: '127.0.0.1:9105', origin: 'http://127.0.0.1:9105' })).statusCode).toBe(400)
    expect((await post(app, '/api/projects', { host: '192.168.0.10:9105', origin: 'http://192.168.0.10:9105' })).statusCode).toBe(400)
    // O inject manda Host localhost:80; o navegador manda a origem sem a porta padrão.
    expect((await post(app, '/api/projects', { origin: 'http://localhost' })).statusCode).toBe(400)
    // Dev via Vite: o proxy de /api preserva o Host do navegador (sem changeOrigin).
    expect((await post(app, '/api/projects', { host: 'localhost:9100', origin: 'http://localhost:9100' })).statusCode).toBe(400)
  })

  it('sem Origin segue como hoje; GET de outra origem também', async () => {
    const app = await build()
    expect((await post(app, '/api/projects', { host: '127.0.0.1:9105' })).statusCode).toBe(400)
    const get = await app.inject({ method: 'GET', url: '/api/projects', headers: { host: '127.0.0.1:9105', origin: 'http://localhost:3000' } })
    expect(get.statusCode).toBe(200)
    // Fora de /api não é assunto deste gancho.
    const fora = await app.inject({ method: 'POST', url: '/nada-aqui', headers: { origin: 'http://localhost:3000' } })
    expect(fora.statusCode).toBe(404)
  })

  it('X-Forwarded-Host só vale com behindProxy', async () => {
    const headers = { host: '127.0.0.1:9105', 'x-forwarded-host': 'claudinei.example', origin: 'https://claudinei.example' }
    const atras = await build({ behindProxy: true })
    expect((await post(atras, '/api/projects', headers)).statusCode).toBe(400)
    // Mais de um proxy: vale o primeiro (o que o navegador viu).
    expect((await post(atras, '/api/projects', { ...headers, 'x-forwarded-host': 'claudinei.example, interno:8080' })).statusCode).toBe(400)
    // O Host direto continua valendo atrás do proxy.
    expect((await post(atras, '/api/projects', { host: '127.0.0.1:9105', origin: 'http://127.0.0.1:9105' })).statusCode).toBe(400)
    // Outra origem atrás do proxy: 403.
    expect((await post(atras, '/api/projects', { ...headers, origin: 'https://outro.example' })).statusCode).toBe(403)

    const direto = await build()
    const res = await post(direto, '/api/projects', headers)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual(CROSS)
  })
})
