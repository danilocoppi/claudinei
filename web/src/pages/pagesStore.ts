import { create } from 'zustand'
import { useStore } from '../store'
import { getPage, listPages } from './api'
import type { VisualPageDto } from '../../../shared/visual-pages'

/**
 * Respostas visuais: as páginas de cada conversa (por `localId`), as buscadas
 * pelo id (chamada `show_page` cuja página não está na lista) e a página viva,
 * a única com iframe montado.
 */
interface PagesState {
  byLocal: Record<string, VisualPageDto[] | undefined>
  byId: Record<string, VisualPageDto | 'unavailable' | undefined>
  livePageId: string | null
  /** A última carga vence (contador por localId, como o undoStore). */
  load(localId: string): Promise<void>
  /** 403 (sem acesso) e 404 (apagada) viram 'unavailable'; outra falha lança e não marca nada. */
  fetchOne(id: string): Promise<void>
  setLive(id: string | null): void
}

// Carga em voo por localId: o número da última e as páginas que chegaram pelo
// WebSocket durante ela, reaplicadas por cima da resposta (que pode ter saído antes delas).
const loadSeq: Record<string, number> = {}
const pendingPages: Record<string, VisualPageDto[] | undefined> = {}
// Busca pelo id em voo: o mesmo cartão redesenhado não dispara outra.
const fetching = new Map<string, Promise<void>>()

/** A página entra no fim da lista, se ainda não estiver nela. */
function appendPage(list: VisualPageDto[], page: VisualPageDto): VisualPageDto[] {
  return list.some(p => p.id === page.id) ? list : [...list, page]
}

const isPage = (p: unknown): p is VisualPageDto =>
  p !== null && typeof p === 'object' && typeof (p as VisualPageDto).id === 'string'

export const usePagesStore = create<PagesState>((set) => ({
  byLocal: {},
  byId: {},
  livePageId: null,

  async load(localId) {
    const seq = (loadSeq[localId] ?? 0) + 1
    loadSeq[localId] = seq
    pendingPages[localId] = []
    let pages: VisualPageDto[]
    try {
      const body: unknown = await listPages(localId)
      // Corpo torto vira conversa sem páginas em vez de derrubar o chat.
      pages = Array.isArray(body) ? body.filter(isPage) : []
    } catch (e) {
      // Uma carga mais nova assumiu: o erro desta não interessa mais.
      if (loadSeq[localId] !== seq) return
      pendingPages[localId] = undefined
      throw e
    }
    if (loadSeq[localId] !== seq) return
    for (const p of pendingPages[localId] ?? []) pages = appendPage(pages, p)
    pendingPages[localId] = undefined
    set(s => {
      const byId = { ...s.byId }
      for (const p of pages) byId[p.id] = p
      return { byLocal: { ...s.byLocal, [localId]: pages }, byId }
    })
  },

  fetchOne(id) {
    const inFlight = fetching.get(id)
    if (inFlight) return inFlight
    const run = (async () => {
      try {
        const page = await getPage(id)
        set(s => ({ byId: { ...s.byId, [id]: page } }))
      } catch (e) {
        const status = (e as { status?: number } | null)?.status
        if (status !== 403 && status !== 404) throw e
        set(s => ({ byId: { ...s.byId, [id]: 'unavailable' } }))
      } finally {
        fetching.delete(id)
      }
    })()
    fetching.set(id, run)
    return run
  },

  setLive(id) {
    set({ livePageId: id })
  },
}))

/** Recarrega, sem esperar nem lançar, as conversas carregadas. */
function reloadLoaded(): void {
  const { byLocal, load } = usePagesStore.getState()
  for (const localId of Object.keys(byLocal)) {
    if (!byLocal[localId]) continue
    load(localId).catch(e => console.warn('[páginas] recarga da lista falhou', localId, e))
  }
}

/**
 * Mensagens do WebSocket das páginas, ao lado do `applyUndoWsMessage`:
 * `visual_page` entra na lista da conversa (se carregada) e em `byId`; do
 * terminal aberto nesta aba, vira a página viva.
 */
export function applyPagesWsMessage(msg: any): void {
  if (!msg || typeof msg !== 'object' || msg.type !== 'visual_page' || !isPage(msg.page)) return
  const page = msg.page as VisualPageDto
  const localId = typeof msg.localId === 'string' ? msg.localId : page.localId
  pendingPages[localId]?.push(page)
  const live = localId === useStore.getState().activeLocalId
  usePagesStore.setState(s => {
    const list = s.byLocal[localId]
    return {
      byId: { ...s.byId, [page.id]: page },
      ...(list ? { byLocal: { ...s.byLocal, [localId]: appendPage(list, page) } } : {}),
      ...(live ? { livePageId: page.id } : {}),
    }
  })
}

// Reconexão: o servidor não reenvia o que se perdeu na queda. Mesmo sinal do
// `resyncOnReconnect` (`progressEpoch`), que o undoStore usa.
useStore.subscribe((s, prev) => {
  if (s.progressEpoch !== prev.progressEpoch) reloadLoaded()
})
