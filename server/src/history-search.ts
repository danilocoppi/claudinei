import type { AgentEvent } from './engine/types.js'
import type { PositionedEvent } from './history-page.js'

/**
 * Busca na conversa, sem índice: a rota lê uma fatia do arquivo da engine por
 * pedido e passa os eventos por aqui. Só conta o que a tela mostra — todo achado
 * tem de levar a algo visível. Ferramentas e raciocínio moram dentro dos grupos
 * de ações, então só entram quando o operador pede ("incluir ferramentas").
 */

export type SearchField = 'text' | 'thinking' | 'tool_input' | 'tool_output'
export interface SearchHit { pos: number; toolUseId?: string; field: SearchField; snippet: string }
export interface SearchableText { field: SearchField; text: string; toolUseId?: string }

/** Bytes lidos por pedido de busca: o cliente encadeia os pedidos pelo `before`. */
export const SEARCH_SLICE_BYTES = 8 * 1024 * 1024
/** Teto de ocorrências de uma busca ("500+ — refine a busca"). */
export const SEARCH_HIT_LIMIT = 500
/** Caracteres do trecho em volta da ocorrência. */
const SNIPPET_CHARS = 120

/**
 * Forma comparável: sem acento (NFD e sem as marcas combinantes) e sem caixa.
 * O sigma final vira o medial: o `toLowerCase` escolhe entre os dois pela
 * posição na palavra, e a consulta e o texto têm de casar letra a letra.
 */
export function normalizeForSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')
}

/** Saída de ferramenta como a tela mostra (mesma regra do `blockToText` da web). */
function toolOutputText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b: { text?: string }) => b?.text ?? '').join('\n')
  return content === undefined ? '' : JSON.stringify(content)
}

/** Preâmbulo fixo do resumo da compactação (cópia de `COMPACT_PREAMBLE` em web/src/chat/history.ts). */
const COMPACT_PREAMBLE = /^This session is being continued from a previous conversation/

/**
 * O texto do usuário como a tela mostra (ver `classifyUserText` na web): o
 * aviso de comando local some inteiro, e os lembretes e notificações do
 * harness saem do corpo. Os cartões (tarefa, agendamento, Claudinei) mostram o
 * texto, então ficam.
 */
function visibleUserText(text: string): string {
  if (text.includes('<local-command-caveat>')) return ''
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .trim()
}

/** Os textos pesquisáveis de um evento, na ordem em que aparecem nele. */
export function searchableTexts(evt: AgentEvent, tools: boolean): SearchableText[] {
  const out: SearchableText[] = []
  if (evt.kind === 'assistant') {
    const content = evt.message?.content
    if (typeof content === 'string') {
      if (content) out.push({ field: 'text', text: content })
      return out
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'text' && b.text) out.push({ field: 'text', text: b.text })
      else if (tools && b.type === 'thinking' && b.thinking) out.push({ field: 'thinking', text: b.thinking })
      else if (tools && b.type === 'tool_use' && b.id) {
        out.push({ field: 'tool_input', text: JSON.stringify(b.input ?? {}), toolUseId: b.id })
      }
    }
    return out
  }
  if (evt.kind !== 'user') return out

  const raw = evt.raw as { isMeta?: unknown; isSynthetic?: unknown; isCompactSummary?: unknown } | undefined
  const content = evt.message?.content
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  // Texto que a engine injetou do lado do usuário nunca conta (as mesmas marcas
  // que a web usa para o `fromEngine`) — exceto o resumo da compactação, que a
  // tela mostra.
  const injetado = !!(evt.fromEngine || raw?.isMeta || raw?.isSynthetic)
  for (const b of blocks) {
    if (b.type === 'tool_result' && b.tool_use_id) {
      if (!tools) continue
      const text = toolOutputText(b.content)
      if (text) out.push({ field: 'tool_output', text, toolUseId: b.tool_use_id })
    } else if (b.type === 'text' && b.text) {
      const resumo = raw?.isCompactSummary === true || COMPACT_PREAMBLE.test(b.text)
      if (injetado && !resumo) continue
      const text = visibleUserText(b.text)
      if (text) out.push({ field: 'text', text })
    }
  }
  return out
}

/**
 * O texto normalizado junto com, para cada unidade dele, o índice no original —
 * para recortar o trecho do texto como ele é, com acento e caixa. Normaliza
 * código a código: o resultado é o mesmo do `normalizeForSearch` do texto
 * inteiro (as marcas somem, então a reordenação delas não importa, e o sigma
 * final já foi igualado).
 */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  const partes: string[] = []
  const map: number[] = []
  let i = 0
  for (const ch of s) {
    // ASCII não tem acento: só a caixa muda, e sem mudar o tamanho.
    const n = ch.charCodeAt(0) < 0x80 ? ch.toLowerCase() : normalizeForSearch(ch)
    for (let k = 0; k < n.length; k++) map.push(i)
    partes.push(n)
    i += ch.length
  }
  map.push(s.length)
  return { norm: partes.join(''), map }
}

/** Texto todo ASCII: o normalizado é só o minúsculo, com os mesmos índices. */
const ASCII = /^[\x00-\x7f]*$/

/** Trecho de até SNIPPET_CHARS em volta de `[ini, fim)`, sem partir um par substituto. */
function snippetAround(s: string, ini: number, fim: number): string {
  const sobra = Math.max(0, SNIPPET_CHARS - (fim - ini))
  let a = Math.max(0, ini - Math.floor(sobra / 2))
  let b = Math.min(s.length, a + SNIPPET_CHARS)
  a = Math.max(0, Math.min(a, b - SNIPPET_CHARS))
  if (a > 0 && isLowSurrogate(s.charCodeAt(a))) a++
  if (b < s.length && isLowSurrogate(s.charCodeAt(b))) b--
  return s.slice(a, b).replace(/\s+/g, ' ').trim()
}
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

/**
 * As ocorrências de `q` nos eventos, da mais nova para a mais antiga: `pos`
 * decrescente e, dentro de um evento, de baixo para cima. Uma por ocorrência,
 * sem sobreposição. Para no `limit` (as mais novas ficam).
 */
export function searchEvents(events: PositionedEvent[], q: string, tools: boolean, limit = Infinity): SearchHit[] {
  const agulha = normalizeForSearch(q.trim())
  if (!agulha) return []
  // Os eventos vêm na ordem do arquivo; a ordenação estável garante o pos
  // decrescente mesmo se não vierem.
  const ordem = events.map((e, i) => ({ e, i })).sort((x, y) => y.e.pos - x.e.pos || y.i - x.i)
  const hits: SearchHit[] = []
  for (const { e } of ordem) {
    const textos = searchableTexts(e, tools)
    for (let t = textos.length - 1; t >= 0; t--) {
      const { field, text, toolUseId } = textos[t]
      // Filtro barato antes de montar o mapa de índices: quase todo texto não casa.
      if (!normalizeForSearch(text).includes(agulha)) continue
      const ascii = ASCII.test(text)
      const { norm, map } = ascii ? { norm: text.toLowerCase(), map: null } : normalizeWithMap(text)
      const achados: number[] = []
      for (let at = norm.indexOf(agulha); at !== -1; at = norm.indexOf(agulha, at + agulha.length)) achados.push(at)
      for (let k = achados.length - 1; k >= 0; k--) {
        const ini = map ? map[achados[k]] : achados[k]
        // Fim no original: o começo do código seguinte ao último casado.
        const fim = map ? nextOriginalIndex(map, achados[k] + agulha.length - 1, text.length) : achados[k] + agulha.length
        hits.push({ pos: e.pos, ...(toolUseId ? { toolUseId } : {}), field, snippet: snippetAround(text, ini, fim) })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}

/** Índice no original logo depois do código que gerou a unidade `u` do normalizado. */
function nextOriginalIndex(map: number[], u: number, total: number): number {
  const origem = map[u]
  for (let k = u + 1; k < map.length; k++) if (map[k] !== origem) return map[k]
  return total
}
