import { create } from 'zustand'
import { progressKey, useStore } from '../store'
import { useSideStore } from '../branch/sideStore'
import { openBrowserTab, type BrowserApiError } from './api'
import { setBrowserFailure, setBrowserTab, useBrowserStore } from './browserStore'
import * as model from './columnModel'
import type { Avail, ColumnState, View } from './columnModel'

/**
 * O estado da coluna da direita do chat. O `open` é o `progressOpen` de sempre
 * do `useStore` (com o `claudinei:progressOpen`), lido e escrito por lá e não
 * repetido aqui; o resto do `ColumnState` vai em `claudinei:column`, e as
 * larguras por vista em `claudinei:columnWidths`.
 *
 * As ações que olham a vista à mostra (trocar, o agente abrir) partem da vista
 * efetiva do terminal ativo: uma Lateral ou um Navegador guardados que não
 * existem nele contam como Acompanhamento.
 */

const COLUMN_KEY = 'claudinei:column'
const WIDTHS_KEY = 'claudinei:columnWidths'
const VIEWS: readonly View[] = ['progress', 'side', 'browser']
const isView = (v: unknown): v is View => typeof v === 'string' && (VIEWS as readonly string[]).includes(v)

type Persisted = Omit<ColumnState, 'open'>
export type Widths = Partial<Record<View, number>>

interface ColumnStore extends Persisted {
  widths: Widths
  toggleView(v: View): void
  selectView(v: View): void
  closeColumn(): void
  toggleFullscreen(): void
  setWidth(v: View, px: number): void
  sideBorn(): void
  sideGone(): void
  agentOpened(): void
}

function readPersisted(): Persisted {
  const base: Persisted = { view: 'progress', previous: null, fullscreen: false, marked: [] }
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMN_KEY) ?? 'null') as Partial<Persisted> | null
    if (!raw || typeof raw !== 'object') return base
    return {
      view: isView(raw.view) ? raw.view : base.view,
      previous: raw.previous === 'closed' || isView(raw.previous) ? raw.previous : null,
      fullscreen: raw.fullscreen === true,
      marked: Array.isArray(raw.marked) ? [...new Set(raw.marked.filter(isView))] : [],
    }
  } catch {
    return base
  }
}

function readWidths(): Widths {
  try {
    const raw = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null') as Record<string, unknown> | null
    const out: Widths = {}
    if (raw && typeof raw === 'object') {
      for (const v of VIEWS) {
        const n = raw[v]
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[v] = Math.round(n)
      }
    }
    return out
  } catch {
    return {}
  }
}

const save = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* só não persiste */ }
}

/** O que existe no terminal (projeto + motor) além do Acompanhamento. */
export function availFor(key: string): Avail {
  const b = useBrowserStore.getState()
  return { side: !!useSideStore.getState().sides[key], browser: !!b.tabs[key] || !!b.failed[key] }
}

/** O terminal do chat à vista: a sessão ativa, com a visão de chat. */
export function activeTerminal(): { projectId: number; engine: string } | null {
  const s = useStore.getState()
  if (s.authStatus !== 'ready' || s.view !== 'chat' || !s.activeLocalId) return null
  const session = s.sessions[s.activeLocalId]
  return session ? { projectId: session.projectId, engine: session.engine } : null
}

function activeAvail(): Avail {
  const t = activeTerminal()
  return t ? availFor(progressKey(t.projectId, t.engine)) : { side: false, browser: false }
}

/** O estado inteiro, com o `open` do `useStore`. */
export function columnState(): ColumnState {
  const c = useColumnStore.getState()
  return { open: useStore.getState().progressOpen, view: c.view, previous: c.previous, fullscreen: c.fullscreen, marked: c.marked }
}

/** O estado com a vista guardada trocada pela que o terminal ativo mostra. */
function effective(): ColumnState {
  const s = columnState()
  return { ...s, view: model.effectiveView({ ...s, open: true }, activeAvail()) ?? s.view }
}

function commit(next: ColumnState): void {
  if (next.open !== useStore.getState().progressOpen) useStore.getState().toggleProgress()
  const c = useColumnStore.getState()
  if (c.view === next.view && c.previous === next.previous && c.fullscreen === next.fullscreen && c.marked === next.marked) return
  const persisted: Persisted = { view: next.view, previous: next.previous, fullscreen: next.fullscreen, marked: next.marked }
  useColumnStore.setState(persisted)
  save(COLUMN_KEY, persisted)
}

export const useColumnStore = create<ColumnStore>(() => ({
  ...readPersisted(),
  widths: readWidths(),
  toggleView: (v) => commit(model.toggleView(effective(), v)),
  selectView: (v) => commit(model.selectView(columnState(), v)),
  closeColumn: () => commit(model.close(columnState())),
  toggleFullscreen: () => {
    const s = columnState()
    commit({ ...s, fullscreen: !s.fullscreen })
  },
  setWidth: (v, px) => {
    const widths = { ...useColumnStore.getState().widths, [v]: Math.round(px) }
    useColumnStore.setState({ widths })
    save(WIDTHS_KEY, widths)
  },
  sideBorn: () => commit(model.sideBorn(effective())),
  // Sem a vista efetiva: a lateral já saiu do store, e a vista guardada ('side') é que diz para onde voltar.
  sideGone: () => commit(model.sideGone(columnState())),
  agentOpened: () => commit(model.agentOpened(effective())),
}))

/** A vista à mostra no terminal (projeto + motor); `null` com a coluna fechada. Assinatura de valor simples. */
export function useEffectiveView(projectId: number, engine: string): View | null {
  const key = progressKey(projectId, engine)
  const open = useStore((s) => s.progressOpen)
  const view = useColumnStore((s) => s.view)
  const side = useSideStore((s) => !!s.sides[key])
  const browser = useBrowserStore((s) => !!s.tabs[key] || !!s.failed[key])
  return model.effectiveView({ open, view, previous: null, fullscreen: false, marked: [] }, { side, browser })
}

/**
 * A classe do `.chat-layout`: com a coluna em tela cheia, o chat sai e ela cobre
 * a área (a lista de terminais fica). A vista vai junto, para o Zen saber que a
 * coluna do Acompanhamento sumiu e o chat precisa voltar.
 */
export function useChatLayoutClass(projectId: number, engine: string): string {
  const view = useEffectiveView(projectId, engine)
  const full = useColumnStore((s) => s.fullscreen)
  return view && full ? `chat-layout chat-layout--column-full chat-layout--full-${view}` : 'chat-layout'
}

/**
 * O Navegador do botão do cabeçalho e do Alt+B: com ele à vista, fecha a
 * coluna; senão abre a aba do terminal, se ele ainda não tem, e mostra a vista.
 * Sem Chromium (ou outra recusa), a vista mostra o erro com a dica.
 */
export async function toggleBrowserView(projectId: number, engine: string): Promise<void> {
  const key = progressKey(projectId, engine)
  if (model.effectiveView(columnState(), availFor(key)) === 'browser') {
    useColumnStore.getState().closeColumn()
    return
  }
  if (!useBrowserStore.getState().tabs[key]) {
    try {
      await openBrowserTab(projectId, engine)
      setBrowserTab(key, true)
    } catch (err) {
      const e = err as BrowserApiError
      setBrowserFailure(key, { message: e.message, hint: e.hint })
    }
  }
  // `select`, não `toggle`: durante a espera o agente pode ter aberto a vista, e ela fica.
  useColumnStore.getState().selectView('browser')
}
