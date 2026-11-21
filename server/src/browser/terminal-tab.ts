// A aba de um terminal: um contexto isolado com uma página só. Aqui moram a
// política de navegação (o vigia do quadro principal), as janelas novas (viram
// navegação na própria aba), os diálogos, os downloads bloqueados, o seletor de
// arquivo cancelado e a recuperação da página travada. Nada vai ao banco.
//
// Só `import type` do playwright-core: o pacote é carregado sob demanda no launch.
import type { BrowserContext, ConsoleMessage, Dialog, Download, FileChooser, Frame, Page } from 'playwright-core'
import { allowedUrl, isChromiumErrorPage, normalizeAddress } from './url-policy.js'
import { createBaton, type Baton } from './baton.js'
import { TEXTS, type ConsoleEntry, type TabCloseReason, type TerminalKey } from './types.js'

export type Actor = { kind: 'agent' } | { kind: 'operator'; userId: number | null; name: string }
export interface PendingDialog { id: number; type: 'confirm' | 'prompt'; message: string; defaultValue?: string }
export interface TabSnapshotState {
  url: string; title: string; loading: boolean; crashed: boolean
  viewport: { width: number; height: number }
  dialog: PendingDialog | null
  /** Para a coluna (últimos 5). */
  notices: string[]
  lastAction: { text: string; at: number; point?: { x: number; y: number } } | null
  sandbox: boolean
}

/** A última snapshot do agente: o epoch do bastão de quando foi tirada e o texto (já mascarado e cortado). */
export interface AgentSnapshot { epoch: number; text: string }

export interface TerminalTab {
  readonly key: TerminalKey
  readonly context: BrowserContext
  /** Quem pode mexer na página agora (agente ou operador). */
  readonly baton: Baton
  page(): Page
  /** Hora da última ferramenta do agente nesta aba (a varredura de ociosidade lê). */
  lastAgentAt: number
  /** Há coluna aberta e visível desta aba? A Task 9 liga aos espectadores; aqui: false. */
  isVisible(): boolean
  /** Com a aba já fechada, chama `fn` na hora com o motivo. */
  onClosed(fn: (reason: TabCloseReason) => void): () => void
  /** O motivo do fechamento; aberta: null. */
  closedReason(): TabCloseReason | null
  close(reason: TabCloseReason): Promise<void>
  state(): TabSnapshotState
  /** Mudou algo do `state()`. */
  onState(fn: () => void): () => void
  /** Lança Error(SCHEME_REFUSED) fora da política, sem tocar na página. */
  navigate(input: string): Promise<void>
  /** Com a página travada, qualquer uma recria a página no mesmo contexto, na última URL. */
  history(action: 'back' | 'forward' | 'reload'): Promise<void>
  /** A página foi trocada (recuperação da queda): o screencast se religa nela. */
  onPage(fn: (page: Page) => void): () => void
  /** Sem diálogo pendente: no-op. */
  answerDialog(accept: boolean, text?: string): void
  /** Grampeia em 320×240..1920×1200. */
  setViewport(size: { width: number; height: number }): Promise<void>
  /** Avisos ainda não entregues ao agente; esvazia. */
  takeAgentNotices(): string[]
  pushNotice(text: string, forAgent: boolean): void
  /**
   * A última snapshot do agente nesta aba (as operações do agente são criadas a
   * cada chamada; a referência vale contra esta). Sem snapshot: null.
   */
  agentSnapshot: AgentSnapshot | null
  /** A última ação do agente, para a coluna ("clicked 'Enviar'" e o ponto do clique). */
  setLastAction(text: string, point?: { x: number; y: number }): void
  /** As últimas 50 mensagens do console e erros da página (a recriada pela queda também). */
  consoleMessages(): ConsoleEntry[]
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const
const MIN_VIEWPORT = { width: 320, height: 240 }
const MAX_VIEWPORT = { width: 1920, height: 1200 }
/** Espera do `load` numa navegação da aba; estourada, a página segue carregando e a chamada volta. */
const LOAD_TIMEOUT_MS = 10_000
const COLUMN_NOTICES = 5
/** Teto dos avisos guardados para o agente: uma página com `alert` em laço não enche a memória. */
const AGENT_NOTICES = 20
/**
 * Depois de uma navegação que falhou (rede, redirecionamento recusado, outra
 * navegação por cima), a página de erro do Chromium ou a outra navegação ainda
 * chega seu quadro; esperar o `load` dela por até isto evita que a próxima
 * navegação seja interrompida por ela.
 */
const SETTLE_MS = 1_500
/** Mensagem de diálogo maior que isto sai cortada no aviso. */
const MESSAGE_MAX = 500
/** As mensagens do console guardadas (o que a `browser_console` devolve). */
const CONSOLE_MAX = 50

const isTimeout = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError'

export function clampViewport(size: { width: number; height: number }): { width: number; height: number } {
  const dim = (v: number, min: number, max: number, dflt: number) =>
    Math.min(max, Math.max(min, Number.isFinite(v) ? Math.round(v) : dflt))
  return {
    width: dim(size.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width, DEFAULT_VIEWPORT.width),
    height: dim(size.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height, DEFAULT_VIEWPORT.height),
  }
}

const clip = (s: string): string => (s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX)}…` : s)

/** O esquema de uma URL recusada, para o aviso (`chrome:`, `file:`…). */
function schemeOf(raw: string): string {
  const m = /^[a-z][a-z0-9+.-]*:/i.exec(raw)
  return m ? m[0].toLowerCase() : 'an unknown scheme'
}

export function createTerminalTab(o: {
  key: TerminalKey
  context: BrowserContext
  page: Page
  now: () => number
  /** O viewport com que o contexto foi criado (o host decide; padrão 1280×800). */
  viewport?: { width: number; height: number }
  /** O Chromium subiu com a sandbox? (o host sabe; sem ela, a coluna avisa). */
  sandbox?: boolean
}): TerminalTab {
  const context = o.context
  const closeListeners = new Set<(reason: TabCloseReason) => void>()
  const stateListeners = new Set<() => void>()
  const pageListeners = new Set<(page: Page) => void>()
  let closed = false
  let closedReason: TabCloseReason | null = null

  let current = o.page
  let url = current.url()
  /** A última URL dentro da política: a recuperação da queda volta para ela. */
  let lastUrl = allowedUrl(url) ? url : 'about:blank'
  let title = ''
  let loading = false
  let crashed = false
  let viewport = clampViewport(o.viewport ?? DEFAULT_VIEWPORT)
  let dialogSeq = 0
  let pending: { dialog: Dialog; info: PendingDialog } | null = null
  const notices: string[] = []
  const agentNotices: string[] = []
  let lastAction: TabSnapshotState['lastAction'] = null
  const consoleLog: ConsoleEntry[] = []
  /** Conta as navegações do quadro principal: a leitura de `readyState` de uma antiga não vale. */
  let navSeq = 0
  /**
   * A página que a recuperação está criando: o evento 'page' dela não é janela
   * nova. Existe antes da chamada ao `newPage`, porque o evento pode sair antes
   * de a chamada voltar.
   */
  let ownPage: Promise<Page | null> | null = null
  let recovering: Promise<Page> | null = null
  // A devolução do bastão vai à coluna e à próxima ferramenta do agente.
  const baton = createBaton({ onNotice: (text) => pushNotice(text, true) })

  function emit(): void {
    for (const fn of [...stateListeners]) {
      try { fn() } catch { /* um ouvinte não impede os outros */ }
    }
  }

  function pushConsole(e: ConsoleEntry): void {
    consoleLog.push(e)
    if (consoleLog.length > CONSOLE_MAX) consoleLog.splice(0, consoleLog.length - CONSOLE_MAX)
  }

  function pushNotice(text: string, forAgent: boolean): void {
    notices.push(text)
    if (notices.length > COLUMN_NOTICES) notices.splice(0, notices.length - COLUMN_NOTICES)
    if (forAgent) {
      agentNotices.push(text)
      if (agentNotices.length > AGENT_NOTICES) agentNotices.splice(0, agentNotices.length - AGENT_NOTICES)
    }
    emit()
  }

  /**
   * Navega e espera o `load` por até 10 s; estourado, a página segue e a chamada
   * volta. Falha de outro tipo: espera a página assentar e lança a falha.
   */
  async function gotoUrl(p: Page, href: string): Promise<void> {
    try {
      await p.goto(href, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS })
    } catch (err) {
      if (isTimeout(err)) return
      await p.waitForEvent('load', { timeout: SETTLE_MS }).catch(() => { /* nada chegou: segue */ })
      throw err
    }
  }

  /** O operador navegou com um diálogo aberto: o diálogo sai como "Cancelar". */
  function dismissPending(): void {
    if (!pending) return
    const d = pending.dialog
    pending = null
    void d.dismiss().catch(() => { /* a página já pode ter fechado o diálogo */ })
    emit()
  }

  // Ouvintes de uma página; a recuperação da queda os tira da velha e põe na nova.
  function attach(p: Page): () => void {
    const onFrameNavigated = (frame: Frame) => {
      if (frame !== p.mainFrame()) return
      const u = frame.url()
      // O vigia: redirecionamento ou script que levou o quadro principal para fora
      // da política volta para about:blank. A página de erro do Chromium não conta.
      if (!allowedUrl(u) && !isChromiumErrorPage(u)) {
        pushNotice(`navigation to ${schemeOf(u)} blocked; back to about:blank`, true)
        void p.goto('about:blank').catch(() => { /* a página pode ter travado ou fechado */ })
        return
      }
      url = u
      if (allowedUrl(u)) lastUrl = u
      loading = true
      // Navegação no mesmo documento (pushState, âncora) não tem `load`: com o
      // documento já completo, o "carregando" não fica ligado.
      const n = ++navSeq
      p.evaluate('document.readyState').then((rs) => {
        if (n === navSeq && rs === 'complete' && loading && p === current) { loading = false; emit() }
      }, () => { /* página travada, fechada ou com diálogo: o `load` decide */ })
      emit()
    }
    const onLoad = () => {
      loading = false
      emit()
      p.title().then((t) => {
        if (p !== current || t === title) return
        title = t
        emit()
      }, () => { /* página trocada no meio */ })
    }
    const onDialog = (d: Dialog) => {
      const type = d.type()
      const message = clip(d.message())
      if (type === 'alert' || type === 'beforeunload') {
        void d.accept().catch(() => {})
        pushNotice(type === 'alert' ? `alert accepted: "${message}"` : 'beforeunload accepted', true)
        return
      }
      if (type !== 'confirm' && type !== 'prompt') {
        void d.dismiss().catch(() => {})
        return
      }
      // Um diálogo novo com outro pendente (não acontece na mesma página): o velho sai como "Cancelar".
      if (pending) void pending.dialog.dismiss().catch(() => {})
      const info: PendingDialog = { id: ++dialogSeq, type, message }
      if (type === 'prompt') info.defaultValue = d.defaultValue()
      pending = { dialog: d, info }
      pushNotice(`dialog pending: ${type} "${message}"`, true)
    }
    const onDownload = (d: Download) => {
      // `acceptDownloads: false`: o Chromium recusa; nada vai ao disco do servidor.
      pushNotice(`download blocked: ${d.suggestedFilename()}, from ${d.url()}`, true)
    }
    const onFileChooser = (fc: FileChooser) => {
      void fc.setFiles([]).catch(() => {})
      pushNotice('file chooser cancelled (file upload is not supported)', true)
    }
    const onConsole = (m: ConsoleMessage) => pushConsole({ type: m.type(), text: m.text() })
    const onPageError = (e: Error) => pushConsole({ type: 'pageerror', text: e.message })
    const onCrash = () => {
      if (p !== current || closed) return
      markCrashed()
    }
    // Página que fecha sozinha (não pela aba nem pela recuperação): trata como travada.
    const onClose = () => {
      if (p !== current || closed || recovering) return
      markCrashed()
    }
    p.on('framenavigated', onFrameNavigated)
    p.on('load', onLoad)
    p.on('dialog', onDialog)
    p.on('download', onDownload)
    p.on('filechooser', onFileChooser)
    p.on('console', onConsole)
    p.on('pageerror', onPageError)
    p.on('crash', onCrash)
    p.on('close', onClose)
    return () => {
      p.off('framenavigated', onFrameNavigated)
      p.off('load', onLoad)
      p.off('dialog', onDialog)
      p.off('download', onDownload)
      p.off('filechooser', onFileChooser)
      p.off('console', onConsole)
      p.off('pageerror', onPageError)
      p.off('crash', onCrash)
      p.off('close', onClose)
    }
  }

  function markCrashed(): void {
    if (crashed) return
    crashed = true
    loading = false
    pending = null
    pushNotice('page crashed; use browser_navigate action=reload', true)
  }

  let detach = attach(current)

  // Janela nova (target=_blank, window.open): fecha e navega a própria aba para a
  // URL dela. O Playwright só entrega a página nova depois que ela chegou à URL inicial.
  const onContextPage = async (p: Page) => {
    if (p === current) return
    const creating = ownPage
    if (creating && (await creating) === p) return
    const target = allowedUrl(p.url())
    await p.close().catch(() => {})
    if (closed || crashed || !target || target.href === 'about:blank') return
    await gotoUrl(current, target.href).catch(() => { /* erro de rede: a página de erro do Chromium aparece */ })
  }
  context.on('page', onContextPage)

  /** Recria a página no mesmo contexto (uma recuperação por vez) e avisa quem segue a página. */
  function recover(): Promise<Page> {
    if (recovering) return recovering
    recovering = (async () => {
      const old = current
      detach()
      let settle!: (p: Page | null) => void
      ownPage = new Promise((r) => { settle = r })
      let fresh: Page
      try {
        fresh = await context.newPage()
        settle(fresh)
      } catch (err) {
        settle(null)
        throw err
      } finally {
        ownPage = null
      }
      current = fresh
      detach = attach(fresh)
      crashed = false
      pending = null
      loading = false
      url = fresh.url()
      title = ''
      await old.close().catch(() => { /* a página travada pode não responder */ })
      // O contexto nasceu com o viewport inicial; a página nova recebe o atual.
      await fresh.setViewportSize(viewport).catch(() => {})
      for (const fn of [...pageListeners]) {
        try { fn(fresh) } catch { /* um ouvinte não impede os outros */ }
      }
      emit()
      return fresh
    })().finally(() => { recovering = null })
    return recovering
  }

  /** A página viva: com a queda, recria; senão, a atual. */
  const livePage = (): Promise<Page> => (crashed ? recover() : Promise.resolve(current))

  return {
    key: o.key,
    context,
    baton,
    page: () => current,
    lastAgentAt: o.now(),
    isVisible: () => false,

    onClosed(fn) {
      // Quem chega depois do fechamento (uma ferramenta que pegou a aba antes de
      // ela fechar) fica sabendo na hora, em vez de esperar um aviso que não vem.
      if (closedReason) {
        fn(closedReason)
        return () => {}
      }
      closeListeners.add(fn)
      return () => { closeListeners.delete(fn) }
    },

    closedReason: () => closedReason,

    async close(reason) {
      if (closed) return
      closed = true
      closedReason = reason
      // Avisa antes de fechar o contexto: quem tem uma ferramenta em curso nesta
      // aba fica sabendo do motivo antes de a operação do Playwright falhar.
      for (const fn of [...closeListeners]) {
        try { fn(reason) } catch { /* um ouvinte não impede os outros */ }
      }
      closeListeners.clear()
      baton.dispose()
      context.off('page', onContextPage)
      detach()
      stateListeners.clear()
      pageListeners.clear()
      await context.close().catch(() => { /* o Chromium já pode ter caído */ })
    },

    state: () => ({
      url,
      title,
      loading,
      crashed,
      viewport: { ...viewport },
      dialog: pending ? { ...pending.info } : null,
      notices: notices.slice(),
      lastAction: lastAction ? structuredClone(lastAction) : null,
      sandbox: o.sandbox ?? true,
    }),

    onState(fn) {
      stateListeners.add(fn)
      return () => { stateListeners.delete(fn) }
    },

    async navigate(input) {
      const target = allowedUrl(normalizeAddress(input))
      if (!target) throw new Error(TEXTS.SCHEME_REFUSED)
      const p = await livePage()
      dismissPending()
      await gotoUrl(p, target.href)
    },

    async history(action) {
      if (crashed) {
        const p = await recover()
        await gotoUrl(p, lastUrl)
        return
      }
      dismissPending()
      const opts = { waitUntil: 'load' as const, timeout: LOAD_TIMEOUT_MS }
      try {
        if (action === 'back') await current.goBack(opts)
        else if (action === 'forward') await current.goForward(opts)
        else await current.reload(opts)
      } catch (err) {
        if (!isTimeout(err)) throw err
      }
    },

    onPage(fn) {
      pageListeners.add(fn)
      return () => { pageListeners.delete(fn) }
    },

    answerDialog(accept, text) {
      if (!pending) return
      const { dialog, info } = pending
      pending = null
      const done = !accept
        ? dialog.dismiss()
        : info.type === 'prompt' ? dialog.accept(text ?? info.defaultValue ?? '') : dialog.accept()
      void done.catch(() => { /* a página já pode ter fechado o diálogo */ })
      emit()
    },

    async setViewport(size) {
      const v = clampViewport(size)
      if (v.width === viewport.width && v.height === viewport.height) return
      viewport = v
      // Página travada: a recuperação aplica o viewport na página nova.
      if (!crashed) await current.setViewportSize(v).catch(() => {})
      emit()
    },

    takeAgentNotices: () => agentNotices.splice(0),

    pushNotice,

    agentSnapshot: null,

    setLastAction(text, point) {
      lastAction = point ? { text, at: o.now(), point: { ...point } } : { text, at: o.now() }
      emit()
    },

    consoleMessages: () => consoleLog.slice(),
  }
}
