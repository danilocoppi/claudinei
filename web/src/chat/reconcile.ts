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

/** Posição da chave confirmada (`p<pos>` ou `p<pos>.n`); undefined para ao vivo. */
export function keyPos(key: string | undefined): number | undefined {
  if (!key || key[0] !== 'p') return undefined
  const dot = key.indexOf('.')
  return Number(dot < 0 ? key.slice(1) : key.slice(1, dot))
}

/** Maior posição confirmada na tela (-1 se nenhuma). */
export function lastConfirmedPos(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const p = keyPos(items[i].key)
    if (p !== undefined) return p
  }
  return -1
}

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
 * Ao vivo sem par no transcript que FICA na tela. A mensagem do operador (o
 * transcript ainda não a gravou, ou o motor a perdeu) e o que o transcript nunca
 * guarda: aviso de erro (`message_error`, falha de envio do WebSocket, "Mensagem
 * pendente…" com o texto que se perdeu) e o `!comando` com a saída dele. O resto
 * (texto do agente, raciocínio, ferramentas, injeções da engine) tem par no
 * transcript; sem par, foi reescrito — ou o leitor não o guarda, como as
 * ferramentas no rollout do Codex — e sai, como saía quando o refetch
 * substituía a lista.
 */
function keepsUnmatched(it: ChatItem): boolean {
  return (it.kind === 'user_text' && !it.fromEngine) || it.kind === 'command_output' || it.kind === 'local_command'
}

/**
 * Reaproveita o objeto de `prev` quando a chave casa e o conteúdo é igual. Os
 * itens ao vivo (`l…`) de `prev` casam com os confirmados de `next` por
 * kind+texto, em ordem, e entram em `renamed` (velha → nova), para quem guarda
 * estado por chave (as dobras) acompanhar a troca.
 *
 * O ao vivo sem par que fica (`keepsUnmatched`) volta ancorado logo depois do
 * item que o precedia e sobreviveu; sem âncora (a lista inteira mudou), vai
 * para o fim, que é onde a mensagem otimista estava.
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
  // Chave confirmada de cada item ao vivo que casou ('' = casou com item sem chave).
  const matchedTo: (string | undefined)[] = []
  const renamed: Record<string, string> = {}
  const items = next.map((n) => {
    const old = n.key !== undefined ? byKey.get(n.key) : undefined
    if (old) return itemsEqual(old, n) ? old : n
    if (live.length === 0) return n
    const q = queues.get(contentSig(n))
    if (q && q.at < q.idx.length) {
      const i = q.idx[q.at++]
      matchedTo[i] = n.key ?? ''
      const k = live[i].key
      if (k && n.key) renamed[k] = n.key
    }
    return n
  })
  if (live.length === 0) return { items, renamed }

  // Âncora: o último item de `prev` antes do ao vivo que continua na lista nova.
  const inNext = new Set<string>()
  for (const it of items) if (it.key) inNext.add(it.key)
  const after = new Map<string, ChatItem[]>()
  const loose: ChatItem[] = []
  let anchor: string | undefined
  let li = 0
  for (const it of prev) {
    if (!isLive(it)) {
      if (inNext.has(it.key!)) anchor = it.key
      continue
    }
    const i = li++
    const to = matchedTo[i]
    if (to !== undefined) { if (to) anchor = to; continue }
    if (!keepsUnmatched(it)) continue
    if (anchor === undefined) loose.push(it)
    else {
      const bucket = after.get(anchor)
      if (bucket) bucket.push(it)
      else after.set(anchor, [it])
    }
  }
  if (after.size === 0 && loose.length === 0) return { items, renamed }
  const out: ChatItem[] = []
  for (const it of items) {
    out.push(it)
    const extra = it.key !== undefined ? after.get(it.key) : undefined
    if (extra) out.push(...extra)
  }
  out.push(...loose)
  return { items: out, renamed }
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
 * (páginas antigas já carregadas) fica como está, e o resto é reconciliado.
 *
 * Sem interseção — a conversa mudou (`changed`), a chave é de outro arquivo
 * (mesma posição, outro conteúdo), ou o turno passou do que `loadHistoryTail`
 * aceita buscar para trás — substitui: `reset`, e o cursor de páginas antigas
 * recomeça daqui, sem buraco.
 *
 * Página sem nenhum item na MESMA conversa não apaga nada (`unchanged`): a rota
 * devolve vazio quando não acha a conversa (id fantasma, rollout que sumiu), e
 * isso não prova que a conversa na tela deixou de existir.
 */
export function mergeTail(current: ChatItem[], page: HistoryPage, orphans: OrphanResults, changed = false): {
  items: ChatItem[]; renamed: Record<string, string>; reset: boolean; orphans: OrphanResults; unchanged?: boolean
} {
  const { items: fresh, orphanResults } = reducePage(page.events)
  if (fresh.length === 0 && !changed) return { items: current, renamed: {}, reset: false, orphans, unchanged: true }
  const first = fresh[0]
  const idx = !changed && first?.key ? current.findIndex((it) => it.key === first.key) : -1
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
  // Só o que vem ANTES do 1º item confirmado da tela: o topo continua em ordem
  // e nenhuma chave se repete, mesmo com uma página que se sobreponha.
  let firstPos = Infinity
  for (const it of current) {
    const p = keyPos(it.key)
    if (p !== undefined) { firstPos = p; break }
  }
  let top = older.filter((it) => { const p = keyPos(it.key); return p === undefined || p < firstPos })
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
