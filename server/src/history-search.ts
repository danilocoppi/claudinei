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

/*
 * Como a busca acha sem pesar no laço de eventos.
 *
 * O texto é dobrado em pedaços de DOBRA_CHARS com o próprio normalizeForSearch
 * (NFD, sem marcas, minúsculo, sigma final igual ao medial) e a consulta é
 * procurada com `indexOf`, que é linear no V8 até nos quase-acertos. Um padrão
 * que pulasse as marcas entre as letras custava O(texto × consulta): segundos
 * numa fatia de 8 MB com "ç"×199+"x". Tirar as marcas custa ~90 ms em 8 MB.
 *
 * Dobrar por pedaço dá o mesmo que dobrar o texto inteiro: o NFD decompõe
 * caractere a caractere (só reordena marcas, que saem), e o `toLowerCase` só
 * olha o contexto no sigma final, que vira o medial. Por isso cada caractere
 * do original vira, no dobrado, exatamente `normalizeForSearch(caractere)` —
 * uma marca solta vira nada. Guardando onde cada pedaço começa no original e
 * no dobrado, levar uma ocorrência de volta ao original só percorre o pedaço
 * dela, caractere a caractere.
 */
const DOBRA_CHARS = 1024
const NAO_ASCII = /[^\x00-\x7f]/
const MARCA = /\p{M}/u

interface Dobrado {
  /** O texto como normalizeForSearch o deixa. */
  h: string
  /** Começo de cada pedaço no original e no dobrado; null = texto ASCII, índices iguais. */
  oInicio: number[] | null
  hInicio: number[] | null
}

function dobrar(text: string): Dobrado {
  // ASCII não tem acento: só a caixa muda, sem mudar o tamanho.
  if (!NAO_ASCII.test(text)) return { h: text.toLowerCase(), oInicio: null, hInicio: null }
  const partes: string[] = []
  const oInicio: number[] = []
  const hInicio: number[] = []
  let h = 0
  for (let i = 0; i < text.length;) {
    let j = Math.min(text.length, i + DOBRA_CHARS)
    if (j < text.length && isLowSurrogate(text.charCodeAt(j))) j++
    const p = normalizeForSearch(text.slice(i, j))
    partes.push(p); oInicio.push(i); hInicio.push(h)
    h += p.length; i = j
  }
  return { h: partes.join(''), oInicio, hInicio }
}

/** Quantas unidades um caractere vira no dobrado. Memória pequena: CJK e afins repetem muito. */
const tamanhoDobra = new Map<string, number>()
function tamanhoDobrado(ch: string): number {
  let n = tamanhoDobra.get(ch)
  if (n === undefined) {
    n = normalizeForSearch(ch).length
    if (tamanhoDobra.size < 4096) tamanhoDobra.set(ch, n)
  }
  return n
}

/**
 * Leva índices do dobrado ao original: para cada índice, o `[início, fim)` do
 * caractere que o gerou. Chamado em ordem crescente; anda só dentro do pedaço
 * de cada alvo. Marca solta não gera nada no dobrado, então nunca é a dona.
 */
function mapeador(text: string, d: Dobrado): (alvo: number) => [number, number] {
  const { oInicio, hInicio } = d
  if (!oInicio || !hInicio) return (alvo) => [alvo, alvo + 1]
  let o = 0
  let hpos = 0
  return (alvo) => {
    // Pedaço do alvo: o último que começa até ele (busca binária).
    let lo = 0, hi = hInicio.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (hInicio[mid] <= alvo) lo = mid
      else hi = mid - 1
    }
    if (o < oInicio[lo] || hpos > alvo) { o = oInicio[lo]; hpos = hInicio[lo] }
    while (o < text.length) {
      const c = text.charCodeAt(o)
      const w = c >= 0xd800 && c <= 0xdbff && o + 1 < text.length ? 2 : 1
      const n = c < 0x80 ? 1 : tamanhoDobrado(text.slice(o, o + w))
      if (alvo < hpos + n) return [o, o + w]
      hpos += n; o += w
    }
    return [text.length, text.length]
  }
}

/**
 * Trecho de até SNIPPET_CHARS em volta de `[ini, fim)`, sem partir um par
 * substituto nem separar uma letra das marcas que vêm depois dela.
 */
function snippetAround(s: string, ini: number, fim: number): string {
  const sobra = Math.max(0, SNIPPET_CHARS - (fim - ini))
  let a = Math.max(0, ini - Math.floor(sobra / 2))
  let b = Math.min(s.length, a + SNIPPET_CHARS)
  a = Math.max(0, Math.min(a, b - SNIPPET_CHARS))
  // Unidade que não pode abrir nem fechar o trecho: marca (pertence à letra de
  // antes) ou a metade baixa de um par substituto.
  const presa = (i: number) =>
    i < s.length && (isLowSurrogate(s.charCodeAt(i)) || MARCA.test(String.fromCodePoint(s.codePointAt(i)!)))
  // Começo: a letra das marcas ficou de fora, então elas também saem.
  while (a < ini && presa(a)) a++
  // Fim: a primeira unidade de fora está presa à última de dentro — recua até
  // a letra dona dela e a deixa de fora; se isso cortaria a ocorrência, avança.
  if (presa(b)) {
    let c = b
    while (c > fim && presa(c)) c--
    if (presa(c)) while (presa(b)) b++
    else b = c
  }
  return s.slice(a, b).replace(/\s+/g, ' ').trim()
}
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

/** Ocorrências `[início, fim)` no dobrado, só as últimas `max` (as de baixo). */
function ultimasOcorrencias(d: Dobrado, agulha: string, agulhaAscii: boolean, max: number): Array<[number, number]> {
  // Texto ASCII não tem como casar consulta com letra acentuada.
  if (!d.oInicio && !agulhaAscii) return []
  let achados: Array<[number, number]> = []
  for (let at = d.h.indexOf(agulha); at !== -1; at = d.h.indexOf(agulha, at + agulha.length)) {
    achados.push([at, at + agulha.length])
    // Só as de baixo interessam: não acumula além do necessário.
    if (achados.length > 4 * max + 64) achados = achados.slice(-max)
  }
  return achados.length > max ? achados.slice(-max) : achados
}

/**
 * As ocorrências de `q` nos eventos, da mais nova para a mais antiga: `pos`
 * decrescente e, dentro de um evento, de baixo para cima. Uma por ocorrência,
 * sem sobreposição. Para no `limit` (as mais novas ficam).
 */
export function searchEvents(events: PositionedEvent[], q: string, tools: boolean, limit = Infinity): SearchHit[] {
  const agulha = normalizeForSearch(q.trim())
  if (!agulha || limit <= 0) return []
  const agulhaAscii = !NAO_ASCII.test(agulha)
  // Os eventos vêm na ordem do arquivo; a ordenação estável garante o pos
  // decrescente mesmo se não vierem.
  const ordem = events.map((e, i) => ({ e, i })).sort((x, y) => y.e.pos - x.e.pos || y.i - x.i)
  const hits: SearchHit[] = []
  for (const { e } of ordem) {
    const textos = searchableTexts(e, tools)
    for (let t = textos.length - 1; t >= 0; t--) {
      const { field, text, toolUseId } = textos[t]
      const d = dobrar(text)
      const achados = ultimasOcorrencias(d, agulha, agulhaAscii, limit - hits.length)
      if (!achados.length) continue
      // Em ordem crescente (o mapeador só anda para a frente), depois invertidos.
      const mapa = mapeador(text, d)
      const trechos = achados.map(([hIni, hFim]) => {
        const ini = mapa(hIni)[0]
        const fim = mapa(hFim - 1)[1]
        return snippetAround(text, ini, fim)
      })
      for (let k = trechos.length - 1; k >= 0; k--) {
        hits.push({ pos: e.pos, ...(toolUseId ? { toolUseId } : {}), field, snippet: trechos[k] })
      }
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
