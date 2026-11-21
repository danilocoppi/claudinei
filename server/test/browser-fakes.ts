// Dublê do playwright-core para os testes do navegador: um "Chromium" em memória,
// com contexto, página e os eventos que o host usa. Os tipos do playwright-core
// entram por cast (`as unknown as Browser`), sem subir processo nenhum.
import type { Browser } from 'playwright-core'
import type { LaunchFn } from '../src/browser/types.js'

type Listener = (arg?: unknown) => void

class Emitter {
  private listeners = new Map<string, Listener[]>()
  on(event: string, fn: Listener): this {
    const list = this.listeners.get(event) ?? []
    list.push(fn)
    this.listeners.set(event, list)
    return this
  }
  off(event: string, fn: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((f) => f !== fn))
    return this
  }
  emit(event: string, arg?: unknown): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(arg)
  }
}

/** Erro com o nome que o playwright-core dá ao estouro de prazo. */
export function timeoutError(ms: number): Error {
  const err = new Error(`Timeout ${ms}ms exceeded.`)
  err.name = 'TimeoutError'
  return err
}

/** O quadro principal do dublê: a aba compara por identidade com `page.mainFrame()`. */
export class FakeFrame {
  constructor(private readonly owner: FakePage) {}
  url(): string { return this.owner.currentUrl }
  page(): FakePage { return this.owner }
  parentFrame(): null { return null }
  /** A leitura dos campos de senha devolve `passwordValues`; o resto, `evalResult`. */
  evaluate(expr: string): Promise<unknown> {
    this.owner.evaluated.push(expr)
    return Promise.resolve(/password/.test(expr) ? this.owner.passwordValues.slice() : this.owner.evalResult)
  }
}

/** Uma chamada do Playwright registrada pelo dublê (locator, mouse ou teclado). */
export interface FakeCall { target: string; method: string; args: unknown[] }

/**
 * Locator do dublê: cada ação fica registrada em `page.calls`. Com `page.actHang`,
 * as ações ficam penduradas até `page.releaseActs()` (ou o fechamento da página).
 */
export class FakeLocator {
  constructor(private readonly owner: FakePage, readonly selector: string) {}
  private act(method: string, ...args: unknown[]): Promise<void> {
    this.owner.calls.push({ target: this.selector, method, args })
    if (this.owner.closed) return Promise.reject(new Error('Target page, context or browser has been closed'))
    return this.owner.actResult()
  }
  count(): Promise<number> { return Promise.resolve(this.owner.refCount(this.selector)) }
  first(): FakeLocator { return new FakeLocator(this.owner, `${this.selector} >> nth=0`) }
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return Promise.resolve(this.owner.boxes.get(this.selector) ?? null)
  }
  click(opts?: unknown): Promise<void> { return this.act('click', opts) }
  fill(text: string, opts?: unknown): Promise<void> { return this.act('fill', text, opts) }
  pressSequentially(text: string, opts?: unknown): Promise<void> { return this.act('pressSequentially', text, opts) }
  press(key: string, opts?: unknown): Promise<void> { return this.act('press', key, opts) }
  hover(opts?: unknown): Promise<void> { return this.act('hover', opts) }
  selectOption(value: string, opts?: unknown): Promise<string[]> { return this.act('selectOption', value, opts).then(() => [value]) }
  waitFor(opts?: unknown): Promise<void> { return this.act('waitFor', opts) }
}

export class FakePage extends Emitter {
  /** 'load': setContent/goto resolvem na hora; 'hang': ficam pendurados até `release()` ou o `timeout`. */
  navigation: 'load' | 'hang' = 'load'
  closed = false
  currentUrl = 'about:blank'
  titleText = ''
  content = ''
  evalResult: unknown = 0
  viewport: { width: number; height: number } | null = null
  readonly evaluated: string[] = []
  readonly screenshots: Array<Record<string, unknown> | undefined> = []
  readonly navigations: Array<{ kind: 'setContent' | 'goto' | 'back' | 'forward' | 'reload'; arg: string; opts?: Record<string, unknown> }> = []
  readonly viewports: Array<{ width: number; height: number }> = []
  /** O texto que `ariaSnapshot` devolve, e as opções com que foi chamado. */
  snapshotText = ''
  readonly snapshots: Array<Record<string, unknown> | undefined> = []
  /** Os valores dos `input[type=password]` (lidos por `frame.evaluate`). */
  passwordValues: string[] = []
  /** Quantos elementos cada seletor acha (padrão 1); `aria-ref` sem entrada aqui acha 1. */
  readonly counts = new Map<string, number>()
  readonly boxes = new Map<string, { x: number; y: number; width: number; height: number }>()
  readonly calls: FakeCall[] = []
  /** Com true, ações do locator, do mouse e do teclado ficam penduradas até `releaseActs()`. */
  actHang = false
  private hungActs: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  readonly mouse = {
    wheel: (dx: number, dy: number): Promise<void> => { this.calls.push({ target: 'mouse', method: 'wheel', args: [dx, dy] }); return this.actResult() },
  }
  readonly keyboard = {
    press: (key: string): Promise<void> => { this.calls.push({ target: 'keyboard', method: 'press', args: [key] }); return this.actResult() },
  }
  private readonly frame = new FakeFrame(this)
  private pending: Array<() => void> = []

  url(): string { return this.currentUrl }
  mainFrame(): FakeFrame { return this.frame }
  frames(): FakeFrame[] { return [this.frame] }

  ariaSnapshot(opts?: Record<string, unknown>): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Target page, context or browser has been closed'))
    this.snapshots.push(opts)
    return Promise.resolve(this.snapshotText)
  }

  locator(selector: string): FakeLocator { return new FakeLocator(this, selector) }
  getByText(text: string): FakeLocator { return new FakeLocator(this, `text=${text}`) }

  waitForURL(url: string, opts?: Record<string, unknown>): Promise<void> {
    this.calls.push({ target: 'page', method: 'waitForURL', args: [url, opts] })
    return this.actResult()
  }

  /** @internal Resultado de uma ação: na hora, ou pendurada com `actHang`. */
  actResult(): Promise<void> {
    if (!this.actHang) return Promise.resolve()
    return new Promise((resolve, reject) => { this.hungActs.push({ resolve, reject }) })
  }

  /** @internal Quantos elementos o seletor acha. */
  refCount(selector: string): number { return this.counts.get(selector) ?? 1 }

  /** Solta as ações penduradas. */
  releaseActs(): void {
    for (const a of this.hungActs.splice(0)) a.resolve()
  }

  /** O próximo `event`, ou TimeoutError depois de `timeout` ms. */
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off(event, fn); reject(timeoutError(opts?.timeout ?? 30_000)) }, opts?.timeout ?? 30_000)
      const fn = (arg?: unknown) => { clearTimeout(timer); this.off(event, fn); resolve(arg) }
      this.on(event, fn)
    })
  }
  title(): Promise<string> { return Promise.resolve(this.titleText) }

  /** O quadro principal navegou (por link, script ou redirecionamento): emite 'framenavigated'. */
  navigatedTo(url: string): void {
    this.currentUrl = url
    this.emit('framenavigated', this.frame)
  }

  setContent(html: string, opts?: { timeout?: number; waitUntil?: string }): Promise<void> {
    this.content = html
    this.navigations.push({ kind: 'setContent', arg: html, opts })
    return this.navigate(opts?.timeout).then(() => undefined)
  }

  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<null> {
    if (this.closed) return Promise.reject(new Error('Target page, context or browser has been closed'))
    this.navigations.push({ kind: 'goto', arg: url, opts })
    this.navigatedTo(url)
    return this.navigate(opts?.timeout).then(() => { this.emit('load'); return null })
  }

  goBack(opts?: { timeout?: number; waitUntil?: string }): Promise<null> { return this.historyOp('back', opts) }
  goForward(opts?: { timeout?: number; waitUntil?: string }): Promise<null> { return this.historyOp('forward', opts) }
  reload(opts?: { timeout?: number; waitUntil?: string }): Promise<null> { return this.historyOp('reload', opts) }

  private historyOp(kind: 'back' | 'forward' | 'reload', opts?: { timeout?: number; waitUntil?: string }): Promise<null> {
    if (this.closed) return Promise.reject(new Error('Target page, context or browser has been closed'))
    this.navigations.push({ kind, arg: this.currentUrl, opts })
    return this.navigate(opts?.timeout).then(() => null)
  }

  setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.viewport = size
    this.viewports.push(size)
    return Promise.resolve()
  }

  viewportSize(): { width: number; height: number } | null { return this.viewport }

  private navigate(timeout?: number): Promise<void> {
    if (this.navigation === 'load') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => reject(timeoutError(timeout)), timeout) : undefined
      this.pending.push(() => { if (timer) clearTimeout(timer); resolve() })
    })
  }

  /** Solta as navegações penduradas. */
  release(): void {
    for (const r of this.pending.splice(0)) r()
  }

  screenshot(opts?: Record<string, unknown>): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('Target page, context or browser has been closed'))
    this.screenshots.push(opts)
    return Promise.resolve(Buffer.from('png'))
  }

  evaluate(expr: string): Promise<unknown> {
    this.evaluated.push(expr)
    return Promise.resolve(this.evalResult)
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    // Como o Playwright: a ação em curso falha com a página fechada.
    for (const a of this.hungActs.splice(0)) a.reject(new Error('Target page, context or browser has been closed'))
    this.emit('close', this)
    return Promise.resolve()
  }
}

export class FakeContext extends Emitter {
  closed = false
  readonly pages: FakePage[] = []
  /** Com um portão, `newPage` só resolve quando ele abre (abertura de aba em curso). */
  gate: Promise<void> | null
  constructor(readonly options: Record<string, unknown> | undefined, gate: Promise<void> | null = null) {
    super()
    this.gate = gate
  }

  async newPage(): Promise<FakePage> {
    if (this.gate) await this.gate
    if (this.closed) throw new Error('Target page, context or browser has been closed')
    const page = new FakePage()
    this.pages.push(page)
    // Como o Playwright: o evento 'page' sai antes de o newPage resolver.
    this.emit('page', page)
    return page
  }

  /** Uma janela nova aberta pela página (target=_blank, window.open), já na URL dela. */
  openPopup(url: string): FakePage {
    const page = new FakePage()
    page.currentUrl = url
    this.pages.push(page)
    this.emit('page', page)
    return page
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const p of this.pages) await p.close()
    this.emit('close')
  }
}

export class FakeBrowser extends Emitter {
  closed = false
  connected = true
  readonly contexts: FakeContext[] = []
  /** Passado aos contextos novos: segura o `newPage` deles até abrir. */
  pageGate: Promise<void> | null = null

  newContext(options?: Record<string, unknown>): Promise<FakeContext> {
    if (!this.connected) return Promise.reject(new Error('Target page, context or browser has been closed'))
    const ctx = new FakeContext(options, this.pageGate)
    this.contexts.push(ctx)
    return Promise.resolve(ctx)
  }

  isConnected(): boolean { return this.connected }

  /** O processo caiu: emite 'disconnected' como o Chromium de verdade. */
  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.emit('disconnected', this)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const c of this.contexts) await c.close()
    this.disconnect()
  }
}

export interface FakeLaunch {
  launch: LaunchFn
  launches: Array<Parameters<LaunchFn>[0]>
  browsers: FakeBrowser[]
  /** A próxima chamada a `launch` rejeita com este erro (pode empilhar). */
  failNext(err: Error): void
}

export function fakeLaunch(): FakeLaunch {
  const launches: Array<Parameters<LaunchFn>[0]> = []
  const browsers: FakeBrowser[] = []
  const failures: Error[] = []
  const launch: LaunchFn = async (o) => {
    launches.push(o)
    const fail = failures.shift()
    if (fail) throw fail
    const b = new FakeBrowser()
    browsers.push(b)
    return b as unknown as Browser
  }
  return { launch, launches, browsers, failNext: (err) => { failures.push(err) } }
}

/** A página mais recente aberta no dublê (a da página isolada em curso, nos testes). */
export function lastPage(fl: FakeLaunch): FakePage {
  const b = fl.browsers.at(-1)
  const c = b?.contexts.at(-1)
  const p = c?.pages.at(-1)
  if (!p) throw new Error('nenhuma página aberta no dublê')
  return p
}
