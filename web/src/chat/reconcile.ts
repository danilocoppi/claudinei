import { applyEventInto } from './applyEvent'
import type { ChatItem, ClaudeEvent, HistoryPage } from '../types'

/**
 * Reconciliação do chat por chave estável (ver `posKey` em applyEvent.ts).
 *
 * O refetch do fim do turno relia o histórico e SUBSTITUÍA a lista: tudo virava
 * objeto novo e cada bloco refazia o markdown, e as páginas antigas que o
 * operador tinha carregado sumiam. Aqui o que não mudou devolve o MESMO objeto,
 * e o que está fora da página relida fica onde estava.
 */

/** Resultados de ferramenta cuja chamada ficou numa página ainda não carregada, por id do tool_use. */
export type OrphanResults = Record<string, { result: string; isError: boolean }>

/** Item ao vivo: chave provisória `l<n>` (ou nenhuma, nos itens antigos de teste). */
const isLive = (it: ChatItem): boolean => !it.key || it.key.startsWith('l')

/** Igualdade por valor de JSON: o `input` da ferramenta é um objeto novo a cada leitura. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => k in b && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** Rasa, campo a campo; só o `input` da ferramenta é comparado por valor. */
export function itemsEqual(a: ChatItem, b: ChatItem): boolean {
  if (a === b) return true
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra)
  if (ka.length !== Object.keys(rb).length) return false
  for (const k of ka) {
    if (!(k in rb)) return false
    if (ra[k] === rb[k]) continue
    if (k === 'input' && sameJson(ra[k], rb[k])) continue
    return false
  }
  return true
}

/**
 * O que identifica o item além da chave: ferramenta pelo id; o resto por tipo e
 * texto. É como o ao vivo casa com o confirmado, que vem com as flags que o
 * stream não traz (fromEngine, isApiError).
 */
function contentSig(it: ChatItem): string {
  switch (it.kind) {
    case 'tool_call': return `tool_call\0${it.id}`
    case 'local_command': return `local_command\0${it.command}\0${it.args ?? ''}`
    case 'compact_boundary': return 'compact_boundary'
    default: return `${it.kind}\0${it.text}`
  }
}

/**
 * Reaproveita o objeto de `prev` quando a chave casa e o conteúdo é igual. Os
 * itens ao vivo (`l…`) de `prev` casam com os confirmados de `next` por
 * kind+texto, em ordem, e entram em `renamed` (velha → nova), para quem guarda
 * estado por chave (as dobras) acompanhar a troca.
 *
 * Ao vivo sem par: se veio DEPOIS do último que casou e é mensagem do operador,
 * o transcript ainda não a gravou (a mensagem otimista na corrida do 1º init) e
 * ela fica no fim. O resto foi superado pelo confirmado — o motor reescreveu o
 * texto, ou é coisa só da tela, como a saída do `!comando` — e sai, como saía
 * quando o refetch substituía a lista.
 */
export function reconcileByKey(prev: ChatItem[], next: ChatItem[]): { items: ChatItem[]; renamed: Record<string, string> } {
  const byKey = new Map<string, ChatItem>()
  const live: ChatItem[] = []
  for (const it of prev) {
    if (isLive(it)) live.push(it)
    else byKey.set(it.key!, it)
  }
  // Fila por assinatura dos itens ao vivo, em ordem: textos repetidos casam na ordem em que vieram.
  const queues = new Map<string, { idx: number[]; at: number }>()
  live.forEach((it, i) => {
    const sig = contentSig(it)
    const q = queues.get(sig)
    if (q) q.idx.push(i)
    else queues.set(sig, { idx: [i], at: 0 })
  })
  const matched: boolean[] = []
  let lastMatched = -1
  const renamed: Record<string, string> = {}
  const items = next.map((n) => {
    const old = n.key !== undefined ? byKey.get(n.key) : undefined
    if (old) return itemsEqual(old, n) ? old : n
    if (live.length === 0) return n
    const q = queues.get(contentSig(n))
    if (q && q.at < q.idx.length) {
      const i = q.idx[q.at++]
      matched[i] = true
      if (i > lastMatched) lastMatched = i
      const k = live[i].key
      if (k && n.key) renamed[k] = n.key
    }
    return n
  })
  const pending = live.filter((it, i) =>
    i > lastMatched && !matched[i] && it.kind === 'user_text' && !it.fromEngine)
  return { items: pending.length ? [...items, ...pending] : items, renamed }
}

/** Reduz uma página do histórico numa lista só (linear) e separa os resultados sem chamada. */
export function reducePage(events: ClaudeEvent[]): { items: ChatItem[]; orphanResults: OrphanResults } {
  const items: ChatItem[] = []
  const orphanResults: OrphanResults = {}
  const onOrphan = (id: string, result: string, isError: boolean) => { orphanResults[id] = { result, isError } }
  for (const evt of events) applyEventInto(items, evt, onOrphan)
  return { items, orphanResults }
}

/**
 * Preenche as chamadas sem resultado com os órfãos guardados. Consome de
 * `orphans` (mutável) o que usou e só copia os itens que mudam.
 */
function fillOrphans(list: ChatItem[], orphans: OrphanResults): ChatItem[] {
  let out = list
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    if (it.kind !== 'tool_call' || it.result !== undefined) continue
    const found = orphans[it.id]
    if (!found) continue
    if (out === list) out = list.slice()
    out[i] = { ...it, result: found.result, isError: found.isError }
    delete orphans[it.id]
  }
  return out
}

const hasAny = (o: object) => { for (const _ in o) return true; return false }

/**
 * A cauda relida (refetch do fim do turno, reconexão, volta do terminal) sobre o
 * que está na tela. Acha a 1ª chave da página nos itens atuais: o que vem antes
 * (páginas antigas já carregadas) fica como está, e o resto é reconciliado. Sem
 * interseção — o turno passou de uma página inteira, ou a chave é de outra
 * conversa (mesma posição, outro conteúdo) — substitui tudo: `reset`, e o cursor
 * de páginas antigas recomeça daqui, sem buraco.
 */
export function mergeTail(current: ChatItem[], page: HistoryPage, orphans: OrphanResults): {
  items: ChatItem[]; renamed: Record<string, string>; reset: boolean; orphans: OrphanResults
} {
  const { items: fresh, orphanResults } = reducePage(page.events)
  const first = fresh[0]
  const idx = first?.key ? current.findIndex((it) => it.key === first.key) : -1
  if (idx < 0 || contentSig(current[idx]) !== contentSig(first)) {
    return { ...reconcileByKey(current, fresh), reset: true, orphans: orphanResults }
  }
  // Página cortada entre a fronteira de compactação e o resumo: o resumo da tela
  // já absorveu o tamanho de antes, e a releitura não o sabe — herda.
  const atual = current[idx]
  if (first.kind === 'user_text' && first.compactSummary && first.preTokens === undefined
      && atual.kind === 'user_text' && atual.preTokens !== undefined) {
    fresh[0] = { ...first, preTokens: atual.preTokens }
  }
  const freshKeys = new Set(fresh.map((it) => it.key))
  const pending = { ...orphans, ...orphanResults }
  let prefix = current.slice(0, idx)
  if (prefix.some((it) => it.key && freshKeys.has(it.key))) prefix = prefix.filter((it) => !it.key || !freshKeys.has(it.key))
  if (hasAny(pending)) prefix = fillOrphans(prefix, pending)
  const { items, renamed } = reconcileByKey(current.slice(idx), fresh)
  return { items: [...prefix, ...items], renamed, reset: false, orphans: pending }
}

/**
 * Página mais antiga, no topo. Descarta chaves que já estão na tela, preenche
 * as chamadas cujo resultado chegou antes (órfão, numa página mais nova) e
 * guarda os órfãos desta página para a próxima.
 */
export function mergeOlder(current: ChatItem[], page: HistoryPage, orphans: OrphanResults): {
  items: ChatItem[]; orphans: OrphanResults
} {
  const { items: older, orphanResults } = reducePage(page.events)
  const have = new Set<string>()
  for (const it of current) if (it.key) have.add(it.key)
  let top = older.filter((it) => !it.key || !have.has(it.key))
  const pending = { ...orphans }
  if (hasAny(pending)) top = fillOrphans(top, pending)
  Object.assign(pending, orphanResults)
  // Fronteira de compactação no fim da página antiga e o resumo no topo da tela:
  // o resumo absorve o tamanho de antes, como no reduce de uma página só.
  let rest = current
  const last = top[top.length - 1]
  const head = current[0]
  if (last?.kind === 'compact_boundary' && head?.kind === 'user_text' && head.compactSummary && head.preTokens === undefined) {
    top = top.slice(0, -1)
    rest = last.preTokens !== undefined ? [{ ...head, preTokens: last.preTokens }, ...current.slice(1)] : current
  }
  return { items: [...top, ...rest], orphans: pending }
}
