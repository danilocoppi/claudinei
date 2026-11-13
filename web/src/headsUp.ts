import type { HeadsUpNode } from './types'

/** Um aviso na faixa: `live` é o que o plugin desenha agora; os outros ficaram para trás. */
export interface HeadsUpCard { id: string; tree: HeadsUpNode; live: boolean }

/** O plugin desenha no máximo 4 cartões; a pilha daqui também. */
const MAX_CARDS = 4

export const headsUpKey = (tree: HeadsUpNode) => JSON.stringify(tree)

const texts = (node: HeadsUpNode, out: string[] = []): string[] => {
  if (typeof node === 'string') { out.push(node); return out }
  const md = node.props?.text
  if (node.type === 'Markdown' && typeof md === 'string') out.push(md)
  for (const child of node.children ?? []) texts(child, out)
  return out
}

/**
 * O mesmo aviso mudando de estado (oferta → explicando → explicado) mantém o
 * título; um aviso novo do plugin traz outro. Sem título comprido para comparar
 * (o "explicando…"), conta como o mesmo.
 */
function sameTopic(previous: HeadsUpNode, next: HeadsUpNode): boolean {
  const titles = texts(previous).filter((t) => t.trim().length >= 24)
  if (titles.length === 0) return true
  const now = texts(next)
  return titles.some((t) => now.includes(t))
}

/** A pilha depois de um `heads_up` (null = o plugin tirou o cartão dele). */
export function nextHeadsUps(cards: HeadsUpCard[], tree: HeadsUpNode | null): HeadsUpCard[] {
  const live = cards.find((c) => c.live)
  const old = cards.filter((c) => !c.live)
  if (tree === null) return old
  if (!live) return [...old, { id: headsUpKey(tree), tree, live: true }].slice(-MAX_CARDS)
  if (sameTopic(live.tree, tree)) return [...old, { ...live, tree }]
  return [...old, { ...live, live: false }, { id: headsUpKey(tree), tree, live: true }].slice(-MAX_CARDS)
}

/** O botão que fecha o lugar do plugin (`role: "dismiss"`): o X da faixa aciona ele. */
export function dismissOf(node: HeadsUpNode): { plugin: string; handle: number; key?: string } | null {
  if (typeof node === 'string') return null
  if (node.type === 'Button' && node.props?.role === 'dismiss' && node.press) {
    const key = typeof node.props.key === 'string' ? node.props.key : undefined
    return { ...node.press, ...(key ? { key } : {}) }
  }
  for (const child of node.children ?? []) {
    const found = dismissOf(child)
    if (found) return found
  }
  return null
}
