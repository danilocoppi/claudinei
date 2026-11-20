import { useCallback, useSyncExternalStore } from 'react'
import { useStore } from '../store'
import { fetchHistory } from '../api'
import { groupActions } from './grouping'
import { prependedNodes } from './nodes'

/**
 * Página anterior da conversa: o carregador ÚNICO, de quem chega ao topo da
 * lista (ChatView) e de quem vai a uma ocorrência antiga da busca. Um pedido
 * por vez por sessão: quem pede com um no ar recebe o mesmo. Dois caminhos
 * independentes pediriam o mesmo `before` em paralelo, e o `prependHistory`
 * descartaria a segunda página como velha.
 */

/** Tamanho da página que sobe. */
export const OLDER_PAGE_LIMIT = 200

export interface OlderResult {
  /** A página chegou (falha: false — o cursor ficou onde estava). */
  ok: boolean
  /**
   * Entrou e o topo não ganhou nó novo — página sem nada que apareça, ou só
   * ações que entraram no grupo do topo: o cursor andou, mas a lista não vê
   * nada novo no topo e não avisa de novo.
   */
  topUnchanged: boolean
}

const inFlight = new Map<string, Promise<OlderResult>>()
/**
 * Sessões que esperam o operador para pedir a página anterior: o último pedido
 * falhou, ou a sequência automática do topo bateu no teto. O topo da lista
 * mostra "carregar mensagens anteriores" (sem isso, nem "carregando" nem
 * "início": o operador não saberia que há mais acima). Uma página que entra,
 * venha de quem vier, tira a espera.
 */
const waitingTop = new Set<string>()
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

/** Põe a sessão à espera do operador no topo (falha ou teto da sequência). */
export function markOlderWaiting(localId: string): void {
  if (waitingTop.has(localId)) return
  waitingTop.add(localId)
  notify()
}

/** A sessão espera o operador para pedir a página anterior? */
export function isOlderWaiting(localId: string): boolean {
  return waitingTop.has(localId)
}

/** Há uma página anterior a caminho para a sessão? */
export function isLoadingOlder(localId: string): boolean {
  return inFlight.has(localId)
}

/**
 * Pede a página anterior ao cursor da sessão e a acrescenta no topo, com o
 * `before` pedido (o prependHistory descarta a página se o cursor andou
 * enquanto ela vinha). Null quando não há o que pedir (sem cursor, ou já no
 * começo). Falha não marca o começo: devolve `ok: false`.
 */
export function loadOlderPage(localId: string): Promise<OlderResult> | null {
  const emCurso = inFlight.get(localId)
  if (emCurso) return emCurso
  const cursor = useStore.getState().historyCursor[localId]
  if (!cursor || cursor.atStart) return null
  const before = cursor.before
  const p = fetchHistory(localId, before, OLDER_PAGE_LIMIT)
    .then((page): OlderResult => {
      const st0 = useStore.getState()
      const working = st0.sessions[localId]?.status === 'working'
      const antes = groupActions(st0.chat[localId] ?? [], working)
      st0.prependHistory(localId, page, before)
      waitingTop.delete(localId)
      const st = useStore.getState()
      const topUnchanged = !page.atStart && page.before < before && st.historyCursor[localId]?.before === page.before
        && prependedNodes(antes, groupActions(st.chat[localId] ?? [], working)) === 0
      return { ok: true, topUnchanged }
    })
    .catch((err): OlderResult => {
      console.error('[chat] falha ao carregar mensagens anteriores', err)
      return { ok: false, topUnchanged: false }
    })
    .finally(() => {
      inFlight.delete(localId)
      notify()
    })
  inFlight.set(localId, p)
  notify()
  return p
}

/** O topo da lista mostra "carregando…" com a página a caminho, venha de quem vier. */
export function useLoadingOlder(localId: string | undefined): boolean {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  }, [])
  return useSyncExternalStore(subscribe, () => (localId ? inFlight.has(localId) : false))
}

/** O topo da lista convida a carregar a página anterior: falhou, ou a sequência automática parou no teto. */
export function useOlderWaiting(localId: string | undefined): boolean {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  }, [])
  return useSyncExternalStore(subscribe, () => (localId ? waitingTop.has(localId) : false))
}
