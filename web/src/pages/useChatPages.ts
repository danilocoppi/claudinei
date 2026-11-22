import { createElement, useEffect, useMemo, type ReactNode } from 'react'
import { usePagesStore } from './pagesStore'
import { placePages } from './anchors'
import { PageCard } from '../components/PageCard'
import type { VisualPageDto } from '../../../shared/visual-pages'
import type { TurnDto } from '../../../shared/undo'
import type { ChatItem } from '../types'

const NONE = (): ReactNode => null

/**
 * Carrega a lista em (localId, engineSessionId); solta a viva ao trocar de
 * localId; devolve quem desenha, por posição, as páginas ancoradas no turno
 * (as que não têm chamada `show_page` visível). As com chamada visível o
 * `MessageBlock` desenha no lugar dela.
 *
 * Sem página ancorada, devolve sempre a mesma função: o `renderNode` do chat
 * não muda por causa dela.
 */
export function useChatPages(localId: string | null, engineSessionId: string | null, items: ChatItem[],
  turns: TurnDto[] | undefined, atStart: boolean): (afterIndex: number) => ReactNode {
  // Conversa nova no mesmo terminal (engineSessionId) também recarrega.
  useEffect(() => {
    if (!localId) return
    usePagesStore.getState().load(localId).catch((e) => console.warn('[páginas] a lista não carregou', localId, e))
  }, [localId, engineSessionId])

  // Trocar de terminal descarrega: a viva só fica se for deste terminal.
  useEffect(() => {
    const { livePageId, byId, setLive } = usePagesStore.getState()
    if (livePageId === null) return
    const live = byId[livePageId]
    if (typeof live === 'object' && live.localId === localId) return
    setLive(null)
  }, [localId])

  // Lista vazia conta como nenhuma (como os turnos do desfazer): a carga sem
  // páginas, a de quase toda conversa, não redesenha o chat.
  const pages = usePagesStore((s) => {
    const list = localId ? s.byLocal[localId] : undefined
    return list && list.length > 0 ? list : undefined
  })
  const at = useMemo<Map<number, VisualPageDto[]> | null>(
    () => (pages ? placePages(items, pages, turns, atStart).at : null),
    [items, pages, turns, atStart],
  )

  return useMemo(() => {
    if (!localId || !at || at.size === 0) return NONE
    return (afterIndex: number): ReactNode =>
      at.get(afterIndex)?.map((p) => createElement(PageCard, { key: p.id, pageId: p.id, localId, page: p })) ?? null
  }, [at, localId])
}
