import type { MutableRefObject } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'

/**
 * Handle da lista virtual da conversa aberta (só há um ChatView montado), para
 * quem precisa rolar de fora dela — a busca leva a tela até uma ocorrência.
 *
 * `scrollToIndex` recebe a posição no array de nós (0 = primeiro nó carregado),
 * não o índice absoluto com `firstItemIndex`. Os nós se derivam de
 * `groupActions(chat[localId], status === 'working')`, e `nodeIndexOfItem`
 * (chat/nodes.ts) acha o nó que contém a chave de um item.
 */
export const chatListRef: MutableRefObject<VirtuosoHandle | null> = { current: null }
