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

export class FakePage extends Emitter {
  /** 'load': setContent/goto resolvem na hora; 'hang': ficam pendurados até `release()` ou o `timeout`. */
  navigation: 'load' | 'hang' = 'load'
  closed = false
  url = 'about:blank'
  content = ''
  evalResult: unknown = 0
  readonly evaluated: string[] = []
  readonly screenshots: Array<Record<string, unknown> | undefined> = []
  readonly navigations: Array<{ kind: 'setContent' | 'goto'; arg: string; opts?: Record<string, unknown> }> = []
  private pending: Array<() => void> = []

  setContent(html: string, opts?: { timeout?: number; waitUntil?: string }): Promise<void> {
    this.content = html
    this.navigations.push({ kind: 'setContent', arg: html, opts })
    return this.navigate(opts?.timeout).then(() => undefined)
  }

  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<null> {
    this.url = url
    this.navigations.push({ kind: 'goto', arg: url, opts })
    return this.navigate(opts?.timeout).then(() => null)
  }

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
    this.closed = true
    this.emit('close')
    return Promise.resolve()
  }
}

export class FakeContext extends Emitter {
  closed = false
  readonly pages: FakePage[] = []
  constructor(readonly options: Record<string, unknown> | undefined) { super() }

  newPage(): Promise<FakePage> {
    const page = new FakePage()
    this.pages.push(page)
    return Promise.resolve(page)
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

  newContext(options?: Record<string, unknown>): Promise<FakeContext> {
    if (!this.connected) return Promise.reject(new Error('Target page, context or browser has been closed'))
    const ctx = new FakeContext(options)
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
