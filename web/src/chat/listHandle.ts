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

/**
 * O "grudado no fim" da conversa aberta. Quem registra é o ChatView.
 *
 * `release` solta: quem chama é a busca, ao levar a tela a uma ocorrência —
 * pedido do operador, e evento novo que chegar depois não pode arrancá-lo de lá.
 *
 * `grew` avisa que algo dentro de um item cresceu `px` (a página viva, pela
 * altura que ela manda): com a tela presa no fim, puxa junto, como o rodapé do
 * streaming. A lista virtual só puxa quando o crescimento passa da folga do
 * "no fim"; abaixo dela, a tela ficaria parada a alguns pixels do fim.
 */
export const chatFollow: { release: () => void; grew: (px: number) => void } = { release: () => {}, grew: () => {} }

/**
 * Gestos de rolagem do operador na conversa aberta (roda, toque, teclas de
 * rolar, clique na caixa), contados pelo ChatView. A busca compara com o valor
 * no Enter: se mudou, o operador voltou a ler e a primeira ocorrência que
 * chegar depois não o arranca de lá.
 */
export const chatUserScroll = { n: 0 }
