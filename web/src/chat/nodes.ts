import { useRef } from 'react'
import type { ChatNode } from './grouping'

/**
 * Os nós da conversa (`groupActions`) como linhas da lista virtual.
 *
 * A biblioteca identifica cada linha pela chave e guarda a posição da tela pelo
 * índice absoluto (`firstItemIndex` + posição no array). Acrescentar no topo
 * desconta de `firstItemIndex` quantos NÓS entraram acima — não quantos itens:
 * ações da página antiga podem entrar no grupo que já estava no topo, e aí
 * entram itens sem entrar nó.
 */

/** Índice absoluto do primeiro nó numa conversa recém-aberta: sobra espaço para muitas páginas acima. */
export const FIRST_INDEX = 1_000_000

/** Chave do primeiro item de um nó (no grupo, o primeiro item dele). */
function firstItemKey(node: ChatNode): string | undefined {
  return node.kind === 'group' ? node.items[0]?.item.key : node.item.key
}

/** Chave da linha: a do item; no grupo, `g:` + a do primeiro item. Item sem chave cai no índice. */
export function nodeKey(node: ChatNode): string {
  if (node.kind === 'group') {
    const first = node.items[0]
    return `g:${first?.item.key ?? `i${first?.index ?? node.start}`}`
  }
  return node.item.key ?? `i${node.index}`
}

/** Posição em `nodes` do nó que contém o item de chave `itemKey` (-1 se nenhum): o que o `scrollToIndex` recebe. */
export function nodeIndexOfItem(nodes: ChatNode[], itemKey: string): number {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.kind === 'item' ? node.item.key === itemKey : node.items.some((it) => it.item.key === itemKey)) return i
  }
  return -1
}

/**
 * Quantos nós entraram acima do que era o primeiro: a posição, em `next`, do nó
 * que contém o item que abria `prev`. Zero quando o topo não mudou ou quando a
 * lista foi trocada inteira (o item não está mais lá).
 */
export function prependedNodes(prev: ChatNode[], next: ChatNode[]): number {
  if (prev.length === 0 || next.length === 0) return 0
  const key = firstItemKey(prev[0])
  if (key === undefined || firstItemKey(next[0]) === key) return 0
  return Math.max(0, nodeIndexOfItem(next, key))
}

/**
 * `firstItemIndex` da lista virtual para `nodes`: desconta os nós acrescentados
 * no topo desde o render anterior. Calculado no próprio render, para a
 * biblioteca receber os dados e o índice juntos. Recomeça ao trocar de sessão.
 */
export function useFirstItemIndex(localId: string | undefined, nodes: ChatNode[]): number {
  const ref = useRef({ localId, nodes, first: FIRST_INDEX })
  const cur = ref.current
  if (cur.localId !== localId) ref.current = { localId, nodes, first: FIRST_INDEX }
  else if (cur.nodes !== nodes) ref.current = { localId, nodes, first: cur.first - prependedNodes(cur.nodes, nodes) }
  return ref.current.first
}
