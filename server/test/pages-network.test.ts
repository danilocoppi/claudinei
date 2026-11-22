import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { openDb, type Db } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createWsHub } from '../src/routes/ws.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { createSettingsService } from '../src/settings.js'
import { createPagesService, type PagesService } from '../src/pages/service.js'
import { PAGE_NETWORK_KEY, readNetwork } from '../src/pages/settings.js'

/**
 * A rede das páginas (configuração global do admin) e a recusa de
 * `Origin: null` em /api e /ws, com e sem auth configurada.
 */

const CDN = 'https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com'
const CSP_CDN = `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${CDN}; style-src 'unsafe-inline' ${CDN} https://fonts.googleapis.com; font-src data: ${CDN} https://fonts.gstatic.com; img-src data: blob: ${CDN}; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'`
const CSP_OPEN = "sandbox allow-scripts; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src *; form-action 'none'; base-uri 'none'"
const OPAQUE = { error: 'opaque_origin' }

const temps: string[] = []
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d }
const apps: Awaited<ReturnType<typeof buildApp>>[] = []

let db: Db
let hub: ReturnType<typeof createWsHub>
let pagesDir: string
let seq = 0

/** Monta o app: `auth` ausente = sem auth configurada; com auth e sem usuários = pré-setup. */
const build = async (auth?: AuthService) => {
  const manager = createSessionManager({ db, broadcast: (m) => hub.broadcast(m) })
  const app = await buildApp({
    config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager, wsHub: hub,
    ...(auth ? { auth, onRevokeAll: () => hub.closeAll(), onUserInvalidated: (id: number) => hub.closeUser(id) } : {}),
  })
  apps.push(app)
  return app
}

/** Página com linha e arquivo, como o publish deixaria. */
const addPage = (service: PagesService, projectId: number) => {
  const id = `pg_${(++seq).toString(16).padStart(16, '0')}`
  service.store.insert({
    id, projectId, engine: 'claude', localId: 'loc-a', conversationId: null,
    turnId: null, turnKey: null, title: id, height: null, bytes: 1, source: 'html', sourcePath: null,
  })
  writeFileSync(service.filePath(id), `<html><body><p>${id}</p></body></html>`)
  return id
}

const pagesService = () => {
  const service = createPagesService({
    db, dir: pagesDir, projects: createProjectsService(db), liveSession: () => undefined, openTurn: () => undefined,
    broadcast: () => {}, log: () => {},
  })
  mkdirSync(pagesDir, { recursive: true })
  return service
}

const cookieOf = (res: any): string => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return `${COOKIE_NAME}=${c.value}`
}

beforeEach(() => {
  seq = 0
  db = openDb(':memory:')
  hub = createWsHub()
  pagesDir = join(tmp('pg-net-'), 'pages')
})

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Com auth e dois usuários: o admin e a ana (projeto p1). */
const withUsers = async () => {
  const auth = createAuthService({ db })
  const app = await build(auth)
  const p1 = createProjectsService(db).create({ name: 'Alfa', path: tmp('pg-p1-') }).id
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1] })
  const login = async (username: string) =>
    cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))
  return { app, p1, admin: await login('root'), ana: await login('ana') }
}

describe('readNetwork', () => {
  it('só "open" vale open; ausente, vazio ou desconhecido vale cdn', () => {
    const settings = createSettingsService(db)
    expect(PAGE_NETWORK_KEY).toBe('visualPagesNetwork')
    expect(readNetwork(settings)).toBe('cdn')
    for (const v of ['', 'OPEN', 'open ', 'aberta', 'cdn']) {
      settings.set(PAGE_NETWORK_KEY, v)
      expect(readNetwork(settings)).toBe('cdn')
    }
    settings.set(PAGE_NETWORK_KEY, 'open')
    expect(readNetwork(settings)).toBe('open')
  })
})

describe('configuração da rede', () => {
  it('GET devolve cdn por padrão e com valor desconhecido no banco', async () => {
    const { app, admin, ana } = await withUsers()
    const get = (cookie: string) => app.inject({ method: 'GET', url: '/api/visual-pages/settings', headers: { cookie } })
    for (const cookie of [admin, ana]) {
      const res = await get(cookie)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ network: 'cdn' })
    }
    createSettingsService(db).set(PAGE_NETWORK_KEY, 'tudo')
    expect((await get(ana)).json()).toEqual({ network: 'cdn' })
    createSettingsService(db).set(PAGE_NETWORK_KEY, 'open')
    expect((await get(ana)).json()).toEqual({ network: 'open' })
    // Sem sessão não lê: a rota nasce fechada como o resto de /api.
    expect((await app.inject({ method: 'GET', url: '/api/visual-pages/settings' })).statusCode).toBe(401)
  })

  it('PUT de admin grava open; não admin 403; valor inválido 400', async () => {
    const { app, admin, ana } = await withUsers()
    const put = (cookie: string, payload: unknown) =>
      app.inject({ method: 'PUT', url: '/api/visual-pages/settings', headers: { cookie }, payload: payload as any })

    const naoAdmin = await put(ana, { network: 'open' })
    expect(naoAdmin.statusCode).toBe(403)
    expect(readNetwork(createSettingsService(db))).toBe('cdn')

    const ok = await put(admin, { network: 'open' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ network: 'open' })
    expect(createSettingsService(db).get(PAGE_NETWORK_KEY)).toBe('open')

    for (const bad of [{ network: 'OPEN' }, { network: 'aberta' }, { network: 1 }, {}, { rede: 'cdn' }]) {
      const res = await put(admin, bad)
      expect(res.statusCode, JSON.stringify(bad)).toBe(400)
    }
    // Nenhum inválido mexeu no que estava gravado.
    expect(createSettingsService(db).get(PAGE_NETWORK_KEY)).toBe('open')

    const volta = await put(admin, { network: 'cdn' })
    expect(volta.statusCode).toBe(200)
    expect(volta.json()).toEqual({ network: 'cdn' })
    expect(readNetwork(createSettingsService(db))).toBe('cdn')
  })

  it('a próxima abertura usa a CSP open verbatim; a de antes não muda (sem cache)', async () => {
    const { app, p1, admin } = await withUsers()
    const id = addPage(pagesService(), p1)
    const viewUrl = async () => {
      const res = await app.inject({ method: 'POST', url: `/api/pages/${id}/view`, headers: { cookie: admin } })
      expect(res.statusCode, res.body).toBe(200)
      return res.json().url as string
    }
    const setNetwork = async (network: string) => {
      const res = await app.inject({ method: 'PUT', url: '/api/visual-pages/settings', headers: { cookie: admin }, payload: { network } })
      expect(res.statusCode, res.body).toBe(200)
    }

    const urlAntes = await viewUrl()
    const antes = await app.inject({ method: 'GET', url: urlAntes })
    expect(antes.statusCode).toBe(200)
    expect(antes.headers['content-security-policy']).toBe(CSP_CDN)

    await setNetwork('open')
    // A resposta já servida segue com a política de quando foi aberta.
    expect(antes.headers['content-security-policy']).toBe(CSP_CDN)
    const depois = await app.inject({ method: 'GET', url: await viewUrl() })
    expect(depois.statusCode).toBe(200)
    expect(depois.headers['content-security-policy']).toBe(CSP_OPEN)
    // Lida a cada pedido: o mesmo token de antes, aberto de novo, já vem com a nova.
    expect((await app.inject({ method: 'GET', url: urlAntes })).headers['content-security-policy']).toBe(CSP_OPEN)

    await setNetwork('cdn')
    expect((await app.inject({ method: 'GET', url: urlAntes })).headers['content-security-policy']).toBe(CSP_CDN)
  })
})

describe('Origin: null recusado', () => {
  const nulo = { origin: 'null' }

  it('Origin: null em /api/projects e na rota da página servida: 403, com e sem auth configurada e no pré-setup', async () => {
    // Com auth e usuários: nem cookie de admin passa.
    const { app, p1, admin } = await withUsers()
    const id = addPage(pagesService(), p1)
    const view = await app.inject({ method: 'POST', url: `/api/pages/${id}/view`, headers: { cookie: admin } })
    expect(view.statusCode).toBe(200)
    const url = view.json().url as string
    for (const req of [
      { method: 'GET' as const, url: '/api/projects', headers: { cookie: admin, ...nulo } },
      { method: 'GET' as const, url: '/api/projects', headers: nulo },
      { method: 'GET' as const, url, headers: nulo },
      { method: 'POST' as const, url: `/api/pages/${id}/view`, headers: { cookie: admin, ...nulo } },
      { method: 'GET' as const, url: '/api/visual-pages/settings?x=1', headers: { cookie: admin, ...nulo } },
    ]) {
      const res = await app.inject(req)
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403)
      expect(res.json()).toEqual(OPAQUE)
    }

    // Pré-setup: zero usuários, loopback entraria sem credencial.
    db = openDb(':memory:')
    const pre = await build(createAuthService({ db }))
    expect((await pre.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(200)
    const preNulo = await pre.inject({ method: 'GET', url: '/api/projects', headers: nulo })
    expect(preNulo.statusCode).toBe(403)
    expect(preNulo.json()).toEqual(OPAQUE)
    const preView = await pre.inject({ method: 'GET', url, headers: nulo })
    expect(preView.statusCode).toBe(403)
    expect(preView.json()).toEqual(OPAQUE)

    // Sem auth configurada.
    db = openDb(':memory:')
    const sem = await build()
    expect((await sem.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(200)
    const semNulo = await sem.inject({ method: 'GET', url: '/api/projects', headers: nulo })
    expect(semNulo.statusCode).toBe(403)
    expect(semNulo.json()).toEqual(OPAQUE)
    const semView = await sem.inject({ method: 'GET', url, headers: nulo })
    expect(semView.statusCode).toBe(403)
    expect(semView.json()).toEqual(OPAQUE)
  })

  it('Origin: null em /%61pi/projects (percent-encoding): 403', async () => {
    for (const auth of [undefined, createAuthService({ db })]) {
      const app = await build(auth)
      for (const url of ['/%61pi/projects', '/api%2Fprojects', '/%77s']) {
        const res = await app.inject({ method: 'GET', url, headers: { origin: 'null' } })
        expect(res.statusCode, url).toBe(403)
        expect(res.json()).toEqual(OPAQUE)
      }
    }
  })

  it('upgrade de /ws com Origin: null: 403', async () => {
    const tentar = async (app: Awaited<ReturnType<typeof buildApp>>, path: string, headers: Record<string, string>) => {
      await app.listen({ port: 0, host: '127.0.0.1' })
      const { port } = app.server.address() as { port: number }
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
      return new Promise<{ status: number; body: string } | 'open'>((resolve, reject) => {
        ws.once('open', () => { ws.close(); resolve('open') })
        ws.once('unexpected-response', (_req, res) => {
          let body = ''
          res.on('data', (c: Buffer) => { body += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        ws.once('error', (e) => { if (!String(e.message).includes('Unexpected server response')) reject(e) })
      })
    }

    // Com auth e cookie de admin válido.
    const { app, admin } = await withUsers()
    const comAuth = await tentar(app, '/ws', { cookie: admin, origin: 'null' })
    expect(comAuth).toMatchObject({ status: 403 })
    expect(JSON.parse((comAuth as { body: string }).body)).toEqual(OPAQUE)

    // Sem auth configurada, e o percent-encoding do caminho.
    db = openDb(':memory:')
    hub = createWsHub()
    const sem = await build()
    expect(await tentar(sem, '/%77s', { origin: 'null' })).toMatchObject({ status: 403 })

    // Pré-setup.
    db = openDb(':memory:')
    hub = createWsHub()
    const pre = await build(createAuthService({ db }))
    expect(await tentar(pre, '/ws', { origin: 'null' })).toMatchObject({ status: 403 })
  })

  it('Origin normal e ausente seguem como antes', async () => {
    const { app, admin } = await withUsers()
    for (const headers of [{ cookie: admin }, { cookie: admin, origin: 'http://localhost:9105' }, { cookie: admin, origin: 'https://exemplo.com' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers })
      expect(res.statusCode, JSON.stringify(headers)).toBe(200)
    }
    // Sem cookie continua 401, não 403 de origem.
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { origin: 'http://localhost:9105' } })).statusCode).toBe(401)
    // Fora de /api e /ws, Origin: null não é assunto deste gancho.
    const fora = await app.inject({ method: 'GET', url: '/nada-aqui', headers: { origin: 'null' } })
    expect(fora.statusCode).toBe(404)
    expect(fora.json()).not.toEqual(OPAQUE)

    // O WebSocket com a origem da própria interface ainda abre.
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: admin, origin: `http://127.0.0.1:${port}` } })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    ws.close()

    // Sem auth configurada: sem origem e com origem normal, 200.
    db = openDb(':memory:')
    const sem = await build()
    expect((await sem.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(200)
    expect((await sem.inject({ method: 'GET', url: '/api/projects', headers: { origin: 'http://localhost:9105' } })).statusCode).toBe(200)
  })
})
