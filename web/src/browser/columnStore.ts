import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { progressKey, useStore } from '../store'
import { useSideStore } from '../branch/sideStore'
import { openBrowserTab, type BrowserApiError } from './api'
import { clearBrowserFailure, setBrowserFailure, setBrowserTab, useBrowserStore } from './browserStore'
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
 * existem nele contam como Acompanhamento. A marca das abas (`marked` do
 * modelo) é de cada terminal: as ações leem e gravam a do terminal ativo.
 */

const COLUMN_KEY = 'claudinei:column'
const WIDTHS_KEY = 'claudinei:columnWidths'
const VIEWS: readonly View[] = ['progress', 'side', 'browser']
const isView = (v: unknown): v is View => typeof v === 'string' && (VIEWS as readonly string[]).includes(v)

/** O `ColumnState` sem o `open` e com a marca por terminal (`progressKey` → vistas marcadas). */
interface Persisted extends Omit<ColumnState, 'open' | 'marked'> {
  marks: Record<string, View[]>
}
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
  /** Tira a marca da vista no terminal (a aba dela fechou). */
  unmark(key: string, v: View): void
}

function readPersisted(): Persisted {
  const base: Persisted = { view: 'progress', previous: null, fullscreen: false, marks: {} }
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMN_KEY) ?? 'null') as Partial<Persisted> | null
    if (!raw || typeof raw !== 'object') return base
    return {
      view: isView(raw.view) ? raw.view : base.view,
      previous: raw.previous === 'closed' || isView(raw.previous) ? raw.previous : null,
      fullscreen: raw.fullscreen === true,
      marks: readMarks(raw.marks),
    }
  } catch {
    return base
  }
}

/** A marca por terminal; o formato antigo (uma lista só, global) não vale para nenhum. */
function readMarks(raw: unknown): Record<string, View[]> {
  const out: Record<string, View[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    const views = Array.isArray(list) ? [...new Set(list.filter(isView))] : []
    if (views.length) out[key] = views
  }
  return out
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

function activeKey(): string | null {
  const t = activeTerminal()
  return t ? progressKey(t.projectId, t.engine) : null
}

const NO_MARKS: View[] = []
const NOTHING: Avail = { side: false, browser: false }

/** O estado inteiro, com o `open` do `useStore` e a marca do terminal `key` (por padrão, o ativo). */
export function columnState(key: string | null = activeKey()): ColumnState {
  const c = useColumnStore.getState()
  const marked = (key && c.marks[key]) || NO_MARKS
  return { open: useStore.getState().progressOpen, view: c.view, previous: c.previous, fullscreen: c.fullscreen, marked }
}

/** O estado com a vista guardada trocada pela que o terminal ativo mostra. */
function effective(): ColumnState {
  const key = activeKey()
  const s = columnState(key)
  return { ...s, view: model.effectiveView({ ...s, open: true }, key ? availFor(key) : NOTHING) ?? s.view }
}

/**
 * Grava o estado novo; a marca vai para o terminal ativo. A vista Navegador que
 * sai de cena (coluna fechada, outra vista) leva junto o erro da última abertura:
 * a aba que só existia por ele some, e a próxima tentativa começa limpa.
 */
function commit(next: ColumnState): void {
  const key = activeKey()
  const was = key ? model.effectiveView(columnState(key), availFor(key)) : null
  if (next.open !== useStore.getState().progressOpen) useStore.getState().toggleProgress()
  const c = useColumnStore.getState()
  const cur = (key && c.marks[key]) || NO_MARKS
  const marks = !key || next.marked === cur ? c.marks : withMarks(c.marks, key, next.marked)
  if (c.view !== next.view || c.previous !== next.previous || c.fullscreen !== next.fullscreen || marks !== c.marks) {
    const persisted: Persisted = { view: next.view, previous: next.previous, fullscreen: next.fullscreen, marks }
    useColumnStore.setState(persisted)
    save(COLUMN_KEY, persisted)
  }
  if (key && was === 'browser' && model.effectiveView(columnState(key), availFor(key)) !== 'browser') clearBrowserFailure(key)
}

function withMarks(marks: Record<string, View[]>, key: string, views: View[]): Record<string, View[]> {
  if (views.length) return { ...marks, [key]: views }
  const { [key]: _gone, ...rest } = marks
  return rest
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
  unmark: (key, v) => {
    const c = useColumnStore.getState()
    const cur = c.marks[key]
    if (!cur?.includes(v)) return
    const marks = withMarks(c.marks, key, cur.filter((m) => m !== v))
    useColumnStore.setState({ marks })
    save(COLUMN_KEY, { view: c.view, previous: c.previous, fullscreen: c.fullscreen, marks } satisfies Persisted)
  },
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

/** A classe do `.chat-layout` do terminal, lida dos stores na hora. */
function layoutClass(key: string): string {
  if (!useColumnStore.getState().fullscreen) return 'chat-layout'
  const view = model.effectiveView(columnState(key), availFor(key))
  return view ? `chat-layout chat-layout--column-full chat-layout--full-${view}` : 'chat-layout'
}

/** Ouve os quatro stores de que a classe depende. Do módulo: a mesma função em todo render. */
function subscribeLayout(cb: () => void): () => void {
  const offs = [useStore.subscribe(cb), useColumnStore.subscribe(cb), useSideStore.subscribe(cb), useBrowserStore.subscribe(cb)]
  return () => { for (const off of offs) off() }
}

/**
 * A classe do `.chat-layout`: com a coluna em tela cheia, o chat sai e ela cobre
 * a área (a lista de terminais fica). A vista vai junto, para o Zen saber que a
 * coluna do Acompanhamento sumiu e o chat precisa voltar. Uma assinatura só, que
 * devolve a string: quem a usa (o ChatView, caro) só redesenha quando a classe
 * muda, não a cada troca de aba, de vista ou de lateral.
 */
export function useChatLayoutClass(projectId: number, engine: string): string {
  const key = progressKey(projectId, engine)
  return useSyncExternalStore(subscribeLayout, () => layoutClass(key))
}

/** Os terminais com um `POST` de abertura a caminho: um segundo aperto não abre outro. */
const opening = new Set<string>()

/** O terminal (projeto + motor) ainda é o do chat à vista. */
const stillActive = (projectId: number, engine: string): boolean => {
  const t = activeTerminal()
  return !!t && t.projectId === projectId && t.engine === engine
}

/**
 * O Navegador do botão do cabeçalho e do Alt+B: com ele à vista, fecha a
 * coluna; senão abre a aba do terminal, se ele ainda não tem, e mostra a vista.
 * Sem Chromium (ou outra recusa), a vista mostra o erro com a dica. Com a
 * abertura do terminal já a caminho, o aperto não faz nada; e, se o operador
 * foi a outro terminal durante a espera, a coluna dele fica como está.
 */
export async function toggleBrowserView(projectId: number, engine: string): Promise<void> {
  const key = progressKey(projectId, engine)
  if (opening.has(key)) return
  if (model.effectiveView(columnState(key), availFor(key)) === 'browser') {
    useColumnStore.getState().closeColumn()
    return
  }
  if (!useBrowserStore.getState().tabs[key]) {
    // Tentar de novo começa limpo: o erro anterior sai.
    clearBrowserFailure(key)
    opening.add(key)
    try {
      await openBrowserTab(projectId, engine)
      setBrowserTab(key, true)
    } catch (err) {
      const e = err as BrowserApiError
      setBrowserFailure(key, { code: e.code, message: e.message, hint: e.hint })
    } finally {
      opening.delete(key)
    }
    if (!stillActive(projectId, engine)) return
  }
  // `select`, não `toggle`: durante a espera o agente pode ter aberto a vista, e ela fica.
  useColumnStore.getState().selectView('browser')
}
