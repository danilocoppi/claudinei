import type { ChatItem } from '../types'

/**
 * Agrupamento de "ações" no chat: sequências de tool_call/thinking (a
 * instrumentação do turno, não mensagens) viram um nó de grupo colapsável,
 * para a leitura dos acontecimentos ficar limpa. Regras:
 *  - só agrupa quando a parte dobrável tem >= MIN_GROUP itens;
 *  - com o turno em andamento (working) e a conversa TERMINANDO em ações, a
 *    última ação fica FORA do grupo — é o que o operador quer acompanhar;
 *  - assim que vem qualquer outra coisa depois (texto, resultado…) ou o turno
 *    encerra, a cauda agrupa inteira.
 */
export type ChatNode =
  | { kind: 'item'; item: ChatItem; index: number }
  | { kind: 'group'; items: { item: ChatItem; index: number }[]; start: number }

export const MIN_GROUP = 3

const isAction = (it: ChatItem): boolean => it.kind === 'tool_call' || it.kind === 'thinking'

export function groupActions(items: ChatItem[], working: boolean): ChatNode[] {
  const nodes: ChatNode[] = []
  let i = 0
  while (i < items.length) {
    if (!isAction(items[i])) {
      nodes.push({ kind: 'item', item: items[i], index: i })
      i++
      continue
    }
    let j = i
    while (j < items.length && isAction(items[j])) j++
    const trailing = j === items.length
    const foldEnd = trailing && working ? j - 1 : j
    if (foldEnd - i >= MIN_GROUP) {
      nodes.push({
        kind: 'group',
        start: i,
        items: items.slice(i, foldEnd).map((item, k) => ({ item, index: i + k })),
      })
      for (let k = foldEnd; k < j; k++) nodes.push({ kind: 'item', item: items[k], index: k })
    } else {
      for (let k = i; k < j; k++) nodes.push({ kind: 'item', item: items[k], index: k })
    }
    i = j
  }
  return nodes
}

/** Nome de exibição de uma ação: tool direto, MCP encurtado, thinking fixo. */
const actionName = (it: ChatItem): string => {
  if (it.kind !== 'tool_call') return 'Thinking'
  const mcp = it.name.match(/^mcp__.+__(.+)$/)
  return mcp ? mcp[1] : it.name
}

/** Resumo "Bash ×2 · Read" na ordem de primeira aparição (até 4 nomes + …). */
export function groupSummary(items: ChatItem[]): string {
  const counts = new Map<string, number>()
  for (const it of items) {
    const name = actionName(it)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  return (parts.length > 4 ? [...parts.slice(0, 4), '…'] : parts).join(' · ')
}
