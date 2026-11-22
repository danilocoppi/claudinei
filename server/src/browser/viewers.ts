// Os espectadores de uma aba: as colunas abertas (um socket cada) que mostram a
// tela. Aqui moram as regras do que sai para a web:
// - o screencast só roda com algum espectador visível e não congelado;
// - o mesmo quadro (o mesmo Buffer) vai a todos; o socket com mais de 512 KB na
//   fila guarda só o mais recente, e um relógio de 50 ms o manda quando a fila esvazia;
// - o viewport segue a coluna do dono do bastão; sem dono, a última que abriu;
//   sem coluna nenhuma, 1280×800. Na troca: `tab.setViewport` e `restart`, e
//   nenhum quadro do tamanho antigo sai depois do `state` com o viewport novo;
// - o `state` vai a cada mudança da aba, do bastão e dos espectadores, agrupado
//   (no máximo um a cada 50 ms; uma página com `alert` em laço não inunda o
//   socket), e o pendente sempre sai antes do próximo quadro;
// - a presença do bastão (o dono tem coluna visível?) é recalculada a cada
//   mudança de espectador.
// Nada é desenhado na imagem: a marca da ação do agente vai no `lastAction` do state.
import type { Page } from 'playwright-core'
import type { BrowserStateMsg } from '../../../shared/browser.js'
import { encodeFrame } from './frame.js'
import { createScreencast, type CdpLike, type Screencast } from './screencast.js'
import { clampViewport, DEFAULT_VIEWPORT, type TerminalTab } from './terminal-tab.js'

export interface ViewerSink { bufferedAmount: number; sendBinary(b: Buffer): void; sendText(s: string): void }
export interface Viewer {
  id: number; userId: number | null; name: string; sink: ViewerSink
  visible: boolean; frozen: boolean; size: { width: number; height: number } | null; openedAt: number
}

type Size = { width: number; height: number }

const MAX_BUFFERED = 512 * 1024
const RETRY_MS = 50
/** Intervalo mínimo entre dois `state` agrupados (o pendente sai antes de um quadro mesmo assim). */
const STATE_MIN_MS = 50
/** Teto da espera de uma troca de viewport (resize + restart) antes de aceitar a próxima. */
const APPLY_CAP_MS = 5_000

const sameSize = (a: Size | null, b: Size | null): boolean =>
  a === b || (!!a && !!b && a.width === b.width && a.height === b.height)

interface Entry { v: Viewer; pending: { buf: Buffer; width: number; height: number } | null }

export function createViewers(o: {
  tab: TerminalTab
  screencast: Screencast
  maxBuffered?: number /* 512*1024 */
  retryMs?: number /* 50 */
  now?: () => number
}) {
  const { tab, screencast } = o
  const maxBuffered = o.maxBuffered ?? MAX_BUFFERED
  const retryMs = o.retryMs ?? RETRY_MS
  const now = o.now ?? Date.now
  const entries = new Map<number, Entry>()
  let nextId = 0
  /** Cresce por aba (este conjunto é único por aba), quadros e congelados. */
  let seq = 0
  let disposed = false
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let stateTimer: ReturnType<typeof setTimeout> | undefined
  let lastStateAt = -Infinity
  /** Usuários com espectador na última conta: quem sai de vez recebe um `presence(false)`. */
  let knownUsers = new Set<number | null>()
  /** Uma troca de viewport por vez; a que chega no meio roda depois, com o valor do momento. */
  let applying = false
  let again = false

  const eligible = (v: Viewer): boolean => v.visible && !v.frozen

  function anyVisible(): boolean {
    for (const e of entries.values()) if (eligible(e.v)) return true
    return false
  }

  function sendBinary(e: Entry, buf: Buffer): void {
    try { e.v.sink.sendBinary(buf) } catch { /* socket fechando: o socket.ts tira o espectador */ }
  }

  /** O espectador mais recente, preferindo os visíveis (a coluna escondida não manda no tamanho de quem olha). */
  function latest(list: Viewer[]): Viewer {
    return list.reduce((best, v) => {
      if (v.visible !== best.visible) return v.visible ? v : best
      if (v.openedAt !== best.openedAt) return v.openedAt > best.openedAt ? v : best
      return v.id > best.id ? v : best
    })
  }

  function desiredViewport(): Size {
    const sized = [...entries.values()].map((e) => e.v).filter((v) => v.size)
    const b = tab.baton.state()
    if (b.kind === 'operator') {
      const own = sized.filter((v) => v.userId === b.userId)
      if (own.length) return clampViewport(latest(own).size!)
    }
    if (sized.length) return clampViewport(latest(sized).size!)
    return { ...DEFAULT_VIEWPORT }
  }

  function flushState(): void {
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = undefined }
    lastStateAt = now()
    const s = tab.state()
    const b = tab.baton.state()
    const closed = tab.closedReason()
    for (const e of entries.values()) {
      // Um quadro guardado de outro tamanho não sai depois deste state.
      if (e.pending && (e.pending.width !== s.viewport.width || e.pending.height !== s.viewport.height)) e.pending = null
      const msg: BrowserStateMsg = {
        type: 'state',
        url: s.url,
        title: s.title,
        loading: s.loading,
        crashed: s.crashed,
        baton: b.kind === 'operator'
          ? { kind: 'operator', name: b.name, you: e.v.userId === b.userId }
          : { kind: b.kind },
        viewport: s.viewport,
        dialog: s.dialog,
        notices: s.notices,
        lastAction: s.lastAction,
        sandbox: s.sandbox,
      }
      if (closed) msg.closed = closed
      try { e.v.sink.sendText(JSON.stringify(msg)) } catch { /* socket fechando */ }
    }
  }

  function scheduleState(): void {
    if (disposed || stateTimer) return
    const delay = Math.max(0, lastStateAt + STATE_MIN_MS - now())
    stateTimer = setTimeout(() => { stateTimer = undefined; flushState() }, delay)
  }

  function retry(): void {
    if (stateTimer) flushState()
    const vp = tab.state().viewport
    let waiting = false
    for (const e of entries.values()) {
      const p = e.pending
      if (!p) continue
      if (!eligible(e.v) || p.width !== vp.width || p.height !== vp.height) { e.pending = null; continue }
      if (e.v.sink.bufferedAmount > maxBuffered) { waiting = true; continue }
      e.pending = null
      sendBinary(e, p.buf)
    }
    if (!waiting && retryTimer) { clearInterval(retryTimer); retryTimer = undefined }
  }

  function armRetry(): void {
    if (retryTimer || disposed) return
    retryTimer = setInterval(retry, retryMs)
  }

  /**
   * Leva o viewport da aba ao desejado. O `tab.setViewport` troca o valor na
   * hora (antes de esperar a página): a partir dali o quadro do tamanho antigo
   * é descartado em `broadcastFrame`, e o `restart` começa com o tamanho novo.
   */
  function syncViewport(): void {
    if (disposed) return
    if (applying) { again = true; return }
    // Coluna aberta que ainda não mandou o tamanho (o `resize` vem logo): o
    // viewport fica onde está, em vez de ir a 1280×800 e voltar.
    if (entries.size > 0 && ![...entries.values()].some((e) => e.v.size)) return
    const want = desiredViewport()
    if (sameSize(want, tab.state().viewport)) return
    // Parado, o screencast começa depois com o tamanho novo: restart não faz falta.
    const wasRunning = screencast.running()
    applying = true
    let cap: ReturnType<typeof setTimeout> | undefined
    const step = (async () => {
      await tab.setViewport(want)
      if (wasRunning && !disposed) await screencast.restart()
    })()
    // Página presa num laço pode não responder ao resize: a próxima troca não
    // fica esperando por ela além do teto.
    const capped = new Promise<void>((resolve) => { cap = setTimeout(resolve, APPLY_CAP_MS) })
    void Promise.race([step, capped])
      .catch(() => { /* página fechando: a aba avisa pelo onClosed */ })
      .finally(() => {
        clearTimeout(cap)
        applying = false
        if (again) { again = false; syncViewport() }
      })
  }

  /** Algo mudou nos espectadores: visibilidade da aba, presença, viewport, screencast e state. */
  function changed(): void {
    if (disposed) return
    let columnVisible = false
    const present = new Map<number | null, boolean>()
    for (const e of entries.values()) {
      if (e.v.visible) columnVisible = true
      present.set(e.v.userId, (present.get(e.v.userId) ?? false) || e.v.visible)
      if (e.pending && !eligible(e.v)) e.pending = null
    }
    tab.setColumnVisible(columnVisible)
    // Quem saiu de vez também conta: o dono sem coluna devolve o bastão em 30 s.
    for (const u of knownUsers) if (!present.has(u)) present.set(u, false)
    for (const [u, visible] of present) tab.baton.presence(u, visible)
    knownUsers = new Set([...entries.values()].map((e) => e.v.userId))
    syncViewport()
    const want = anyVisible()
    if (want && !screencast.running()) void screencast.start()
    else if (!want && screencast.running()) void screencast.stop()
    scheduleState()
  }

  function dispose(): void {
    if (disposed) return
    // O último state leva o motivo do fechamento (`closed`).
    flushState()
    disposed = true
    if (retryTimer) { clearInterval(retryTimer); retryTimer = undefined }
    for (const e of entries.values()) e.pending = null
    offState()
    offBaton()
    void screencast.stop()
  }

  const offState = tab.onState(scheduleState)
  const offBaton = tab.baton.onChange(() => {
    syncViewport()
    scheduleState()
  })
  tab.onClosed(dispose)

  return {
    /** O objeto devolvido é o guardado: mude-o só por `update`. */
    add(v: Omit<Viewer, 'id' | 'openedAt'>): Viewer {
      const viewer: Viewer = { ...v, size: v.size ? { ...v.size } : null, id: ++nextId, openedAt: now() }
      entries.set(viewer.id, { v: viewer, pending: null })
      changed()
      return viewer
    },

    remove(id: number): void {
      if (!entries.delete(id)) return
      changed()
    },

    update(id: number, patch: Partial<Pick<Viewer, 'visible' | 'frozen' | 'size'>>): void {
      const e = entries.get(id)
      if (!e) return
      let diff = false
      if (patch.visible !== undefined && patch.visible !== e.v.visible) { e.v.visible = patch.visible; diff = true }
      if (patch.frozen !== undefined && patch.frozen !== e.v.frozen) { e.v.frozen = patch.frozen; diff = true }
      if (patch.size !== undefined) {
        const size = patch.size ? { width: patch.size.width, height: patch.size.height } : null
        if (!sameSize(size, e.v.size)) { e.v.size = size; diff = true }
      }
      if (diff) changed()
    },

    broadcastFrame(jpeg: Buffer, size: Size): void {
      if (disposed) return
      // Quadro de antes da troca de viewport (ainda em trânsito): descartado.
      const vp = tab.state().viewport
      if (size.width !== vp.width || size.height !== vp.height) return
      if (stateTimer) flushState()
      const targets = [...entries.values()].filter((e) => eligible(e.v))
      if (targets.length === 0) return
      const buf = encodeFrame({ kind: 'frame', seq: ++seq, width: size.width, height: size.height }, jpeg)
      for (const e of targets) {
        if (e.v.sink.bufferedAmount > maxBuffered) {
          e.pending = { buf, width: size.width, height: size.height }
          armRetry()
        } else {
          e.pending = null
          sendBinary(e, buf)
        }
      }
    },

    /**
     * O congelado (`freeze`, PNG) só a este espectador, com o seq da aba. Sai na
     * hora, com a fila cheia ou não; o quadro guardado dele é descartado.
     */
    sendStill(id: number, png: Buffer, size: Size): void {
      const e = entries.get(id)
      if (!e || disposed) return
      if (stateTimer) flushState()
      e.pending = null
      sendBinary(e, encodeFrame({ kind: 'still', seq: ++seq, width: size.width, height: size.height }, png))
    },

    /** Manda o state agora (o agrupado pendente sai junto). */
    broadcastState(): void {
      if (!disposed) flushState()
    },

    anyVisible,
    desiredViewport,
  }
}

export type Viewers = ReturnType<typeof createViewers>

/** O que o screencast usa de uma sessão CDP do Playwright. */
interface CdpSessionLike {
  send(method: string, params?: object): Promise<any>
  on(ev: string, fn: (p: any) => void): unknown
  off(ev: string, fn: (p: any) => void): unknown
  detach(): Promise<void>
}

/**
 * Uma sessão CDP que acompanha a página da aba: nasce no primeiro uso e, quando
 * a recuperação da queda troca a página, os ouvintes passam para a sessão da nova.
 */
function followingCdp(tab: TerminalTab): CdpLike & { swap(page: Page): void; dispose(): void } {
  const listeners = new Map<string, Set<(p: any) => void>>()
  let page = tab.page()
  let opening: Promise<CdpSessionLike> | null = null
  let live: CdpSessionLike | null = null
  let gen = 0
  let disposed = false

  const closedError = () => new Error('Target page, context or browser has been closed')

  function open(): Promise<CdpSessionLike> {
    if (disposed) return Promise.reject(closedError())
    if (!opening) {
      const g = gen
      opening = tab.context.newCDPSession(page).then((raw) => {
        const s = raw as unknown as CdpSessionLike
        if (g !== gen || disposed) {
          void s.detach().catch(() => {})
          throw closedError()
        }
        for (const [ev, fns] of listeners) for (const fn of fns) s.on(ev, fn)
        live = s
        return s
      })
      opening.catch(() => { /* quem chamou send trata */ })
    }
    return opening
  }

  function drop(): void {
    gen++
    const old = live
    live = null
    opening = null
    if (!old) return
    for (const [ev, fns] of listeners) for (const fn of fns) old.off(ev, fn)
    void old.detach().catch(() => { /* página já fechada */ })
  }

  return {
    async send(method, params) {
      const s = await open()
      return s.send(method, params)
    },
    on(ev, fn) {
      let set = listeners.get(ev)
      if (!set) { set = new Set(); listeners.set(ev, set) }
      set.add(fn)
      live?.on(ev, fn)
    },
    off(ev, fn) {
      listeners.get(ev)?.delete(fn)
      live?.off(ev, fn)
    },
    swap(p) {
      drop()
      page = p
    },
    dispose() {
      disposed = true
      drop()
    },
  }
}

const registry = new WeakMap<TerminalTab, Viewers>()

/** Um conjunto por aba (WeakMap): cria o screencast com `context.newCDPSession(page)` e o religa no `tab.onPage`. */
export function viewersFor(tab: TerminalTab): Viewers {
  const found = registry.get(tab)
  if (found) return found
  const cdp = followingCdp(tab)
  let viewers: Viewers | undefined
  const screencast = createScreencast({
    cdp,
    size: () => tab.state().viewport,
    onFrame: (jpeg, size) => viewers?.broadcastFrame(jpeg, size),
  })
  viewers = createViewers({ tab, screencast })
  tab.onPage((p) => {
    cdp.swap(p)
    void screencast.restart()
  })
  // Depois do `onClosed` dos espectadores (o último state e o stop vão antes).
  tab.onClosed(() => cdp.dispose())
  registry.set(tab, viewers)
  return viewers
}
