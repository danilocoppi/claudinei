import type { ChatItem, SearchField, SearchHit } from '../types'
import type { ChatNode } from './grouping'
import { COLLAPSE_LINES, foldId } from './folds'
import { keyPos } from './reconcile'
import { formatEngineMessage } from './engineMessage'

/**
 * Busca na conversa (Ctrl+F), a parte pura: achar o item de uma ocorrência que
 * o servidor devolveu, decidir quais dobras abrir para ela aparecer e recortar
 * o termo num texto para o destaque.
 */

/** Teto de ocorrências de uma busca ("500+ — refine a busca"); o servidor manda uma além dele. */
export const FIND_HIT_LIMIT = 500
/** Bytes que o servidor lê por pedido (uma fatia). */
export const FIND_SLICE_BYTES = 8 * 1024 * 1024
/** Bytes de uma rodada: passou disso sem chegar ao começo, a barra oferece "buscar mais para trás". */
export const FIND_ROUND_BYTES = 64 * 1024 * 1024

const isToolField = (field: SearchField) => field === 'tool_input' || field === 'tool_output'

/**
 * Chave do item onde a ocorrência está, ou null se ele não está carregado.
 *
 * Entrada e saída de ferramenta: o cartão é o `tool_call` com o id do tool_use
 * (a saída vem num evento posterior ao da chamada, e mora no cartão dela). O
 * resto: os itens do evento — chave `p<pos>` ou `p<pos>.n` —, preferindo o do
 * tipo do campo (um evento pode ter raciocínio, texto e ferramentas juntos).
 */
export function locateHit(items: ChatItem[], hit: SearchHit): string | null {
  if (isToolField(hit.field)) {
    if (!hit.toolUseId) return null
    for (const it of items) if (it.kind === 'tool_call' && it.id === hit.toolUseId && it.key) return it.key
    return null
  }
  let first: string | null = null
  for (const it of items) {
    if (!it.key || keyPos(it.key) !== hit.pos) continue
    const thinking = it.kind === 'thinking'
    if (hit.field === 'thinking' ? thinking : !thinking && it.kind !== 'tool_call') return it.key
    first ??= it.key
  }
  return first
}

/** O texto de um item que a busca olha para o campo (null: o item não é desse campo). */
function textForField(item: ChatItem, field: SearchField): string | null {
  if (field === 'thinking') return item.kind === 'thinking' ? item.text : null
  if (field !== 'text') return null
  switch (item.kind) {
    case 'user_text':
    case 'assistant_text':
    case 'task_message':
    case 'scheduled_message':
    case 'claudinei_message': return item.text
    default: return null
  }
}

/**
 * Ocorrência do turno em andamento: o item ainda tem chave ao vivo (`l<n>`),
 * sem posição. Acha pelo trecho que o servidor devolveu (sem caixa, acento nem
 * diferença de espaços) entre os itens ao vivo do tipo do campo, do mais novo
 * para o mais antigo.
 * Entrada e saída de ferramenta já acham pelo id (`locateHit`).
 */
export function locateLiveHit(items: ChatItem[], hit: SearchHit): string | null {
  // O trecho vem com os espaços juntados (`snippetAround` no servidor).
  const comparavel = (s: string) => foldForSearch(s).replace(/\s+/g, ' ')
  const trecho = comparavel(hit.snippet).trim()
  if (!trecho) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (!it.key?.startsWith('l')) continue
    const text = textForField(it, hit.field)
    if (text !== null && comparavel(text).includes(trecho)) return it.key
  }
  return null
}

/** O texto que a bolha conta para recolher (o mesmo de MessageBlock). */
function collapsibleText(item: ChatItem): string | null {
  switch (item.kind) {
    case 'user_text': return item.fromEngine ? formatEngineMessage(item.text) : item.text
    case 'task_message':
    case 'scheduled_message': return item.text
    default: return null
  }
}

/**
 * As dobras (foldIds) a abrir para a ocorrência aparecer: o grupo de ações em
 * que o item está, o cartão da ferramenta, o raciocínio, o "mostrar tudo" de
 * um texto longo recolhido e o resumo da compactação.
 */
export function foldsToOpen(nodes: ChatNode[], items: ChatItem[], itemKey: string, field: SearchField): string[] {
  const out: string[] = []
  const group = nodes.find((n) => n.kind === 'group' && n.items.some((x) => x.item.key === itemKey))
  const groupKey = group?.kind === 'group' ? group.items[0]?.item.key : undefined
  if (groupKey) out.push(foldId(groupKey, 'group'))
  const item = items.find((it) => it.key === itemKey)
  if (!item) return out
  if (item.kind === 'tool_call') {
    if (isToolField(field)) out.push(foldId(itemKey, 'tool'))
  } else if (item.kind === 'thinking') {
    out.push(foldId(itemKey, 'thinking'))
  } else if (item.kind === 'user_text' && item.compactSummary) {
    out.push(foldId(itemKey, 'summary'))
  } else {
    const text = collapsibleText(item)
    if (text !== null && text.split('\n').length > COLLAPSE_LINES) out.push(foldId(itemKey, 'more'))
  }
  return out
}

/**
 * Forma comparável de um trecho, como a do servidor (`normalizeForSearch`):
 * sem acento e sem caixa, com o sigma final igual ao medial.
 */
export function foldForSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
}

const NAO_ASCII = /[^\x00-\x7f]/

/**
 * Onde `q` aparece em `text`, sem distinção de caixa nem de acento, como
 * `[início, fim)` no texto ORIGINAL: o destaque marca o texto como está na
 * tela. As marcas combinantes depois da última letra entram no trecho.
 */
export function matchRanges(text: string, q: string): [number, number][] {
  const needle = foldForSearch(q)
  if (!needle || !text) return []
  let folded: string
  // origem[i] = índice no original do caractere que gerou a unidade i do dobrado.
  let origem: number[] | null = null
  if (!NAO_ASCII.test(text)) folded = text.toLowerCase()
  else {
    const partes: string[] = []
    origem = []
    for (let i = 0; i < text.length;) {
      const w = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
      const f = foldForSearch(text.slice(i, i + w))
      partes.push(f)
      for (let k = 0; k < f.length; k++) origem.push(i)
      i += w
    }
    folded = partes.join('')
  }
  const out: [number, number][] = []
  for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
    const end = at + needle.length
    if (!origem) out.push([at, end])
    else out.push([origem[at], end < origem.length ? origem[end] : text.length])
  }
  return out
}
