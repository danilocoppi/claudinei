// O processo do Chromium do Claudinei (contrato com o projeto 15). Criado uma vez
// em index.ts: abre o Chromium sob demanda (headless, controle pelo pipe, sandbox
// ligada), conta o uso (abas + páginas isoladas abertas) e fecha o processo
// `idleMs` depois de ficar sem uso. O pipe também garante que o Chromium morre
// junto com o serviço.
//
// O playwright-core NUNCA é importado no topo: o Node do pkg vem sem `inspector`,
// e o desvio (pkg-runtime.ts) tem de estar instalado antes do primeiro require dele.
// No código do Claudinei, `evaluate` só com string (o pkg perde o texto das funções).
import { createRequire } from 'node:module'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { INSTALL_COMMAND, resolveChromium } from './chromium.js'
import { createTerminalTab, DEFAULT_VIEWPORT, type TerminalTab } from './terminal-tab.js'
import { allowedUrl } from './url-policy.js'
import { keyOf, TEXTS, TooManyTabsError, type LaunchFn, type TerminalKey } from './types.js'
import { withMarker } from '../local-servers/marker.js'

export type { TerminalTab } from './terminal-tab.js'
export type { LaunchFn, TerminalKey } from './types.js'

export interface ConsoleEntry { type: string; text: string }        // 'log' | 'warning' | 'error' | 'pageerror' …
export interface PreviewPage {
  setContent(html: string, opts?: { loadTimeoutMs?: number }): Promise<{ loaded: boolean }>
  goto(url: string, opts?: { loadTimeoutMs?: number }): Promise<{ loaded: boolean }>
  screenshot(opts: { fullPage: boolean }): Promise<Buffer>
  contentHeight(): Promise<number>
  consoleMessages(): ConsoleEntry[]
}
export interface IsolatedPageOpts { viewport: { width: number; height: number }; offline?: boolean; timeoutMs?: number; queueTimeoutMs?: number }
export interface BrowserHost {
  withIsolatedPage<T>(opts: IsolatedPageOpts, fn: (page: PreviewPage) => Promise<T>): Promise<T>
  tab(key: TerminalKey): Promise<TerminalTab>
  existingTab(key: TerminalKey): TerminalTab | undefined
  closeTab(key: TerminalKey): Promise<void>
  status(): { state: 'closed' | 'starting' | 'open' | 'unavailable'; tabs: number; reason?: string }
  shutdown(): Promise<void>
}
export interface BrowserHostDeps { log: (line: string) => void; idleMs?: number; now?: () => number; launch?: LaunchFn }

/** Sem Chromium (`browser_not_installed`) ou a subida falhou (`launch_failed`, mensagem do Chromium). */
export class BrowserUnavailableError extends Error {
  readonly code: 'browser_not_installed' | 'launch_failed'
  readonly hint: string
  constructor(code: 'browser_not_installed' | 'launch_failed', message: string, hint: string) {
    super(message)
    this.name = 'BrowserUnavailableError'
    this.code = code
    this.hint = hint
  }
}

/** A fila das páginas isoladas passou de `queueTimeoutMs`. */
export class BrowserBusyError extends Error {
  readonly code = 'browser_busy' as const
  constructor() {
    super('browser busy: too many preview pages waiting')
    this.name = 'BrowserBusyError'
  }
}

// Números da spec.
const IDLE_MS = 120_000
const TAB_IDLE_MS = 30 * 60_000
const SWEEP_MS = 60_000
const MAX_TABS = 8
const MAX_ISOLATED = 2
const ISOLATED_TIMEOUT_MS = 20_000
const LOAD_TIMEOUT_MS = 10_000
const QUEUE_TIMEOUT_MS = 30_000
/** A subida travada não segura a vaga (nem quem espera por ela) além disto. */
const LAUNCH_TIMEOUT_MS = 30_000
const MAX_CONSOLE = 500

/** Falha de subida que conta como "a sandbox não deu": sobe de novo sem ela. */
const SANDBOX_ERROR = /sandbox|namespace|setuid/i

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isTimeout = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError'

/**
 * Carrega o playwright-core por `require`, nunca por `import()`: o esbuild deixa o
 * `import()` de um pacote externo como import dinâmico de verdade, e o bytecode do
 * pkg não o executa ("A dynamic import callback was not specified", visto rodando
 * o binário); o `require` resolve pelo NODE_PATH do cache extraído. No bundle CJS
 * o `require` do módulo existe; em dev (tsx, ESM) vem do `createRequire`.
 */
function loadPlaywright(): typeof import('playwright-core') {
  const req = typeof require === 'function' ? require : createRequire(import.meta.url)
  return req('playwright-core') as typeof import('playwright-core')
}

/** O launch de verdade: carrega o playwright-core só aqui, depois do desvio do inspector. */
const defaultLaunch: LaunchFn = async ({ executablePath, chromiumSandbox, env }) => {
  const { chromium } = loadPlaywright()
  return chromium.launch({ executablePath, headless: true, chromiumSandbox, env, timeout: LAUNCH_TIMEOUT_MS })
}

function previewOf(page: Page): PreviewPage {
  const messages: ConsoleEntry[] = []
  const push = (e: ConsoleEntry) => {
    messages.push(e)
    if (messages.length > MAX_CONSOLE) messages.shift()
  }
  page.on('console', (m) => push({ type: m.type(), text: m.text() }))
  page.on('pageerror', (e) => push({ type: 'pageerror', text: e.message }))
  // O `load` tem prazo próprio: estourado, a página segue viva e quem chamou ainda captura.
  const untilLoad = async (op: (timeout: number) => Promise<unknown>, loadTimeoutMs?: number) => {
    try {
      await op(loadTimeoutMs ?? LOAD_TIMEOUT_MS)
      return { loaded: true }
    } catch (err) {
      if (isTimeout(err)) return { loaded: false }
      throw err
    }
  }
  return {
    setContent: (html, o) => untilLoad((timeout) => page.setContent(html, { waitUntil: 'load', timeout }), o?.loadTimeoutMs),
    goto: async (url, o) => {
      if (!allowedUrl(url)) throw new Error(TEXTS.SCHEME_REFUSED)
      return untilLoad((timeout) => page.goto(url, { waitUntil: 'load', timeout }), o?.loadTimeoutMs)
    },
    screenshot: ({ fullPage }) => page.screenshot({ type: 'png', fullPage }),
    contentHeight: async () => Number(await page.evaluate('document.documentElement.scrollHeight')) || 0,
    consoleMessages: () => messages.slice(),
  }
}

export function createBrowserHost(deps: BrowserHostDeps): BrowserHost {
  const log = deps.log
  const idleMs = deps.idleMs ?? IDLE_MS
  const now = deps.now ?? Date.now
  const launch = deps.launch ?? defaultLaunch

  let browser: Browser | undefined
  let starting: Promise<Browser> | undefined
  let state: 'closed' | 'starting' | 'open' | 'unavailable' = 'closed'
  let reason: string | undefined
  /** A sandbox já falhou uma vez neste serviço: as próximas subidas vão direto sem ela. */
  let noSandbox = false
  let shut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let sweepTimer: ReturnType<typeof setInterval> | undefined

  const tabs = new Map<string, TerminalTab>()
  const creating = new Map<string, Promise<TerminalTab>>()
  /** Abas em criação que já passaram da conferência do limite. */
  let reserved = 0
  /** Páginas isoladas com vaga (a contar da vaga até o fechamento do contexto). */
  let isolated = 0
  const waiters: Array<{ grant: () => void; fail: (err: Error) => void }> = []

  const inUse = () => tabs.size + reserved + isolated

  /** Sem uso, arma o relógio de fechamento do processo; com uso, desarma. */
  function checkIdle(): void {
    if (inUse() > 0 || !browser) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined }
      return
    }
    if (idleTimer) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (inUse() === 0) void closeBrowser()
    }, idleMs)
    idleTimer.unref?.()
  }

  /** Abas sem ferramenta do agente e sem coluna visível por 30 min fecham. */
  function sweep(): void {
    const t = now()
    for (const tab of [...tabs.values()]) {
      if (!tab.isVisible() && t - tab.lastAgentAt >= TAB_IDLE_MS) void tab.close('idle')
    }
  }

  function stopTimers(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = undefined }
  }

  /** Esquece o processo atual (caiu ou foi fechado) e fecha as abas dele. */
  async function dropBrowser(b: Browser, tabReason: 'browser_closed' | 'shutdown'): Promise<void> {
    if (browser !== b) return
    browser = undefined
    state = 'closed'
    reason = undefined
    stopTimers()
    await Promise.all([...tabs.values()].map((tab) => tab.close(tabReason)))
  }

  async function closeBrowser(tabReason: 'browser_closed' | 'shutdown' = 'browser_closed'): Promise<void> {
    const b = browser
    if (!b) return
    await dropBrowser(b, tabReason)
    await b.close().catch((err: unknown) => log(`fechar o Chromium falhou: ${messageOf(err)}`))
  }

  async function start(): Promise<Browser> {
    const found = resolveChromium(process.env)
    if (!found.ok) {
      state = 'unavailable'
      reason = found.reason
      if (found.reason === 'env_missing') {
        // Instalar não resolve: a variável aponta um arquivo que não existe.
        throw new BrowserUnavailableError('browser_not_installed', `Browser not found: CLAUDINEI_CHROMIUM=${found.expected} does not exist; fix or unset it`, `fix or unset CLAUDINEI_CHROMIUM (${found.expected})`)
      }
      throw new BrowserUnavailableError('browser_not_installed', TEXTS.NOT_INSTALLED, INSTALL_COMMAND)
    }
    state = 'starting'
    reason = undefined
    // O Chromium nunca carrega o marcador de terminal: não é servidor de ninguém.
    const env = withMarker(process.env, undefined)
    const exe = found.path
    // A mensagem é a do Chromium; a dica diz qual executável foi tentado.
    const fail = (err: unknown): never => {
      state = 'unavailable'
      reason = 'launch_failed'
      log(`o Chromium não subiu: ${messageOf(err)}`)
      throw new BrowserUnavailableError('launch_failed', messageOf(err), `executable: ${exe}`)
    }
    let b: Browser
    if (noSandbox) {
      b = await launch({ executablePath: exe, chromiumSandbox: false, env }).catch(fail)
    } else {
      try {
        b = await launch({ executablePath: exe, chromiumSandbox: true, env })
      } catch (err) {
        if (!SANDBOX_ERROR.test(messageOf(err))) return fail(err)
        log(`o Chromium não subiu com a sandbox (${messageOf(err).split('\n')[0]}); subindo sem ela`)
        b = await launch({ executablePath: exe, chromiumSandbox: false, env }).catch(fail)
        noSandbox = true
      }
    }
    if (shut) {
      await b.close().catch(() => {})
      throw new BrowserUnavailableError('launch_failed', 'browser host is shutting down', '')
    }
    browser = b
    state = 'open'
    reason = noSandbox ? 'no_sandbox' : undefined
    b.on('disconnected', () => {
      if (browser !== b) return
      log('o Chromium caiu')
      void dropBrowser(b, 'browser_closed')
    })
    sweepTimer = setInterval(sweep, SWEEP_MS)
    sweepTimer.unref?.()
    return b
  }

  function ensureBrowser(): Promise<Browser> {
    if (shut) return Promise.reject(new BrowserUnavailableError('launch_failed', 'browser host is shutting down', ''))
    if (browser) return Promise.resolve(browser)
    if (!starting) starting = start().finally(() => { starting = undefined })
    return starting
  }

  // Semáforo FIFO das páginas isoladas.
  let active = 0
  function acquire(queueTimeoutMs: number): Promise<void> {
    if (active < MAX_ISOLATED && waiters.length === 0) {
      active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const w = {
        grant: () => { clearTimeout(timer); active++; resolve() },
        fail: (err: Error) => { clearTimeout(timer); reject(err) },
      }
      const timer = setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        reject(new BrowserBusyError())
      }, queueTimeoutMs)
      waiters.push(w)
    })
  }
  function releaseSlot(): void {
    active--
    waiters.shift()?.grant()
  }

  async function createTab(key: TerminalKey): Promise<TerminalTab> {
    const b = await ensureBrowser()
    while (tabs.size + reserved >= MAX_TABS) {
      // A mais ociosa entre as que ninguém está olhando sai para dar lugar.
      const victim = [...tabs.values()].filter((t) => !t.isVisible()).sort((x, y) => x.lastAgentAt - y.lastAgentAt)[0]
      if (!victim) throw new TooManyTabsError()
      await victim.close('evicted')
    }
    reserved++
    let context: BrowserContext | undefined
    try {
      // O viewport inicial: 1280×800 (a Task 9 passa a informar o último pedido de coluna).
      const viewport = { ...DEFAULT_VIEWPORT }
      context = await b.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' })
      const page = await context.newPage()
      // O processo caiu ou foi fechado enquanto a aba abria: a aba nasceria órfã
      // (o fechamento das abas desse processo já passou). Fecha e falha.
      if (browser !== b) throw new Error('the browser closed while the tab was opening; try again')
      const tab = createTerminalTab({ key, context, page, now, viewport, sandbox: !noSandbox })
      const k = keyOf(key)
      tabs.set(k, tab)
      tab.onClosed(() => {
        if (tabs.get(k) === tab) tabs.delete(k)
        checkIdle()
      })
      return tab
    } catch (err) {
      await context?.close().catch(() => {})
      throw err
    } finally {
      reserved--
      checkIdle()
    }
  }

  return {
    async withIsolatedPage(opts, fn) {
      await acquire(opts.queueTimeoutMs ?? QUEUE_TIMEOUT_MS)
      isolated++
      let context: BrowserContext | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const b = await ensureBrowser()
        checkIdle()
        context = await b.newContext({
          viewport: opts.viewport,
          deviceScaleFactor: 1,
          acceptDownloads: false,
          offline: !!opts.offline,
          serviceWorkers: 'block',
        })
        const page = await context.newPage()
        // O prazo conta da abertura da página, sem a espera na fila nem a subida.
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), opts.timeoutMs ?? ISOLATED_TIMEOUT_MS)
        })
        const work = fn(previewOf(page))
        work.catch(() => { /* estourado o prazo, a falha de fn com o contexto fechado não importa */ })
        return await Promise.race([work, expired])
      } finally {
        if (timer) clearTimeout(timer)
        await context?.close().catch(() => {})
        isolated--
        releaseSlot()
        checkIdle()
      }
    },

    async tab(key) {
      const k = keyOf(key)
      const existing = tabs.get(k)
      if (existing) return existing
      const pending = creating.get(k)
      if (pending) return pending
      const p = createTab(key).finally(() => { creating.delete(k) })
      creating.set(k, p)
      return p
    },

    existingTab: (key) => tabs.get(keyOf(key)),

    async closeTab(key) {
      await tabs.get(keyOf(key))?.close('closed_by_user')
    },

    status() {
      const s: { state: typeof state; tabs: number; reason?: string } = { state, tabs: tabs.size }
      if (reason) s.reason = reason
      return s
    },

    async shutdown() {
      shut = true
      for (const w of waiters.splice(0)) w.fail(new BrowserUnavailableError('launch_failed', 'browser host is shutting down', ''))
      await starting?.catch(() => {})
      await closeBrowser('shutdown')
      stopTimers()
    },
  }
}
