import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import Fastify from 'fastify'
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
import { createPreviewStore } from '../src/files/preview.js'
import { createPagesService, registerPageRoutes, type PagesService } from '../src/pages/service.js'
import { CONTENT_HEIGHT_EXPR, HEIGHT_SCRIPT, withDoctype, withHeightScript } from '../src/pages/height-script.js'
import type { PageNetwork } from '../../shared/visual-pages.js'

/**
 * Mostrar a página: listar as da conversa, buscar por id, emitir o token de
 * exibição e servir o documento isolado (CSP com sandbox, script de altura).
 */

const CDN = 'https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com'
const CSP_CDN = `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${CDN}; style-src 'unsafe-inline' ${CDN} https://fonts.googleapis.com; font-src data: ${CDN} https://fonts.gstatic.com; img-src data: blob: ${CDN}; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'`
const CSP_OPEN = "sandbox allow-scripts; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src *; form-action 'none'; base-uri 'none'"
const EXPIRED_TEXTS = [
  'Esta página expirou ou não existe. Reabra pelo Claudinei.',
  'This page has expired or does not exist. Reopen it from Claudinei.',
  'Esta página caducó o no existe. Vuelve a abrirla desde Claudinei.',
]

const temps: string[] = []
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d }

let db: Db
let auth: AuthService
let hub: ReturnType<typeof createWsHub>
let app: Awaited<ReturnType<typeof buildApp>>
let pagesDir: string
let service: PagesService
let p1: number, p2: number
let anaId: number
let admin: string, ana: string
let seq = 0

const cookieOf = (res: any): string => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return `${COOKIE_NAME}=${c.value}`
}
const login = async (username: string) =>
  cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))

/** Sessão só no banco: a listagem usa projeto, motor e id da conversa, não o processo. */
const addSession = (localId: string, projectId: number, engine: string, conversationId: string | null) => {
  db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, engine) VALUES (?, ?, ?, 'dead', ?)`)
    .run(localId, conversationId, projectId, engine)
}

/** Página com linha e arquivo, como o publish deixaria. */
const addPage = (o: { projectId: number; localId: string; conversationId: string | null; engine?: string; title?: string; html?: string }) => {
  const id = `pg_${(++seq).toString(16).padStart(16, '0')}`
  const page = service.store.insert({
    id, projectId: o.projectId, engine: o.engine ?? 'claude', localId: o.localId, conversationId: o.conversationId,
    turnId: null, turnKey: null, title: o.title ?? id, height: null, bytes: 1, source: 'html', sourcePath: null,
  })
  writeFileSync(service.filePath(id), o.html ?? `<html><body><p>${id}</p></body></html>`)
  return page
}

const viewUrl = async (id: string, cookie = admin, remoteAddress?: string): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: `/api/pages/${id}/view`, headers: { cookie }, ...(remoteAddress ? { remoteAddress } : {}) })
  expect(res.statusCode, res.body).toBe(200)
  return res.json().url as string
}

beforeEach(async () => {
  seq = 0
  db = openDb(':memory:')
  auth = createAuthService({ db })
  hub = createWsHub()
  pagesDir = join(tmp('pg-view-'), 'pages')
  const manager = createSessionManager({ db, broadcast: (m) => hub.broadcast(m) })
  app = await buildApp({
    config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager, auth, wsHub: hub,
    onRevokeAll: () => hub.closeAll(), onUserInvalidated: (id) => hub.closeUser(id),
  })
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: tmp('pg-p1-') }).id
  p2 = projects.create({ name: 'Beta', path: tmp('pg-p2-') }).id
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  anaId = auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1] }).id
  // O mesmo banco e a mesma pasta do app: as páginas entram por aqui, sem sessão viva.
  service = createPagesService({
    db, dir: pagesDir, projects, liveSession: () => undefined, openTurn: () => undefined,
    broadcast: () => {}, log: () => {},
  })
  // A pasta nasce no primeiro publish; aqui as páginas são gravadas à mão.
  mkdirSync(pagesDir, { recursive: true })
  admin = await login('root')
  ana = await login('ana')
})

afterEach(async () => {
  await app.close()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('listar e buscar', () => {
  it('listagem por conversa: ordem de criação; outra conversa do mesmo terminal fica de fora; sem engineSessionId, por localId', async () => {
    addSession('loc-a', p1, 'claude', 'conv-2')
    const velha = addPage({ projectId: p1, localId: 'loc-a', conversationId: 'conv-1' })
    const a = addPage({ projectId: p1, localId: 'loc-a', conversationId: 'conv-2' })
    const b = addPage({ projectId: p1, localId: 'loc-a', conversationId: 'conv-2' })
    // Mesmo id de conversa noutro motor não entra.
    addPage({ projectId: p1, localId: 'loc-x', conversationId: 'conv-2', engine: 'codex' })
    const res = await app.inject({ method: 'GET', url: '/api/sessions/loc-a/pages', headers: { cookie: admin } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([a, b])
    expect(res.json().map((p: any) => p.id)).not.toContain(velha.id)

    addSession('loc-b', p1, 'claude', null)
    const c = addPage({ projectId: p1, localId: 'loc-b', conversationId: null })
    addPage({ projectId: p1, localId: 'loc-a', conversationId: null })
    const semId = await app.inject({ method: 'GET', url: '/api/sessions/loc-b/pages', headers: { cookie: admin } })
    expect(semId.json()).toEqual([c])

    const nada = await app.inject({ method: 'GET', url: '/api/sessions/nao-existe/pages', headers: { cookie: admin } })
    expect(nada.statusCode).toBe(404)
  })

  it('listagem e view sem acesso ao projeto: 403; admin vê tudo', async () => {
    addSession('loc-2', p2, 'claude', 'conv-9')
    const page = addPage({ projectId: p2, localId: 'loc-2', conversationId: 'conv-9' })
    expect((await app.inject({ method: 'GET', url: '/api/sessions/loc-2/pages', headers: { cookie: ana } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/pages/${page.id}/view`, headers: { cookie: ana } })).statusCode).toBe(403)
    const lista = await app.inject({ method: 'GET', url: '/api/sessions/loc-2/pages', headers: { cookie: admin } })
    expect(lista.json()).toEqual([page])
    expect((await app.inject({ method: 'POST', url: `/api/pages/${page.id}/view`, headers: { cookie: admin } })).statusCode).toBe(200)

    // Quem tem acesso ao projeto vê.
    addSession('loc-1', p1, 'claude', 'conv-1')
    const dela = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    expect((await app.inject({ method: 'GET', url: '/api/sessions/loc-1/pages', headers: { cookie: ana } })).json()).toEqual([dela])
    expect((await app.inject({ method: 'POST', url: `/api/pages/${dela.id}/view`, headers: { cookie: ana } })).statusCode).toBe(200)
  })

  it('GET /api/pages/:id: com acesso devolve o DTO; sem acesso 403; apagada 404', async () => {
    const dela = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1', title: 'Gráfico' })
    const alheia = addPage({ projectId: p2, localId: 'loc-2', conversationId: 'conv-2' })
    const res = await app.inject({ method: 'GET', url: `/api/pages/${dela.id}`, headers: { cookie: ana } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(dela)
    expect((await app.inject({ method: 'GET', url: `/api/pages/${alheia.id}`, headers: { cookie: ana } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/pages/${alheia.id}`, headers: { cookie: admin } })).json()).toEqual(alheia)
    service.store.remove([dela.id])
    expect((await app.inject({ method: 'GET', url: `/api/pages/${dela.id}`, headers: { cookie: ana } })).statusCode).toBe(404)
  })

  it('view: 404 sem linha ou sem arquivo', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    rmSync(service.filePath(page.id))
    expect((await app.inject({ method: 'POST', url: `/api/pages/${page.id}/view`, headers: { cookie: ana } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/pages/pg_ffffffffffffffff/view', headers: { cookie: ana } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/pages/..%2Fx/view', headers: { cookie: admin } })).statusCode).toBe(404)
  })
})

describe('abrir e servir', () => {
  it('view emite token novo a cada pedido (cartão e tela cheia têm tokens distintos)', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    const cartao = await viewUrl(page.id, ana)
    const telaCheia = await viewUrl(page.id, ana)
    const forma = new RegExp(`^/api/pages/view/[A-Za-z0-9_-]{43}/${page.id}\\.html$`)
    expect(cartao).toMatch(forma)
    expect(telaCheia).toMatch(forma)
    expect(cartao).not.toBe(telaCheia)
    // Os dois valem.
    expect((await app.inject({ method: 'GET', url: cartao })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: telaCheia })).statusCode).toBe(200)
  })

  it('servir: corpo com o script de altura antes de </body>; Content-Security-Policy igual à string cdn verbatim; X-Frame-Options SAMEORIGIN; no-store; nosniff; no-referrer; Permissions-Policy', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1', html: '<html><body><h1>oi</h1></body></html>' })
    const res = await app.inject({ method: 'GET', url: await viewUrl(page.id, ana) })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(`<html><body><h1>oi</h1><script id="claudinei-page-height">${HEIGHT_SCRIPT}</script></body></html>`)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['content-security-policy']).toBe(CSP_CDN)
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), display-capture=()')
  })

  it('servir: token de outro endereço (remoteAddress diferente no inject) dá 404', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    const url = await viewUrl(page.id, ana, '10.0.0.5')
    expect((await app.inject({ method: 'GET', url, remoteAddress: '10.0.0.6' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url, remoteAddress: '10.0.0.5' })).statusCode).toBe(200)
  })

  it('servir: accessAllowed que passa a falso revoga o token (404)', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    const url = await viewUrl(page.id, ana)
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200)
    auth.users.bumpTokenVersion(anaId) // sessão de quem emitiu revogada
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain(EXPIRED_TEXTS[0])
  })

  it('servir: token válido com outro id, outro nome de arquivo ou ../ dá 404', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    const outra = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    const url = await viewUrl(page.id, ana)
    const token = url.split('/')[4]
    const tentativas = [
      `/api/pages/view/${token}/${outra.id}.html`,
      `/api/pages/view/${token}/${page.id}.htm`,
      `/api/pages/view/${token}/${page.id}`,
      `/api/pages/view/${token}/${page.id}.html.bak`,
      `/api/pages/view/${token}/..%2F${page.id}.html`,
      `/api/pages/view/${token}/..%2Fpages%2F${page.id}.html`,
      `/api/pages/view/${token}x/${page.id}.html`,
    ]
    for (const t of tentativas) {
      const res = await app.inject({ method: 'GET', url: t })
      expect(res.statusCode, t).toBe(404)
      expect(res.body, t).not.toContain(page.id + '</p>')
    }
    // Segmento a mais não tem a forma da rota pública: exige cookie (401) e não serve nada.
    const extra = await app.inject({ method: 'GET', url: `/api/pages/view/${token}/x/${page.id}.html` })
    expect(extra.statusCode).toBe(401)
    expect(extra.body).not.toContain(page.id + '</p>')
    // O próprio token continua valendo para a página dele.
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200)
  })

  it('servir sem cookie funciona (rota pública pelo token); /api/pages/:id sem cookie dá 401', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    const url = await viewUrl(page.id, ana)
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`<p>${page.id}</p>`)
    expect((await app.inject({ method: 'GET', url: `/api/pages/${page.id}` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: `/api/pages/${page.id}/view` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/sessions/loc-1/pages' })).statusCode).toBe(401)
    // Pública só para GET.
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401)
  })

  it('/api/pages/view%2F… não passa por pública: o router a leva a /api/pages/:id, que exige cookie (401)', async () => {
    const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
    for (const u of [`/api/pages/view%2F${page.id}`, `/api/pages/view%2Ftok%2F${page.id}.html`, '/api/pages/view/só-um-segmento']) {
      expect((await app.inject({ method: 'GET', url: u })).statusCode, u).toBe(401)
    }
    // A forma certa, com cookie nenhum, continua pública (404 de token desconhecido, não 401).
    expect((await app.inject({ method: 'GET', url: `/api/pages/view/tok/${page.id}.html` })).statusCode).toBe(404)
  })
})

describe('token com relógio e rede injetados (rotas soltas, sem auth)', () => {
  it('servir: token expirado (store com now injetado) dá a página de 404 com o texto nas três línguas; a rede é lida a cada pedido', async () => {
    let agora = 1_000
    let network: PageNetwork = 'cdn'
    const bare = Fastify()
    registerPageRoutes(bare, {
      pages: service, manager: { get: () => undefined }, settings: createSettingsService(db),
      views: createPreviewStore({ now: () => agora }), network: () => network,
    })
    try {
      const page = addPage({ projectId: p1, localId: 'loc-1', conversationId: 'conv-1' })
      const { url } = (await bare.inject({ method: 'POST', url: `/api/pages/${page.id}/view` })).json()
      expect((await bare.inject({ method: 'GET', url })).headers['content-security-policy']).toBe(CSP_CDN)
      network = 'open'
      expect((await bare.inject({ method: 'GET', url })).headers['content-security-policy']).toBe(CSP_OPEN)

      agora += 10 * 60_000 - 1
      expect((await bare.inject({ method: 'GET', url })).statusCode).toBe(200)
      agora += 1
      const res = await bare.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
      expect(res.headers['cache-control']).toBe('no-store')
      for (const t of EXPIRED_TEXTS) expect(res.body).toContain(t)
    } finally {
      await bare.close()
    }
  })
})

describe('/ws', () => {
  it('visual_page de projeto alheio não chega ao não-admin pelo /ws; chega ao admin e a quem tem acesso', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const base = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`
    const queues = new Map<WebSocket, any[]>()
    const open = (cookie: string) => {
      const ws = new WebSocket(`${base}/ws`, { headers: { cookie } })
      const q: any[] = []
      queues.set(ws, q)
      ws.on('message', (d) => q.push(JSON.parse(d.toString())))
      return { ws, opened: new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) }) }
    }
    const next = async (ws: WebSocket, ms = 3000) => {
      const q = queues.get(ws)!
      const start = Date.now()
      while (q.length === 0) {
        if (Date.now() - start > ms) throw new Error('timeout')
        await new Promise((r) => setTimeout(r, 10))
      }
      return q.shift()
    }
    const a = open(ana)
    const r = open(admin)
    await Promise.all([a.opened, r.opened])
    await Promise.all([next(a.ws), next(r.ws)]) // snapshots
    const msg = (projectId: number, id: string) =>
      ({ type: 'visual_page', projectId, engine: 'claude', localId: 'loc', page: { id, projectId } })
    hub.broadcast(msg(p2, 'pg_alheia'))
    hub.broadcast(msg(p1, 'pg_dela'))
    await expect(next(r.ws)).resolves.toMatchObject({ type: 'visual_page', page: { id: 'pg_alheia' } })
    await expect(next(r.ws)).resolves.toMatchObject({ type: 'visual_page', page: { id: 'pg_dela' } })
    // Só a do projeto dela chega; a alheia ficou para trás.
    await expect(next(a.ws)).resolves.toMatchObject({ type: 'visual_page', page: { id: 'pg_dela' } })
    await expect(next(a.ws, 300)).rejects.toThrow('timeout')
    a.ws.close(); r.ws.close()
  })
})

describe('withHeightScript', () => {
  const tag = `<script id="claudinei-page-height">${HEIGHT_SCRIPT}</script>`
  it('antes do último </body>, sem diferenciar maiúsculas; sem </body>, no fim', () => {
    expect(withHeightScript('<BODY>a</BODY>')).toBe(`<BODY>a${tag}</BODY>`)
    expect(withHeightScript('<body><script>"</body>"</script>b</body >x</Body>')).toBe(`<body><script>"</body>"</script>b</body >x${tag}</Body>`)
    expect(withHeightScript('<p>solto</p>')).toBe(`<p>solto</p>${tag}`)
    expect(HEIGHT_SCRIPT).not.toMatch(/<\/script/i)
  })
})

describe('script de altura', () => {
  /** Página dublada: ResizeObserver, setTimeout e parent.postMessage com relógio manual. */
  const harness = () => {
    let height = 500
    let now = 0
    const timers: { at: number; fn: () => void }[] = []
    const sent: { msg: any; target: string; at: number }[] = []
    const observers: (() => void)[] = []
    const el = () => ({ getBoundingClientRect: () => ({ height }), get scrollHeight() { return height } })
    const ctx: any = {
      document: { documentElement: el(), body: el() },
      ResizeObserver: class { constructor(cb: () => void) { observers.push(cb) } observe() {} },
      setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + (ms ?? 0), fn }); return timers.length },
      parent: { postMessage: (msg: any, target: string) => sent.push({ msg, target, at: now }) },
    }
    ctx.window = ctx
    runInNewContext(HEIGHT_SCRIPT, ctx)
    const advance = (ms: number) => {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const t = timers[0]
        if (!t || t.at > end) break
        timers.shift()
        now = t.at
        t.fn()
      }
      now = end
    }
    const resize = (h: number) => { height = h; for (const cb of observers) cb() }
    return { sent, advance, resize, observers }
  }

  it('manda a primeira altura; mudança de 3 px não manda; de 4 px manda; duas mudanças em 50 ms viram uma mensagem depois de 200 ms', () => {
    const h = harness()
    expect(h.observers.length).toBeGreaterThan(0)
    h.resize(500) // a primeira observação do ResizeObserver
    h.advance(0)
    expect(h.sent.map((s) => s.msg)).toEqual([{ type: 'claudinei-page-height', height: 500 }])
    expect(h.sent[0].target).toBe('*')

    h.advance(1000)
    h.resize(503)
    h.advance(1000)
    expect(h.sent).toHaveLength(1)

    h.resize(504)
    h.advance(1000)
    expect(h.sent.map((s) => s.msg.height)).toEqual([500, 504])

    const t0 = 5000
    h.advance(t0 - 3000) // relógio em 5000
    h.resize(600)
    h.advance(50)
    h.resize(700)
    h.advance(149)
    expect(h.sent).toHaveLength(2)
    h.advance(1)
    expect(h.sent.map((s) => s.msg.height)).toEqual([500, 504, 700])
    expect(h.sent[2].at).toBe(t0 + 200)
    h.advance(1000)
    expect(h.sent).toHaveLength(3)
  })

  it('no máximo uma mensagem a cada 200 ms, mesmo com mudanças seguidas', () => {
    const h = harness()
    h.resize(500)
    h.advance(0)
    for (let i = 1; i <= 20; i++) { h.resize(500 + i * 10); h.advance(30) }
    h.advance(1000)
    const ats = h.sent.map((s) => s.at)
    for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1]).toBeGreaterThanOrEqual(200)
    expect(h.sent.at(-1)!.msg.height).toBe(700)
  })
})

describe('expressão da altura do conteúdo', () => {
  const el = (rect: number, scroll: number) => ({ getBoundingClientRect: () => ({ height: rect }), scrollHeight: scroll })
  const measure = (document: unknown, innerHeight = 800) => runInNewContext(CONTENT_HEIGHT_EXPR, { document, window: { innerHeight } })

  it('o script de altura usa a mesma expressão (o texto não é duplicado)', () => {
    expect(HEIGHT_SCRIPT).toContain(CONTENT_HEIGHT_EXPR)
  })

  it('o maior entre a caixa do <html> e o scrollHeight do <body>, arredondado para cima; sem body, só o <html>', () => {
    // Página baixa: o scrollHeight do <html> seria o viewport; a caixa dele, não.
    expect(measure({ documentElement: el(79.875, 800), body: el(0, 37) })).toBe(80)
    // Conteúdo que transborda o body (altura fixa menor que o conteúdo).
    expect(measure({ documentElement: el(100, 800), body: el(100, 2500) })).toBe(2500)
    expect(measure({ documentElement: el(8.2, 800), body: null })).toBe(9)
    expect(measure({ documentElement: null, body: null })).toBe(0)
  })

  it('com transbordo de verdade (scrollHeight do <html> acima do viewport), ele também conta: conteúdo absoluto mede a altura real', () => {
    // Só conteúdo position:absolute: a caixa do <html> e o body ficam em 0,
    // mas o documento rola até 1500.
    expect(measure({ documentElement: el(0, 1500), body: el(0, 0) }, 800)).toBe(1500)
    // Sem transbordo, o scrollHeight do <html> é o viewport e não conta.
    expect(measure({ documentElement: el(0, 800), body: el(0, 0) }, 800)).toBe(0)
    expect(measure({ documentElement: el(79.875, 800), body: el(0, 37) }, 800)).toBe(80)
    // Com transbordo, nunca abaixo da caixa do <html> nem do body.
    expect(measure({ documentElement: el(2000.5, 1900), body: el(0, 1800) }, 800)).toBe(2001)
  })
})

describe('withDoctype', () => {
  it('sem doctype no começo, acrescenta `<!doctype html>` (sem ele a página cai no modo quirks e mede o viewport)', () => {
    expect(withDoctype('<h1>oi</h1>')).toBe('<!doctype html><h1>oi</h1>')
    expect(withDoctype('<html><body>x</body></html>')).toBe('<!doctype html><html><body>x</body></html>')
    expect(withDoctype('<!-- só comentário --><p>x</p>')).toBe('<!doctype html><!-- só comentário --><p>x</p>')
    expect(withDoctype('')).toBe('<!doctype html>')
    // BOM fica na frente.
    expect(withDoctype('\uFEFF<p>x</p>')).toBe('\uFEFF<!doctype html><p>x</p>')
    // Um doctype no meio do documento não conta.
    expect(withDoctype('<p>x</p><!doctype html>')).toBe('<!doctype html><p>x</p><!doctype html>')
  })

  it('com doctype no começo (depois de espaços, comentários e BOM, sem diferenciar maiúsculas), não mexe', () => {
    for (const html of [
      '<!doctype html><p>x</p>',
      '<!DOCTYPE html>\n<html></html>',
      '  \n\t<!DocType html><p>x</p>',
      '<!-- gerado --><!doctype html><p>x</p>',
      '\uFEFF<!doctype html><p>x</p>',
      '\uFEFF \n<!-- a -->\n<!-- b --> <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x</p>',
    ]) expect(withDoctype(html)).toBe(html)
  })
})
