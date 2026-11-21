import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBrowserHost, BrowserBusyError, BrowserUnavailableError, type BrowserHost, type PreviewPage } from '../src/browser/host.js'
import { INSTALL_COMMAND } from '../src/browser/chromium.js'
import { TEXTS, TooManyTabsError, type TabCloseReason } from '../src/browser/types.js'
import { browserSelfTest } from '../src/browser/selftest.js'
import { fakeLaunch, lastPage, type FakeLaunch } from './browser-fakes.js'

const KEY = { projectId: 1, engine: 'claude' }
const VIEW = { viewport: { width: 800, height: 600 } }

/** Promessa com o resolver à mão (segura uma página isolada aberta). */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

let fl: FakeLaunch
let log: ReturnType<typeof vi.fn<(line: string) => void>>
let host: BrowserHost
const savedEnv = { ...process.env }

beforeEach(() => {
  vi.useFakeTimers()
  // O host resolve o Chromium antes do launch: aponta para um arquivo que existe.
  process.env.CLAUDINEI_CHROMIUM = process.execPath
  fl = fakeLaunch()
  log = vi.fn<(line: string) => void>()
  host = createBrowserHost({ log, launch: fl.launch })
})

afterEach(async () => {
  await host.shutdown()
  vi.useRealTimers()
  process.env = { ...savedEnv }
})

describe('BrowserHost: o processo', () => {
  it('status() começa closed e não lança nada antes do primeiro uso', () => {
    expect(host.status()).toEqual({ state: 'closed', tabs: 0 })
    expect(fl.launches).toHaveLength(0)
  })

  it('duas chamadas simultâneas a tab() lançam o Chromium uma vez só', async () => {
    const [a, b] = await Promise.all([host.tab(KEY), host.tab({ projectId: 2, engine: 'codex' })])
    expect(a).not.toBe(b)
    expect(fl.launches).toHaveLength(1)
    expect(host.status()).toEqual({ state: 'open', tabs: 2 })
  })

  it('launch recebe chromiumSandbox true e env sem CLAUDINEI_TERMINAL', async () => {
    process.env.CLAUDINEI_TERMINAL = '1:x'
    await host.tab(KEY)
    expect(fl.launches[0].chromiumSandbox).toBe(true)
    expect(fl.launches[0].executablePath).toBe(process.execPath)
    expect(fl.launches[0].env.CLAUDINEI_TERMINAL).toBeUndefined()
    expect(fl.launches[0].env.PATH).toBe(process.env.PATH)
  })

  it('subida que falha por sandbox tenta de novo sem ela, com reason no_sandbox e log', async () => {
    fl.failNext(new Error('Failed to launch: No usable sandbox! Update your kernel'))
    await host.tab(KEY)
    expect(fl.launches.map((l) => l.chromiumSandbox)).toEqual([true, false])
    expect(host.status()).toEqual({ state: 'open', tabs: 1, reason: 'no_sandbox' })
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/sandbox/i))
  })

  it('falha que não é de sandbox → BrowserUnavailableError launch_failed, sem segunda tentativa', async () => {
    fl.failNext(new Error('boom: libnss3.so missing'))
    const err = await host.tab(KEY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserUnavailableError)
    expect((err as BrowserUnavailableError).code).toBe('launch_failed')
    expect((err as Error).message).toContain('libnss3')
    expect(fl.launches).toHaveLength(1)
    expect(host.status().state).toBe('unavailable')
  })

  it('sem Chromium (not_installed) → tab() e withIsolatedPage rejeitam browser_not_installed com o comando', async () => {
    delete process.env.CLAUDINEI_CHROMIUM
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/nao/existe/claudinei-teste'
    for (const p of [host.tab(KEY), host.withIsolatedPage(VIEW, async () => 1)]) {
      const err = await p.catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BrowserUnavailableError)
      expect((err as BrowserUnavailableError).code).toBe('browser_not_installed')
      expect((err as BrowserUnavailableError).hint).toBe(INSTALL_COMMAND)
      expect((err as Error).message).toBe(TEXTS.NOT_INSTALLED)
    }
    expect(fl.launches).toHaveLength(0)
    expect(host.status().state).toBe('unavailable')
  })

  it('CLAUDINEI_CHROMIUM apontando arquivo ausente → browser_not_installed com a dica de corrigir a variável, não a de instalar', async () => {
    process.env.CLAUDINEI_CHROMIUM = '/nao/existe/chrome-claudinei'
    const err = await host.tab(KEY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserUnavailableError)
    expect((err as BrowserUnavailableError).code).toBe('browser_not_installed')
    expect((err as BrowserUnavailableError).hint).toBe('fix or unset CLAUDINEI_CHROMIUM (/nao/existe/chrome-claudinei)')
    expect((err as Error).message).toBe('Browser not found: CLAUDINEI_CHROMIUM=/nao/existe/chrome-claudinei does not exist; fix or unset it')
    // A mensagem não manda instalar: instalar não resolve a variável errada.
    expect((err as Error).message).not.toContain('install')
    expect(fl.launches).toHaveLength(0)
  })

  it('fecha o processo 120 s depois de ficar sem abas e sem páginas isoladas', async () => {
    await host.tab(KEY)
    await host.closeTab(KEY)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(host.status().state).toBe('open')
    expect(fl.browsers[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.status().state).toBe('closed')
    expect(fl.browsers[0].closed).toBe(true)
  })

  it('uma página isolada em curso segura o processo aberto além de idleMs', async () => {
    const hold = deferred()
    const run = host.withIsolatedPage({ ...VIEW, timeoutMs: 600_000 }, () => hold.promise)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(host.status().state).toBe('open')
    hold.resolve()
    await run
    await vi.advanceTimersByTimeAsync(120_000)
    expect(host.status().state).toBe('closed')
  })

  it("'disconnected' do Chromium fecha as abas com browser_closed e volta a closed; a próxima tab() lança outro", async () => {
    const t1 = await host.tab(KEY)
    const t2 = await host.tab({ projectId: 2, engine: 'codex' })
    const reasons: TabCloseReason[] = []
    t1.onClosed((r) => reasons.push(r))
    t2.onClosed((r) => reasons.push(r))
    fl.browsers[0].disconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(reasons).toEqual(['browser_closed', 'browser_closed'])
    expect(host.status()).toEqual({ state: 'closed', tabs: 0 })
    expect(host.existingTab(KEY)).toBeUndefined()
    const t3 = await host.tab(KEY)
    expect(t3).not.toBe(t1)
    expect(fl.launches).toHaveLength(2)
  })

  it('shutdown fecha abas (shutdown) e o processo', async () => {
    const t = await host.tab(KEY)
    const reasons: TabCloseReason[] = []
    t.onClosed((r) => reasons.push(r))
    await host.shutdown()
    expect(reasons).toEqual(['shutdown'])
    expect(fl.browsers[0].contexts[0].closed).toBe(true)
    expect(fl.browsers[0].closed).toBe(true)
    expect(host.status()).toEqual({ state: 'closed', tabs: 0 })
  })
})

describe('BrowserHost: páginas isoladas', () => {
  it('contexto isolado: acceptDownloads false, offline conforme pedido, viewport pedido, deviceScaleFactor 1', async () => {
    await host.withIsolatedPage({ viewport: { width: 640, height: 480 }, offline: true }, async () => undefined)
    await host.withIsolatedPage(VIEW, async () => undefined)
    const [a, b] = fl.browsers[0].contexts
    expect(a.options).toMatchObject({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, acceptDownloads: false, offline: true })
    expect(b.options).toMatchObject({ viewport: { width: 800, height: 600 }, offline: false, acceptDownloads: false })
    expect(a.closed && b.closed).toBe(true)
  })

  it('withIsolatedPage devolve o valor de fn e fecha o contexto', async () => {
    const out = await host.withIsolatedPage(VIEW, async (page) => (await page.screenshot({ fullPage: true })).toString())
    expect(out).toBe('png')
    expect(lastPage(fl).screenshots).toEqual([{ type: 'png', fullPage: true }])
    expect(fl.browsers[0].contexts[0].closed).toBe(true)
  })

  it('withIsolatedPage fecha o contexto quando fn lança', async () => {
    const err = await host.withIsolatedPage(VIEW, async () => { throw new Error('falhou') }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('falhou')
    expect(fl.browsers[0].contexts[0].closed).toBe(true)
  })

  it('withIsolatedPage estoura timeoutMs contado da abertura (não da fila)', async () => {
    const holdA = deferred()
    const holdB = deferred()
    const a = host.withIsolatedPage(VIEW, () => holdA.promise)
    const b = host.withIsolatedPage(VIEW, () => holdB.promise)
    let rejected: unknown
    const c = host.withIsolatedPage({ ...VIEW, timeoutMs: 5_000 }, () => new Promise(() => {}))
      .catch((e: unknown) => { rejected = e })
    await vi.advanceTimersByTimeAsync(4_000) // 4 s na fila
    holdA.resolve()
    holdB.resolve()
    await Promise.all([a, b])
    await vi.advanceTimersByTimeAsync(4_000) // 8 s desde a chamada, 4 s desde a abertura
    expect(rejected).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_100)
    await c
    expect((rejected as Error).message).toBe('timeout')
    expect(fl.browsers[0].contexts[2].closed).toBe(true)
  })

  it('setContent que não chega ao load em loadTimeoutMs → loaded false sem lançar; a página segue utilizável', async () => {
    const run = host.withIsolatedPage(VIEW, async (page) => {
      lastPage(fl).navigation = 'hang'
      const r = await page.setContent('<img src="http://lento">', { loadTimeoutMs: 3_000 })
      const png = await page.screenshot({ fullPage: false })
      return { r, png: png.toString() }
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await run).toEqual({ r: { loaded: false }, png: 'png' })
    expect(lastPage(fl).navigations[0].opts).toMatchObject({ waitUntil: 'load', timeout: 3_000 })
  })

  it('setContent sem prazo explícito espera o load por 10 s; com load → loaded true', async () => {
    const r = await host.withIsolatedPage(VIEW, (page) => page.setContent('<h1>ok</h1>'))
    expect(r).toEqual({ loaded: true })
    expect(lastPage(fl).navigations[0].opts).toMatchObject({ waitUntil: 'load', timeout: 10_000 })
  })

  it("goto('file:///etc/passwd') rejeita com SCHEME_REFUSED; about:blank e https aceitos", async () => {
    await host.withIsolatedPage(VIEW, async (page: PreviewPage) => {
      for (const bad of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x', 'about:config']) {
        await expect(page.goto(bad)).rejects.toThrow(TEXTS.SCHEME_REFUSED)
      }
      expect(await page.goto('about:blank')).toEqual({ loaded: true })
      expect(await page.goto('https://example.com/')).toEqual({ loaded: true })
      expect(await page.goto('http://127.0.0.1:5173')).toEqual({ loaded: true })
    })
    expect(lastPage(fl).navigations.map((n) => n.arg)).toEqual(['about:blank', 'https://example.com/', 'http://127.0.0.1:5173'])
  })

  it('no máximo duas páginas isoladas; a terceira espera na ordem e roda quando uma termina', async () => {
    const order: string[] = []
    const holdA = deferred()
    const holdB = deferred()
    const a = host.withIsolatedPage(VIEW, async () => { order.push('a'); await holdA.promise })
    const b = host.withIsolatedPage(VIEW, async () => { order.push('b'); await holdB.promise })
    const c = host.withIsolatedPage(VIEW, async () => { order.push('c') })
    const d = host.withIsolatedPage(VIEW, async () => { order.push('d') })
    await vi.advanceTimersByTimeAsync(10)
    expect(order).toEqual(['a', 'b'])
    holdB.resolve()
    await b
    await vi.advanceTimersByTimeAsync(10)
    expect(order).toEqual(['a', 'b', 'c', 'd'])
    holdA.resolve()
    await Promise.all([a, c, d])
  })

  it('a terceira que espera mais que queueTimeoutMs rejeita BrowserBusyError e sai da fila', async () => {
    const hold = deferred()
    const a = host.withIsolatedPage(VIEW, () => hold.promise)
    const b = host.withIsolatedPage(VIEW, () => hold.promise)
    let ranC = false
    const c = host.withIsolatedPage({ ...VIEW, queueTimeoutMs: 1_000 }, async () => { ranC = true }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    const err = await c
    expect(err).toBeInstanceOf(BrowserBusyError)
    expect((err as BrowserBusyError).code).toBe('browser_busy')
    hold.resolve()
    await Promise.all([a, b])
    await vi.advanceTimersByTimeAsync(10)
    expect(ranC).toBe(false)
    // A vaga dela não ficou presa: duas novas rodam juntas.
    let running = 0
    let peak = 0
    const job = async () => { running++; peak = Math.max(peak, running); await Promise.resolve(); running-- }
    await Promise.all([host.withIsolatedPage(VIEW, job), host.withIsolatedPage(VIEW, job)])
    expect(peak).toBe(2)
  })

  it("consoleMessages traz 'console' e 'pageerror' (type pageerror)", async () => {
    const msgs = await host.withIsolatedPage(VIEW, async (page) => {
      const fp = lastPage(fl)
      fp.emit('console', { type: () => 'log', text: () => 'oi' })
      fp.emit('console', { type: () => 'warning', text: () => 'cuidado' })
      fp.emit('pageerror', new Error('quebrou'))
      return page.consoleMessages()
    })
    expect(msgs).toEqual([
      { type: 'log', text: 'oi' },
      { type: 'warning', text: 'cuidado' },
      { type: 'pageerror', text: 'quebrou' },
    ])
  })

  it('contentHeight lê scrollHeight por evaluate com string', async () => {
    const h = await host.withIsolatedPage(VIEW, async (page) => {
      lastPage(fl).evalResult = 1234
      return page.contentHeight()
    })
    expect(h).toBe(1234)
    expect(lastPage(fl).evaluated).toEqual(['document.documentElement.scrollHeight'])
  })
})

describe('BrowserHost: abas dos terminais', () => {
  it('tab(key) cria uma vez e existingTab devolve a mesma; closeTab fecha o contexto', async () => {
    expect(host.existingTab(KEY)).toBeUndefined()
    const [a, b] = await Promise.all([host.tab(KEY), host.tab(KEY)])
    expect(a).toBe(b)
    expect(await host.tab(KEY)).toBe(a)
    expect(host.existingTab(KEY)).toBe(a)
    expect(fl.browsers[0].contexts).toHaveLength(1)
    expect(a.key).toEqual(KEY)
    expect(a.page()).toBe(fl.browsers[0].contexts[0].pages[0])
    const reasons: TabCloseReason[] = []
    a.onClosed((r) => reasons.push(r))
    await host.closeTab(KEY)
    expect(reasons).toEqual(['closed_by_user'])
    expect(fl.browsers[0].contexts[0].closed).toBe(true)
    expect(host.existingTab(KEY)).toBeUndefined()
    expect(host.status().tabs).toBe(0)
  })

  it("closeTab(key, 'closed_by_agent') fecha com o motivo do agente; sem motivo, closed_by_user", async () => {
    const a = await host.tab(KEY)
    const reasons: TabCloseReason[] = []
    a.onClosed((r) => reasons.push(r))
    await host.closeTab(KEY, 'closed_by_agent')
    expect(reasons).toEqual(['closed_by_agent'])
    expect(host.existingTab(KEY)).toBeUndefined()
  })

  it('contexto da aba: viewport 1280×800, deviceScaleFactor 1, sem downloads e sem service workers; state() com sandbox', async () => {
    const t = await host.tab(KEY)
    expect(fl.browsers[0].contexts[0].options).toEqual({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block',
    })
    expect(t.state()).toMatchObject({ url: 'about:blank', viewport: { width: 1280, height: 800 }, sandbox: true })
  })

  it('sem a sandbox, a aba diz sandbox false', async () => {
    fl.failNext(new Error('No usable sandbox!'))
    const t = await host.tab(KEY)
    expect(t.state().sandbox).toBe(false)
  })

  it('o processo cai enquanto a aba abre: fecha o contexto, rejeita e não guarda a aba', async () => {
    await host.withIsolatedPage(VIEW, async () => undefined) // sobe o processo
    const b = fl.browsers[0]
    let open!: () => void
    b.pageGate = new Promise<void>((r) => { open = r })
    const p = host.tab(KEY).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    b.disconnect()
    await vi.advanceTimersByTimeAsync(0)
    open()
    const err = await p
    expect((err as Error).message).toBe('the browser closed while the tab was opening; try again')
    expect(b.contexts.at(-1)?.closed).toBe(true)
    expect(host.existingTab(KEY)).toBeUndefined()
    expect(host.status()).toEqual({ state: 'closed', tabs: 0 })
    // A próxima tab() sobe outro processo e funciona.
    const t = await host.tab(KEY)
    expect(fl.launches).toHaveLength(2)
    expect(host.existingTab(KEY)).toBe(t)
  })

  it('a nona aba fecha a mais ociosa não visível (evicted); com as oito visíveis rejeita TooManyTabsError', async () => {
    const tabs = []
    for (let i = 1; i <= 8; i++) {
      tabs.push(await host.tab({ projectId: i, engine: 'claude' }))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // A 1 é a mais ociosa, mas está visível; a 2 é a mais ociosa das invisíveis.
    tabs[0].isVisible = () => true
    tabs[2].lastAgentAt = 0
    tabs[1].lastAgentAt = 1
    tabs[2].isVisible = () => true
    const reasons: TabCloseReason[] = []
    tabs[1].onClosed((r) => reasons.push(r))
    const ninth = await host.tab({ projectId: 9, engine: 'claude' })
    expect(reasons).toEqual(['evicted'])
    expect(host.existingTab({ projectId: 2, engine: 'claude' })).toBeUndefined()
    expect(host.existingTab({ projectId: 9, engine: 'claude' })).toBe(ninth)
    expect(host.status().tabs).toBe(8)

    for (const t of [...tabs, ninth]) t.isVisible = () => true
    const err = await host.tab({ projectId: 10, engine: 'claude' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TooManyTabsError)
    expect((err as TooManyTabsError).code).toBe('too_many_tabs')
    expect((err as Error).message).toBe(TEXTS.TOO_MANY_TABS)
    expect(host.status().tabs).toBe(8)
  })

  it('aba sem ferramenta do agente e invisível por 30 min fecha com idle', async () => {
    const t = await host.tab(KEY)
    const other = await host.tab({ projectId: 2, engine: 'codex' })
    other.isVisible = () => true
    const reasons: TabCloseReason[] = []
    t.onClosed((r) => reasons.push(r))
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(reasons).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reasons).toEqual(['idle'])
    expect(host.existingTab(KEY)).toBeUndefined()
    expect(host.existingTab({ projectId: 2, engine: 'codex' })).toBe(other)
  })

  it('uso do agente (lastAgentAt) adia o fechamento por ociosidade', async () => {
    const t = await host.tab(KEY)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    t.lastAgentAt = Date.now()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(host.existingTab(KEY)).toBe(t)
  })
})

describe('browserSelfTest', () => {
  it('sobe a página isolada, imprime o JSON e devolve 0 com PNG', async () => {
    const lines: string[] = []
    const code = await browserSelfTest((l) => lines.push(l), { launch: fl.launch })
    expect(code).toBe(0)
    const out = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>
    expect(out).toMatchObject({ status: 'open', loaded: true, pngBytes: 3 })
    expect(fl.browsers[0].closed).toBe(true)
  })

  it('sem Chromium devolve 1', async () => {
    delete process.env.CLAUDINEI_CHROMIUM
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/nao/existe/claudinei-teste'
    const lines: string[] = []
    expect(await browserSelfTest((l) => lines.push(l), { launch: fl.launch })).toBe(1)
    expect(lines.join('\n')).toContain('browser_not_installed')
  })
})
