// O WebSocket da tela (`/ws/browser/:projectId/:engine`) com o servidor de
// verdade em porta efêmera, cliente `ws` e o host sobre o dublê do Chromium.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { decodeFrame } from '../src/browser/frame.js'
import type { FrameHeader } from '../../shared/browser.js'
import { browserApp, until, type BrowserAppFixture } from './browser-app-fixture.js'
import type { FakeCDPSession, FakePage } from './browser-fakes.js'

let f: BrowserAppFixture
let port: number
const sockets: WebSocket[] = []

beforeEach(async () => {
  f = await browserApp()
  await f.app.listen({ port: 0, host: '127.0.0.1' })
  port = (f.app.server.address() as { port: number }).port
})

afterEach(async () => {
  vi.useRealTimers()
  for (const ws of sockets.splice(0)) if (ws.readyState !== ws.CLOSED) ws.terminate()
  await f.close()
})

const cookieHeader = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')

interface Client {
  ws: WebSocket
  texts: any[]
  bins: Array<{ header: FrameHeader; image: Buffer }>
  opened: Promise<void>
  closed: Promise<{ code: number; reason: string }>
  send(m: object): void
}

function connect(o: { cookies?: Record<string, string>; origin?: string; projectId?: number; engine?: string } = {}): Client {
  const headers: Record<string, string> = {}
  if (o.cookies) headers.cookie = cookieHeader(o.cookies)
  if (o.origin) headers.origin = o.origin
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${o.projectId ?? f.p1.id}/${o.engine ?? 'claude'}`, { headers })
  sockets.push(ws)
  const texts: any[] = []
  const bins: Client['bins'] = []
  // Os ouvintes nascem junto com o socket: a primeira mensagem não se perde.
  ws.on('message', (d, isBinary) => {
    if (isBinary) bins.push(decodeFrame(d as Buffer))
    else texts.push(JSON.parse(d.toString()))
  })
  const opened = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  opened.catch(() => { /* quem espera trata */ })
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })))
  return { ws, texts, bins, opened, closed, send: (m) => ws.send(JSON.stringify(m)) }
}

const tabUrl = (projectId: number, engine = 'claude') => `/api/projects/${projectId}/terminals/${engine}/browser`

async function openTab(projectId = f.p1.id) {
  const res = await f.app.inject({ method: 'POST', url: tabUrl(projectId), cookies: f.adminCookie })
  expect(res.statusCode).toBe(200)
  const tab = f.host.existingTab({ projectId, engine: 'claude' })!
  const ctx = f.fl.browsers.at(-1)!.contexts.at(-1)!
  return { tab, ctx, page: ctx.pages.at(-1) as FakePage }
}

const anaId = () => f.auth.users.getByUsername('ana')!.id
const rootId = () => f.auth.users.getByUsername('root')!.id
const lastState = (c: Client) => c.texts.filter((t) => t.type === 'state').at(-1)

/** A sessão CDP do screencast, depois que ele começou. */
async function screencastSession(ctx: { cdpSessions: FakeCDPSession[] }): Promise<FakeCDPSession> {
  await until(() => ctx.cdpSessions.some((s) => s.calls('Page.startScreencast').length > 0))
  return ctx.cdpSessions.find((s) => s.calls('Page.startScreencast').length > 0)!
}

const frameEvent = (data: string) => ({ data: Buffer.from(data).toString('base64'), sessionId: 1, metadata: {} })

describe('acesso', () => {
  it('sem cookie → 401 no upgrade', async () => {
    await openTab()
    const c = connect()
    await expect(c.opened).rejects.toThrow('401')
  })

  it('origem de outro site → fecha 1008', async () => {
    await openTab()
    const c = connect({ cookies: f.adminCookie, origin: 'https://malicioso.example' })
    expect(await c.closed).toEqual({ code: 1008, reason: 'origin' })
    expect(c.texts).toEqual([])
  })

  it('origem de outra porta do localhost → fecha 1008', async () => {
    await openTab()
    for (const origin of [`http://127.0.0.1:${port + 1}`, 'http://localhost:3000']) {
      const c = connect({ cookies: f.adminCookie, origin })
      expect(await c.closed, origin).toEqual({ code: 1008, reason: 'origin' })
      expect(c.texts).toEqual([])
    }
  })

  it('mesma origem → abre', async () => {
    await openTab()
    const c = connect({ cookies: f.adminCookie, origin: `http://127.0.0.1:${port}` })
    await c.opened
    await until(() => c.texts.some((t) => t.type === 'state'))
  })

  it('usuário sem acesso ao projeto → 1008', async () => {
    await openTab(f.p2.id)
    const c = connect({ cookies: f.anaCookie, projectId: f.p2.id })
    expect(await c.closed).toEqual({ code: 1008, reason: 'forbidden' })
    expect(c.texts).toEqual([])
    // Projeto que não existe, idem.
    const none = connect({ cookies: f.adminCookie, projectId: 9999 })
    expect((await none.closed).code).toBe(1008)
  })

  it('motor desconhecido → 1008', async () => {
    await openTab()
    const c = connect({ cookies: f.adminCookie, engine: 'inventado' })
    expect(await c.closed).toEqual({ code: 1008, reason: 'engine' })
  })

  it('fora do horário de acesso → 1008', async () => {
    await openTab()
    const c = connect({ cookies: f.anaCookie })
    await c.opened
    await until(() => !!lastState(c))
    // Uma janela que não inclui hoje: o vigia do horário fecha em até 1 s.
    const otherDay = (new Date().getUTCDay() + 3) % 7
    f.auth.users.update(anaId(), { accessHours: { timeZone: 'UTC', windows: [{ days: [otherDay], start: '09:00', end: '10:00' }] } })
    expect(await c.closed).toEqual({ code: 1008, reason: 'access_hours' })
  })
})

describe('revogação', () => {
  it('closeUser(id) fecha os sockets dele com 1008 e não os de outro', async () => {
    await openTab()
    const ana = connect({ cookies: f.anaCookie })
    const root = connect({ cookies: f.adminCookie })
    await Promise.all([ana.opened, root.opened])
    f.feature!.closeUser(anaId())
    expect(await ana.closed).toEqual({ code: 1008, reason: 'revoked' })
    await new Promise((r) => setTimeout(r, 50))
    expect(root.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('closeAll fecha todos', async () => {
    await openTab()
    const ana = connect({ cookies: f.anaCookie })
    const root = connect({ cookies: f.adminCookie })
    await Promise.all([ana.opened, root.opened])
    f.feature!.closeAll()
    expect((await ana.closed).code).toBe(1008)
    expect((await root.closed).code).toBe(1008)
  })

  it('socket revogado (em CLOSING) não manda entrada à página', async () => {
    const { tab, page } = await openTab()
    const ana = connect({ cookies: f.anaCookie })
    await ana.opened
    await until(() => !!lastState(ana))
    // As mensagens saem do cliente agora e só chegam ao servidor depois do
    // closeUser, com o socket já em CLOSING (a revogação não troca o token).
    ana.send({ type: 'pointer', phase: 'down', x: 1, y: 1, button: 'left', clickCount: 1 })
    ana.send({ type: 'text', text: 'depois da revogação' })
    ana.send({ type: 'take' })
    ana.send({ type: 'navigate', url: 'http://localhost:1/x' })
    f.feature!.closeUser(anaId())
    expect((await ana.closed).code).toBe(1008)
    await new Promise((r) => setTimeout(r, 50))
    expect(page.calls).toEqual([])
    expect(page.navigations).toEqual([])
    expect(tab.baton.state()).toEqual({ kind: 'free' })
  })

  it('closeUser tira o espectador na hora, sem esperar o fechamento', async () => {
    const { tab } = await openTab()
    const ana = connect({ cookies: f.anaCookie })
    await ana.opened
    ana.send({ type: 'visible', visible: true })
    ana.send({ type: 'take' })
    await until(() => tab.baton.state().kind === 'operator' && tab.isVisible())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    f.feature!.closeUser(anaId())
    // Síncrono: a coluna sumiu e a presença do bastão já conta os 30 s.
    expect(tab.isVisible()).toBe(false)
    expect((await ana.closed).code).toBe(1008)
    vi.advanceTimersByTime(30_000)
    expect(tab.baton.state()).toEqual({ kind: 'free' })
  })

  it('revogação com o operador no comando: 30 s depois o bastão volta ao agente', async () => {
    const { tab } = await openTab()
    const ana = connect({ cookies: f.anaCookie })
    await ana.opened
    ana.send({ type: 'visible', visible: true })
    ana.send({ type: 'take' })
    await until(() => tab.baton.state().kind === 'operator' && tab.isVisible())
    expect(tab.baton.state()).toMatchObject({ kind: 'operator', userId: anaId(), name: 'ana' })
    // Só os relógios de espera são falsos: a rede segue de verdade.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    f.feature!.closeUser(anaId())
    expect((await ana.closed).code).toBe(1008)
    // O servidor tirou o espectador (a coluna deixou de ser visível).
    const t0 = Date.now()
    while (tab.isVisible()) {
      if (Date.now() - t0 > 2000) throw new Error('o espectador não saiu')
      await new Promise((r) => setImmediate(r))
    }
    vi.advanceTimersByTime(29_000)
    expect(tab.baton.state().kind).toBe('operator')
    vi.advanceTimersByTime(1_000)
    expect(tab.baton.state()).toEqual({ kind: 'free' })
    expect(tab.takeAgentNotices()).toContain('control returned to the agent')
  })
})

describe('tela', () => {
  it("visible:true começa o screencast e o primeiro binário chega com cabeçalho 'frame'", async () => {
    const { ctx } = await openTab()
    const c = connect({ cookies: f.adminCookie })
    await c.opened
    await until(() => !!lastState(c))
    expect(lastState(c)).toMatchObject({ type: 'state', url: 'about:blank', baton: { kind: 'free' }, viewport: { width: 1280, height: 800 } })
    c.send({ type: 'visible', visible: true })
    const cdp = await screencastSession(ctx)
    cdp.emit('Page.screencastFrame', frameEvent('jpeg-1'))
    await until(() => c.bins.length > 0)
    expect(c.bins[0].header).toMatchObject({ kind: 'frame', width: 1280, height: 800 })
    expect(c.bins[0].image.toString()).toBe('jpeg-1')
  })

  it('sem visible nada binário chega', async () => {
    const { ctx } = await openTab()
    const seen = connect({ cookies: f.adminCookie })
    const hidden = connect({ cookies: f.anaCookie })
    await Promise.all([seen.opened, hidden.opened])
    await until(() => !!lastState(hidden))
    seen.send({ type: 'visible', visible: true })
    const cdp = await screencastSession(ctx)
    cdp.emit('Page.screencastFrame', frameEvent('jpeg-1'))
    await until(() => seen.bins.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(hidden.bins).toEqual([])
  })

  it("freeze on devolve um 'still' PNG só a quem pediu", async () => {
    const { page } = await openTab()
    const a = connect({ cookies: f.adminCookie })
    const b = connect({ cookies: f.anaCookie })
    await Promise.all([a.opened, b.opened])
    a.send({ type: 'visible', visible: true })
    b.send({ type: 'visible', visible: true })
    a.send({ type: 'freeze', on: true })
    await until(() => a.bins.some((x) => x.header.kind === 'still'))
    const still = a.bins.find((x) => x.header.kind === 'still')!
    expect(still.header).toMatchObject({ kind: 'still', width: 1280, height: 800 })
    expect(still.image.toString()).toBe('png')
    expect(page.screenshots).toContainEqual({ type: 'png' })
    await new Promise((r) => setTimeout(r, 50))
    expect(b.bins.filter((x) => x.header.kind === 'still')).toEqual([])
  })

  it('rajada de freeze on: um screenshot em voo por vez e um still só', async () => {
    const { page } = await openTab()
    const c = connect({ cookies: f.adminCookie })
    await c.opened
    c.send({ type: 'visible', visible: true })
    // O screenshot fica pendurado até o teste soltar.
    let inFlight = 0
    let maxInFlight = 0
    const gates: Array<() => void> = []
    page.screenshot = (opts?: Record<string, unknown>) => {
      page.screenshots.push(opts)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<Buffer>((resolve) => { gates.push(() => { inFlight--; resolve(Buffer.from('png')) }) })
    }
    for (let i = 0; i < 5; i++) c.send({ type: 'freeze', on: true })
    await until(() => page.screenshots.length === 1)
    await new Promise((r) => setTimeout(r, 50))
    expect(page.screenshots).toHaveLength(1)
    gates.shift()!()
    await until(() => c.bins.some((x) => x.header.kind === 'still'))
    // off + on com um em voo: o PNG velho é descartado e sai um novo ao fim.
    c.send({ type: 'freeze', on: false })
    c.send({ type: 'freeze', on: true })
    await until(() => page.screenshots.length === 2)
    c.send({ type: 'freeze', on: false })
    c.send({ type: 'freeze', on: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(page.screenshots).toHaveLength(2)
    gates.shift()!()
    await until(() => page.screenshots.length === 3)
    gates.shift()!()
    await until(() => c.bins.filter((x) => x.header.kind === 'still').length === 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(page.screenshots).toHaveLength(3)
    expect(c.bins.filter((x) => x.header.kind === 'still')).toHaveLength(2)
    expect(maxInFlight).toBe(1)
  })

  it('rajada de navigate/history: uma navegação por vez, e a mais recente vence', async () => {
    const { page } = await openTab()
    const c = connect({ cookies: f.adminCookie })
    await c.opened
    page.navigation = 'hang'
    c.send({ type: 'navigate', url: 'http://localhost:1/a' })
    c.send({ type: 'navigate', url: 'http://localhost:1/b' })
    c.send({ type: 'history', action: 'reload' })
    c.send({ type: 'navigate', url: 'http://localhost:1/d' })
    await until(() => page.navigations.length === 1)
    await new Promise((r) => setTimeout(r, 50))
    expect(page.navigations.map((n) => n.arg)).toEqual(['http://localhost:1/a'])
    page.release()
    await until(() => page.navigations.length === 2)
    page.release()
    await new Promise((r) => setTimeout(r, 50))
    // b e o reload, do meio, foram descartados.
    expect(page.navigations.map((n) => `${n.kind} ${n.arg}`)).toEqual(['goto http://localhost:1/a', 'goto http://localhost:1/d'])
    // Livre de novo: o próximo pedido vai na hora.
    c.send({ type: 'history', action: 'back' })
    await until(() => page.navigations.length === 3)
    expect(page.navigations[2].kind).toBe('back')
  })

  it('a entrada do operador chega à página e o state diz quem está no comando', async () => {
    const { page } = await openTab()
    const ana = connect({ cookies: f.anaCookie })
    const root = connect({ cookies: f.adminCookie })
    await Promise.all([ana.opened, root.opened])
    ana.send({ type: 'pointer', phase: 'down', x: 10, y: 20, button: 'left', clickCount: 1 })
    ana.send({ type: 'pointer', phase: 'up', x: 10, y: 20, button: 'left', clickCount: 1 })
    await until(() => page.calls.some((x) => x.method === 'up'))
    expect(page.calls.map((x) => `${x.target}.${x.method}`)).toEqual(['mouse.move', 'mouse.down', 'mouse.move', 'mouse.up'])
    await until(() => lastState(ana)?.baton.kind === 'operator' && lastState(root)?.baton.kind === 'operator')
    expect(lastState(ana).baton).toEqual({ kind: 'operator', name: 'ana', you: true })
    expect(lastState(root).baton).toEqual({ kind: 'operator', name: 'ana', you: false })
    expect(f.host.existingTab({ projectId: f.p1.id, engine: 'claude' })!.baton.state()).toMatchObject({ userId: anaId() })
    expect(rootId()).not.toBe(anaId())
  })

  it('entrada que o Playwright recusa não derruba o socket', async () => {
    const { page } = await openTab()
    const c = connect({ cookies: f.adminCookie })
    await c.opened
    page.inputError = new Error('Target crashed')
    c.send({ type: 'pointer', phase: 'down', x: 1, y: 1, button: 'left' })
    c.send({ type: 'key', phase: 'down', key: 'Unidentified', code: '', alt: false, ctrl: false, meta: false, shift: false })
    c.send({ type: 'text', text: 'x' })
    c.ws.send('lixo que não é json')
    c.ws.send(Buffer.from([1, 2, 3]))
    await until(() => page.calls.some((x) => x.method === 'insertText'))
    page.inputError = null
    c.send({ type: 'text', text: 'y' })
    await until(() => page.calls.some((x) => x.method === 'insertText' && x.args[0] === 'y'))
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('navigate com esquema recusado volta como aviso no state', async () => {
    const { page } = await openTab()
    const c = connect({ cookies: f.adminCookie })
    await c.opened
    c.send({ type: 'navigate', url: 'file:///etc/passwd' })
    await until(() => (lastState(c)?.notices ?? []).includes('only http:, https: and about:blank URLs are allowed'))
    expect(page.navigations).toEqual([])
  })
})

describe('aba', () => {
  it('aba que fecha (closeTab) manda state.closed e fecha o socket 1000', async () => {
    await openTab()
    const c = connect({ cookies: f.adminCookie })
    await c.opened
    await until(() => !!lastState(c))
    const res = await f.app.inject({ method: 'DELETE', url: tabUrl(f.p1.id), cookies: f.adminCookie })
    expect(res.statusCode).toBe(204)
    expect((await c.closed).code).toBe(1000)
    expect(lastState(c)).toMatchObject({ type: 'state', closed: 'closed_by_user' })
  })

  it("sem aba: manda state com closed 'closed_by_user' e fecha 1000", async () => {
    const c = connect({ cookies: f.adminCookie })
    expect((await c.closed).code).toBe(1000)
    expect(c.texts).toHaveLength(1)
    expect(c.texts[0]).toMatchObject({ type: 'state', closed: 'closed_by_user', baton: { kind: 'free' } })
  })

  it('Chromium indisponível: manda state com unavailable e mantém o socket', async () => {
    process.env.CLAUDINEI_CHROMIUM = '/caminho/que/nao/existe/chrome'
    const res = await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id), cookies: f.adminCookie })
    expect(res.statusCode).toBe(503)
    const c = connect({ cookies: f.adminCookie })
    await c.opened
    await until(() => c.texts.length > 0)
    expect(c.texts[0]).toMatchObject({ type: 'state', unavailable: { code: 'browser_not_installed' } })
    expect(c.texts[0].unavailable.hint).toContain('CLAUDINEI_CHROMIUM')
    expect(c.texts[0].closed).toBeUndefined()
    await new Promise((r) => setTimeout(r, 50))
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  })
})
