import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import Fastify, { type FastifyInstance } from 'fastify'
import { openDb, type Db } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { createSettingsService } from '../src/settings.js'
import { createPagesService, registerPageRoutes, type PagesService } from '../src/pages/service.js'
import { metaCsp } from '../src/pages/csp.js'
import { HEIGHT_SCRIPT } from '../src/pages/height-script.js'
import { createCheckShots } from '../src/pages/check-parts.js'
import { runCheck } from '../src/pages/check.js'
import { BrowserUnavailableError, type BrowserHost, type ConsoleEntry, type IsolatedPageOpts, type PreviewPage } from '../src/browser/host.js'
import type { PageNetwork } from '../../shared/visual-pages.js'

// check_page (projeto 15): a página renderizada no navegador sem tela do 16,
// contra um dublê do BrowserHost. Nada é publicado.

const temps: string[] = []
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d }

afterEach(() => {
  vi.useRealTimers()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

// --- PNG ---------------------------------------------------------------------

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** PNG RGBA de 8 bits, linhas com filtro 0 (o mesmo formato do codificador da Task 10). */
function encodePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rowBytes = 1 + width * 4
  const raw = Buffer.alloc(height * rowBytes)
  for (let y = 0; y < height; y++) raw[y * rowBytes + 1] = y & 0xff
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

const TALL = encodePng(1024, 3000)

// --- Dublê do host -------------------------------------------------------------

const CONSOLE: ConsoleEntry[] = [
  { type: 'log', text: 'pronto' },
  { type: 'warning', text: 'cuidado' },
  { type: 'error', text: "Refused to connect to 'https://example.com/' because it violates the Content Security Policy" },
  { type: 'pageerror', text: 'x is not defined' },
]

interface HostCall { opts: IsolatedPageOpts; html?: string; loadOpts?: { loadTimeoutMs?: number } }

function fakeHost(o: { loaded?: boolean; png?: Buffer; height?: number; console?: ConsoleEntry[]; fail?: unknown; hold?: boolean } = {}) {
  const calls: HostCall[] = []
  const events: string[] = []
  const held: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  const page = (call: HostCall): PreviewPage => ({
    async setContent(html, loadOpts) { call.html = html; call.loadOpts = loadOpts; events.push('setContent'); return { loaded: o.loaded ?? true } },
    async goto() { throw new Error('goto não é usado') },
    async screenshot(s) { events.push(`screenshot:${s.fullPage}`); return o.png ?? TALL },
    async contentHeight() { events.push('contentHeight'); return o.height ?? 3000 },
    consoleMessages() { events.push('console'); return o.console ?? CONSOLE },
  })
  const host: Pick<BrowserHost, 'withIsolatedPage'> = {
    async withIsolatedPage<T>(opts: IsolatedPageOpts, fn: (p: PreviewPage) => Promise<T>): Promise<T> {
      const call: HostCall = { opts }
      calls.push(call)
      if (o.hold) await new Promise<void>((resolve, reject) => { held.push({ resolve, reject }) })
      if (o.fail !== undefined) throw o.fail
      return fn(page(call))
    },
  }
  return { host, calls, events, held }
}

// --- runCheck --------------------------------------------------------------------

describe('runCheck', () => {
  let shotsDir: string
  beforeEach(() => { shotsDir = join(tmp('pg-check-shots-'), 'claudinei-check') })

  it('withIsolatedPage recebe viewport {width, 800}, offline false, timeoutMs 20000, queueTimeoutMs 30000; setContent recebe loadTimeoutMs 10000', async () => {
    const f = fakeHost()
    await runCheck(f.host as BrowserHost, '<p>oi</p>', 1280, createCheckShots({ dir: shotsDir }), { settleMs: 0 })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].opts).toEqual({ viewport: { width: 1280, height: 800 }, offline: false, timeoutMs: 20_000, queueTimeoutMs: 30_000 })
    expect(f.calls[0].html).toBe('<p>oi</p>')
    expect(f.calls[0].loadOpts).toEqual({ loadTimeoutMs: 10_000 })
  })

  it('loaded true espera settleMs antes de capturar (relógio falso)', async () => {
    vi.useFakeTimers()
    const f = fakeHost({ loaded: true })
    const p = runCheck(f.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events).toEqual(['setContent'])
    await vi.advanceTimersByTimeAsync(1499)
    expect(f.events).toEqual(['setContent'])
    await vi.advanceTimersByTimeAsync(1)
    const r = await p
    expect(f.events).toEqual(['setContent', 'contentHeight', 'screenshot:true', 'console'])
    expect(r.loaded).toBe(true)

    // settleMs próprio.
    const g = fakeHost({ loaded: true })
    const q = runCheck(g.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }), { settleMs: 300 })
    await vi.advanceTimersByTimeAsync(299)
    expect(g.events).toEqual(['setContent'])
    await vi.advanceTimersByTimeAsync(1)
    await q
    expect(g.events).toContain('screenshot:true')
  })

  it('loaded false captura sem esperar', async () => {
    vi.useFakeTimers()
    const f = fakeHost({ loaded: false })
    const p = runCheck(f.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events).toEqual(['setContent', 'contentHeight', 'screenshot:true', 'console'])
    expect((await p).loaded).toBe(false)
  })

  it('PNG cortado em 2000 e cropped true; altura 3000 no resultado', async () => {
    const f = fakeHost()
    const r = await runCheck(f.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }), { settleMs: 0 })
    expect(r.height).toBe(3000)
    expect(r.cropped).toBe(true)
    expect(pngSize(Buffer.from(r.png, 'base64'))).toEqual({ width: 1024, height: 2000 })

    // Página baixa: o PNG passa inteiro.
    const small = encodePng(1024, 600)
    const g = fakeHost({ png: small, height: 600 })
    const s = await runCheck(g.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }), { settleMs: 0 })
    expect(s).toMatchObject({ height: 600, cropped: false })
    expect(Buffer.from(s.png, 'base64').equals(small)).toBe(true)
  })

  it('console: erros primeiro, no máximo 50', async () => {
    const f = fakeHost()
    const r = await runCheck(f.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }), { settleMs: 0 })
    expect(r.console).toEqual([
      "[error] Refused to connect to 'https://example.com/' because it violates the Content Security Policy",
      '[pageerror] x is not defined',
      '[log] pronto',
      '[warning] cuidado',
    ])

    const many = [
      ...Array.from({ length: 60 }, (_, i) => ({ type: 'log', text: `linha ${i}` })),
      { type: 'error', text: 'no fim' },
    ]
    const g = fakeHost({ console: many })
    const s = await runCheck(g.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }), { settleMs: 0 })
    expect(s.console).toHaveLength(50)
    expect(s.console[0]).toBe('[error] no fim')
    expect(s.console[49]).toBe('[log] linha 48')
  })

  it('cópia gravada no dir de teste e o caminho no resultado', async () => {
    const f = fakeHost()
    const r = await runCheck(f.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }), { settleMs: 0 })
    expect(r.file.startsWith(shotsDir + '/')).toBe(true)
    expect(r.file).toMatch(/check-[0-9a-f]{16}\.png$/)
    expect(readFileSync(r.file).equals(Buffer.from(r.png, 'base64'))).toBe(true)
    expect(readdirSync(shotsDir)).toHaveLength(1)
  })

  it('pasta das cópias insegura: devolve a imagem mesmo assim, file vazio e o motivo em fileError', async () => {
    const f = fakeHost()
    const shots = createCheckShots({ dir: shotsDir, uid: () => 4_000_000 })
    const r = await runCheck(f.host as BrowserHost, '<p>oi</p>', 1024, shots, { settleMs: 0 })
    expect(r.png.length).toBeGreaterThan(0)
    expect(r.file).toBe('')
    expect(r.fileError).toMatch(/not a safe folder/)
  })

  it('erro do host sobe sem gravar cópia', async () => {
    const f = fakeHost({ fail: new Error('timeout') })
    await expect(runCheck(f.host as BrowserHost, '<p>oi</p>', 1024, createCheckShots({ dir: shotsDir }), { settleMs: 0 }))
      .rejects.toThrow('timeout')
    expect(existsSync(shotsDir)).toBe(false)
  })
})

// --- Rota ------------------------------------------------------------------------

describe('POST /api/hermes/pages/check', () => {
  let db: Db
  let root: string
  let projectId: number
  let pages: PagesService
  let sent: unknown[]
  let network: PageNetwork
  let shotsDir: string
  const apps: FastifyInstance[] = []

  beforeEach(() => {
    db = openDb(':memory:')
    root = tmp('pg-check-proj-')
    projectId = createProjectsService(db).create({ name: 'Alfa', path: root }).id
    sent = []
    network = 'cdn'
    shotsDir = join(tmp('pg-check-shots-'), 'claudinei-check')
    pages = createPagesService({
      db, dir: join(tmp('pg-check-dir-'), 'pages'), projects: createProjectsService(db),
      liveSession: () => ({ localId: 'loc-1', engineSessionId: 'conv-1' }), openTurn: () => undefined,
      broadcast: (m) => { sent.push(m) }, log: () => {},
    })
  })

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close()
  })

  const bare = (host?: Pick<BrowserHost, 'withIsolatedPage'>) => {
    const app = Fastify()
    apps.push(app)
    registerPageRoutes(app, {
      pages, manager: { get: () => undefined }, settings: createSettingsService(db),
      network: () => network, browserHost: host, shots: createCheckShots({ dir: shotsDir }), checkSettleMs: 0,
    })
    return app
  }
  const check = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/hermes/pages/check', payload: { projectId, ...payload } })
  const rows = () => db.prepare('SELECT * FROM visual_pages').all()

  it('devolve png, altura, corte, load, console e o caminho da cópia; width padrão 1024', async () => {
    const f = fakeHost()
    const res = await check(bare(f.host), { html: '<p>oi</p>' })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ height: 3000, cropped: true, loaded: true })
    expect(body.console[0]).toBe("[error] Refused to connect to 'https://example.com/' because it violates the Content Security Policy")
    expect(pngSize(Buffer.from(body.png, 'base64')).height).toBe(2000)
    expect(body.file.startsWith(shotsDir + '/')).toBe(true)
    expect(existsSync(body.file)).toBe(true)
    expect(f.calls[0].opts.viewport).toEqual({ width: 1024, height: 800 })
    // Nada publicado.
    expect(rows()).toEqual([])
    expect(sent).toEqual([])
  })

  it('o documento passado ao setContent tem a meta CSP da rede atual no início do head, sem sandbox, e o script de altura', async () => {
    const f = fakeHost()
    const app = bare(f.host)
    const html = '<!doctype html><html><head><title>t</title></head><body><p>oi</p></body></html>'
    expect((await check(app, { html, width: 800 })).statusCode).toBe(200)
    const doc = f.calls[0].html!
    expect(f.calls[0].opts.viewport).toEqual({ width: 800, height: 800 })
    const meta = `<meta http-equiv="Content-Security-Policy" content="${metaCsp('cdn')}">`
    expect(doc.startsWith(`<!doctype html><html><head>${meta}<title>t</title>`)).toBe(true)
    expect(metaCsp('cdn')).not.toContain('sandbox')
    expect(doc).not.toContain('sandbox')
    expect(doc).toContain(HEIGHT_SCRIPT)

    // A rede é lida a cada pedido.
    network = 'open'
    expect((await check(app, { html })).statusCode).toBe(200)
    expect(f.calls[1].html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${metaCsp('open')}">`)
  })

  it('path: monta como o show_page publicaria, com os recursos locais embutidos', async () => {
    writeFileSync(join(root, 'estilo.css'), 'p { color: red }')
    writeFileSync(join(root, 'rel.html'), '<html><head><link rel="stylesheet" href="estilo.css"></head><body><p>oi</p></body></html>')
    const f = fakeHost()
    const res = await check(bare(f.host), { path: 'rel.html' })
    expect(res.statusCode, res.body).toBe(200)
    expect(f.calls[0].html).toContain('p { color: red }')
    expect(f.calls[0].html).not.toContain('href="estilo.css"')
  })

  it('recusas do buildDocument saem com o código', async () => {
    const f = fakeHost()
    const app = bare(f.host)
    const both = await check(app, { html: '<p>x</p>', path: 'a.html' })
    expect(both.statusCode).toBe(400)
    expect(both.json().code).toBe('page_source')
    const nope = await app.inject({ method: 'POST', url: '/api/hermes/pages/check', payload: { projectId: 999, html: '<p>x</p>' } })
    expect(nope.statusCode).toBe(404)
    expect(f.calls).toEqual([])
  })

  it('width 359 e 1921 → 400; nada vai a visual_pages nem ao broadcast', async () => {
    const f = fakeHost()
    const app = bare(f.host)
    for (const width of [359, 1921, 1024.5, '800']) {
      const res = await check(app, { html: '<p>oi</p>', width })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('page_width')
    }
    for (const width of [360, 1920]) expect((await check(app, { html: '<p>oi</p>', width })).statusCode).toBe(200)
    expect(f.calls.map((c) => c.opts.viewport.width)).toEqual([360, 1920])
    expect(rows()).toEqual([])
    expect(sent).toEqual([])
  })

  it('fila: o dublê rejeita com { code: browser_busy } → 503 busy, try again; sem semáforo, os três pedidos chegam ao host', async () => {
    const f = fakeHost({ hold: true, fail: { code: 'browser_busy' } })
    const app = bare(f.host)
    const all = Promise.all([0, 1, 2].map(() => check(app, { html: '<p>oi</p>' })))
    for (let i = 0; i < 100 && f.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 5))
    expect(f.calls).toHaveLength(3)
    for (const h of f.held) h.resolve()
    for (const res of await all) {
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toBe('busy, try again')
    }
  })

  it('navegador ausente: BrowserUnavailableError com hint → 503 com a mensagem e o hint', async () => {
    const launch = new BrowserUnavailableError('launch_failed', 'Failed to launch chromium', 'executable: /opt/chrome')
    const res = await check(bare(fakeHost({ fail: launch }).host), { html: '<p>oi</p>' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('Failed to launch chromium. executable: /opt/chrome')

    // Não instalado: a mensagem já traz o comando; o hint não se repete.
    const missing = new BrowserUnavailableError('browser_not_installed', 'Browser not installed. On the server, run `npx x`', 'npx x')
    const r2 = await check(bare(fakeHost({ fail: missing }).host), { html: '<p>oi</p>' })
    expect(r2.statusCode).toBe(503)
    expect(r2.json().error).toBe('Browser not installed. On the server, run `npx x`')

    // Hint vazio: só a mensagem.
    const shut = new BrowserUnavailableError('launch_failed', 'browser host is shutting down', '')
    const r3 = await check(bare(fakeHost({ fail: shut }).host), { html: '<p>oi</p>' })
    expect(r3.statusCode).toBe(503)
    expect(r3.json().error).toBe('browser host is shutting down')

    // Reconhecido pelo code, não pela classe.
    const plain = { code: 'launch_failed', message: 'spawn EACCES', hint: 'executable: /x' }
    const r4 = await check(bare(fakeHost({ fail: plain }).host), { html: '<p>oi</p>' })
    expect(r4.statusCode).toBe(503)
    expect(r4.json().error).toBe('spawn EACCES. executable: /x')
  })

  it('timeout do host → 504', async () => {
    const res = await check(bare(fakeHost({ fail: new Error('timeout') }).host), { html: '<p>oi</p>' })
    expect(res.statusCode).toBe(504)
    expect(res.json().error).toBe('the page stayed open longer than 20 s')
  })

  it('outra falha → 500 com o motivo', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await check(bare(fakeHost({ fail: new Error('Target crashed') }).host), { html: '<p>oi</p>' })
      expect(res.statusCode).toBe(500)
      expect(res.json().error).toBe('could not check the page: Target crashed')
    } finally { err.mockRestore() }
  })

  it('sem host → 503 browser not available', async () => {
    const res = await check(bare(undefined), { html: '<p>oi</p>' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('browser not available')
  })

  it('corpo acima de 2 MiB dá 413', async () => {
    const f = fakeHost()
    const res = await check(bare(f.host), { html: 'x'.repeat(2 * 1024 * 1024 + 10) })
    expect(res.statusCode).toBe(413)
    expect(f.calls).toEqual([])
  })

  it('no app: o host do AppDeps chega à rota; token de serviço passa, usuário sem acesso dá 403', async () => {
    const auth = createAuthService({ db })
    const manager = createSessionManager({ db, broadcast: () => {} })
    const f = fakeHost({ fail: { code: 'browser_busy' } })
    const app = await buildApp({
      config: loadConfig({ CLAUDINEI_PAGES: join(tmp('pg-check-app-'), 'pages') }), db, manager, auth,
      browserHost: f.host as BrowserHost,
    })
    apps.push(app)
    const other = createProjectsService(db).create({ name: 'Beta', path: tmp('pg-check-beta-') }).id
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [other] })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } })
    const c = login.cookies.find((x: any) => x.name === COOKIE_NAME)!
    const service = { authorization: `Bearer ${auth.tokens.signService()}` }

    const res = await app.inject({ method: 'POST', url: '/api/hermes/pages/check', headers: service, payload: { projectId, html: '<p>oi</p>' } })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('busy, try again')
    expect(f.calls).toHaveLength(1)

    const forbidden = await app.inject({
      method: 'POST', url: '/api/hermes/pages/check', cookies: { [COOKIE_NAME]: c.value }, payload: { projectId, html: '<p>oi</p>' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(f.calls).toHaveLength(1)

    // Sem host no AppDeps: 503.
    const semHost = await buildApp({ config: loadConfig({ CLAUDINEI_PAGES: join(tmp('pg-check-app-'), 'pages') }), db, manager, auth })
    apps.push(semHost)
    const r2 = await semHost.inject({ method: 'POST', url: '/api/hermes/pages/check', headers: service, payload: { projectId, html: '<p>oi</p>' } })
    expect(r2.statusCode).toBe(503)
    expect(r2.json().error).toBe('browser not available')
  })
})
