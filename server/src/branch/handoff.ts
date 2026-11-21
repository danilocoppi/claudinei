import type { AgentEvent, Engine } from '../engine/types.js'
import { readPage } from '../history-page.js'
import { COMPACT_PREAMBLE, visibleUserText } from '../history-search.js'

/**
 * Pacote de contexto: a conversa recente em texto, para quem não recebe a
 * conversa copiada pela CLI (o Kimi, a cópia nativa recusada, a troca de
 * motor). Mensagens inteiras, da mais recente para trás, até o orçamento; o
 * cabeçalho em inglês é reconhecido verbatim pela tela (cartão "Contexto
 * trazido do <Motor>").
 */

export const HANDOFF_PREFIX = '[Claudinei: context handoff]'
/** ~16 mil tokens a 4 caracteres por token. Conta o texto todo, cabeçalho incluso. */
export const HANDOFF_BUDGET_CHARS = 64_000
/** Abaixo dos 120 KB por mensagem do Kimi e do OpenCode. Conta o texto todo em UTF-8. */
export const HANDOFF_MAX_BYTES = 100 * 1024
/** Caracteres do resultado de uma ferramenta. */
export const TOOL_RESULT_MAX = 300
/** Caracteres do resumo da chamada de uma ferramenta. */
const TOOL_SUMMARY_MAX = 200
/** Eventos por página lida do histórico. */
const PAGE_ITEMS = 200

export interface HandoffMessage { role: 'operator' | 'agent' | 'summary'; text: string }
export interface Handoff { text: string; messages: number; tokens: number }

const TAG: Record<HandoffMessage['role'], string> = {
  operator: '=== operator ===',
  agent: '=== agent ===',
  summary: '=== earlier summary ===',
}
const BEGINNING_CUT = '(beginning cut off)\n'

function cabecalho(label: string, n: number, tokens: number, ref: string): string {
  return `${HANDOFF_PREFIX}: This conversation continues one held with ${label} in this same folder. `
    + `Below are its ${n} most recent messages, whole, oldest first (about ${tokens} tokens). `
    + `The full conversation is at ${ref}; read it only if you need something older. `
    + 'If no request follows, reply with one short line confirming you have the context.'
}

// ---- texto ----------------------------------------------------------------

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

/** Os primeiros `n` caracteres, com "…" quando corta; nunca parte um par substituto. */
function cortar(s: string, n: number): string {
  if (s.length <= n) return s
  const fim = isHigh(s.charCodeAt(n - 1)) ? n - 1 : n
  return s.slice(0, fim) + '…'
}

const umaLinha = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * O maior fim de `s` com até `maxChars` caracteres e `maxBytes` bytes UTF-8,
 * sem partir um par substituto (um emoji cortado viraria lixo).
 */
function fimQueCabe(s: string, maxChars: number, maxBytes: number): string {
  let i = s.length
  let bytes = 0
  while (i > 0) {
    const c = s.charCodeAt(i - 1)
    let j = i - 1
    let b: number
    if (isLow(c) && i >= 2 && isHigh(s.charCodeAt(i - 2))) { j = i - 2; b = 4 }
    else b = c < 0x80 ? 1 : c < 0x800 ? 2 : 3 // substituto solto sai como U+FFFD: 3 bytes
    if (s.length - j > maxChars || bytes + b > maxBytes) break
    bytes += b
    i = j
  }
  return s.slice(i)
}

// ---- eventos → mensagens ----------------------------------------------------

/**
 * Peça intermediária: um evento vira peças leves (o texto já cortado), e as
 * peças viram mensagens. O `collectHandoff` guarda só as peças entre as
 * páginas, nunca os eventos com o `raw` inteiro.
 */
type Piece = {
  /**
   * `line`: uma linha do agente (as seguidas viram uma mensagem). `agent`: uma
   * mensagem inteira do agente, vinda de um pacote recebido. `turn`: marca
   * sem texto do começo de um turno do operador (o pacote recebido sem pedido).
   */
  t: 'operator' | 'summary' | 'line' | 'agent' | 'turn'
  text: string
  /** Veio de dentro de um pacote recebido: não abre turno, e o resumo dele não corta a conversa. */
  embutido?: boolean
}

interface RawFlags {
  isMeta?: unknown; isSynthetic?: unknown; isCompactSummary?: unknown
  parent_tool_use_id?: unknown; isSidechain?: unknown
}
const rawOf = (evt: AgentEvent): RawFlags | undefined =>
  ('raw' in evt ? evt.raw as RawFlags | undefined : undefined) ?? undefined

/** Evento de um subagente: não é a conversa principal. */
const deSubagente = (evt: AgentEvent) => {
  const raw = rawOf(evt)
  return !!raw?.parent_tool_use_id || raw?.isSidechain === true
}

/** Os textos de um evento `user` (conteúdo string ou blocos `text`). */
function textosDoUser(evt: AgentEvent & { kind: 'user' }): string[] {
  const c = evt.message?.content
  if (typeof c === 'string') return c ? [c] : []
  if (!Array.isArray(c)) return []
  return c.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text).map((b) => b.text!)
}

/** Resumo da compactação do CLI: pela flag, ou pelo preâmbulo fixo (raw sem a flag). */
export function isCompactionSummary(evt: AgentEvent): boolean {
  if (evt.kind !== 'user') return false
  if (rawOf(evt)?.isCompactSummary === true) return true
  return textosDoUser(evt).some((t) => COMPACT_PREAMBLE.test(t))
}

/** Texto que a engine injetou do lado do usuário (skill, lembrete, developer do Codex). */
function injetado(evt: AgentEvent & { kind: 'user' }): boolean {
  const raw = rawOf(evt)
  return !!(evt.fromEngine || raw?.isMeta || raw?.isSynthetic)
}

/** Marca que a CLI grava quando o operador interrompe o turno: não é texto dele. */
const INTERRUPCAO = /^\[Request interrupted/

/** O texto do operador neste evento, como a tela mostra; '' se não houver. */
function textoDoOperador(evt: AgentEvent): string {
  if (evt.kind !== 'user' || deSubagente(evt) || isCompactionSummary(evt) || injetado(evt)) return ''
  return textosDoUser(evt).map(visibleUserText).filter((t) => t && !INTERRUPCAO.test(t)).join('\n')
}

const REQUEST_TAG = '=== request ==='
const ROLE_OF_TAG = new Map<string, HandoffMessage['role']>(
  (Object.entries(TAG) as Array<[HandoffMessage['role'], string]>).map(([role, tag]) => [tag, role]),
)

/**
 * Um pacote recebido (texto do operador que começa com `HANDOFF_PREFIX`) vira
 * as mensagens do corpo dele, na ordem, e o `=== request ===`, se houver, vira
 * mensagem do operador. Sem isso, o pacote seguinte o contaria como uma
 * mensagem enorme do operador, que não cabe, e sobraria só a confirmação.
 * O pedido é o que vem depois do ÚLTIMO `=== request ===` (como na web). Fora
 * do formato, null (o texto fica como mensagem do operador).
 */
function desdobrarPacote(texto: string): Piece[] | null {
  if (!texto.startsWith(`${HANDOFF_PREFIX}:`)) return null
  const ini = texto.indexOf('\n\n')
  if (ini < 0) return null
  let corpo = texto.slice(ini + 2)
  let pedido: string | null = null
  const sep = corpo.lastIndexOf(`\n\n${REQUEST_TAG}`)
  const fimDaTag = sep + 2 + REQUEST_TAG.length
  if (sep >= 0 && (fimDaTag === corpo.length || corpo[fimDaTag] === '\n')) {
    pedido = corpo.slice(fimDaTag + 1).trim()
    corpo = corpo.slice(0, sep)
  }
  // Um bloco começa numa linha que é só a tag, no início do corpo ou depois de
  // uma linha em branco (o separador entre blocos).
  const linhas = corpo.split('\n')
  const blocos: Array<{ role: HandoffMessage['role']; linhas: string[] }> = []
  for (let i = 0; i < linhas.length; i++) {
    const role = ROLE_OF_TAG.get(linhas[i])
    if (role && (i === 0 || linhas[i - 1] === '')) {
      const anterior = blocos.at(-1)
      if (anterior && anterior.linhas.at(-1) === '') anterior.linhas.pop()
      blocos.push({ role, linhas: [] })
      continue
    }
    if (!blocos.length) return null
    blocos.at(-1)!.linhas.push(linhas[i])
  }
  if (!blocos.length) return null
  const out: Piece[] = blocos.map((b) => ({ t: b.role, text: b.linhas.join('\n'), embutido: true }))
  out.push(pedido ? { t: 'operator', text: pedido } : { t: 'turn', text: '' })
  return out
}

/** As peças do texto do operador: o pacote recebido desdobrado, ou o texto. */
const pecasDoOperador = (texto: string): Piece[] => desdobrarPacote(texto) ?? [{ t: 'operator', text: texto }]

/** Peça que abre um turno do operador (as de dentro de um pacote recebido não abrem). */
const abreTurno = (p: Piece) => p.t === 'turn' || (p.t === 'operator' && !p.embutido)

/** O resumo da compactação desta conversa (o de dentro de um pacote recebido não conta). */
const cortaNoResumo = (p: Piece) => p.t === 'summary' && !p.embutido

/** Saída da ferramenta como texto (mesma regra da tela). */
function saidaDaFerramenta(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b: { text?: string }) => b?.text ?? '').join('\n')
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

/** `→ <nome>: <resumo>`: o primeiro campo conhecido do input, senão o JSON dele. */
function linhaDaFerramenta(name: string | undefined, input: unknown): string {
  const obj = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const campo = ['command', 'file_path', 'path', 'pattern', 'description']
    .map((k) => obj[k])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const resumo = campo ?? JSON.stringify(input ?? {}) ?? ''
  return `→ ${name || 'tool'}: ${cortar(umaLinha(resumo), TOOL_SUMMARY_MAX)}`
}

function piecesOf(events: AgentEvent[]): Piece[] {
  const out: Piece[] = []
  for (const evt of events) {
    if ((evt.kind !== 'assistant' && evt.kind !== 'user') || deSubagente(evt)) continue
    if (evt.kind === 'assistant') {
      const c = evt.message?.content
      if (typeof c === 'string') { if (c.trim()) out.push({ t: 'line', text: c }); continue }
      for (const b of Array.isArray(c) ? c : []) {
        // O thinking fica de fora.
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ t: 'line', text: b.text })
        else if (b?.type === 'tool_use') out.push({ t: 'line', text: linhaDaFerramenta(b.name, b.input) })
      }
      continue
    }
    if (isCompactionSummary(evt)) {
      const text = textosDoUser(evt).join('\n')
      if (text) out.push({ t: 'summary', text })
      continue
    }
    const c = evt.message?.content
    for (const b of Array.isArray(c) ? c : []) {
      if (b?.type !== 'tool_result') continue
      const saida = umaLinha(saidaDaFerramenta(b.content))
      if (saida) out.push({ t: 'line', text: `  ← ${cortar(saida, TOOL_RESULT_MAX)}` })
    }
    const texto = textoDoOperador(evt)
    if (texto) out.push(...pecasDoOperador(texto))
  }
  return out
}

/** Peças → mensagens, a partir do resumo da compactação mais recente. */
function assemble(pieces: Piece[]): HandoffMessage[] {
  let ini = 0
  for (let i = pieces.length - 1; i >= 0; i--) if (cortaNoResumo(pieces[i])) { ini = i; break }
  const out: HandoffMessage[] = []
  let agente: string[] | null = null
  const fecha = () => { if (agente) out.push({ role: 'agent', text: agente.join('\n') }); agente = null }
  for (let i = ini; i < pieces.length; i++) {
    const p = pieces[i]
    if (p.t === 'line') { (agente ??= []).push(p.text); continue }
    fecha()
    if (p.t === 'turn') continue
    out.push({ role: p.t, text: p.text })
  }
  fecha()
  return out
}

/** Eventos (mais antigo → mais recente) viram mensagens; para no resumo da compactação mais recente. */
export function messagesOf(events: AgentEvent[]): HandoffMessage[] {
  return assemble(piecesOf(events))
}

/**
 * Tira o turno em andamento: do último evento `user` de texto do operador em
 * diante. Sem nenhum, tudo é o turno em andamento.
 */
export function dropOpenTurn(events: AgentEvent[]): AgentEvent[] {
  for (let i = events.length - 1; i >= 0; i--) if (textoDoOperador(events[i])) return events.slice(0, i)
  return []
}

// ---- mensagens → pacote ------------------------------------------------------

const bloco = (m: HandoffMessage) => `${TAG[m.role]}\n${m.text}`

/** O pacote e se todas as mensagens couberam inteiras. */
function montar(messages: HandoffMessage[], meta: { label: string; ref: string }): { handoff: Handoff; inteiras: boolean } | null {
  if (messages.length === 0) return null
  const blocos: string[] = [] // da mais recente para a mais antiga
  let chars = 0
  let bytes = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const b = bloco(messages[i])
    const sep = blocos.length ? 2 : 0
    const c = chars + sep + b.length
    const by = bytes + sep + Buffer.byteLength(b, 'utf8')
    const head = cabecalho(meta.label, blocos.length + 1, Math.ceil(c / 4), meta.ref)
    if (head.length + 2 + c > HANDOFF_BUDGET_CHARS || Buffer.byteLength(head, 'utf8') + 2 + by > HANDOFF_MAX_BYTES) break
    blocos.push(b)
    chars = c
    bytes = by
  }
  if (blocos.length > 0) {
    const corpo = blocos.reverse().join('\n\n')
    const tokens = Math.ceil(corpo.length / 4)
    const text = `${cabecalho(meta.label, blocos.length, tokens, meta.ref)}\n\n${corpo}`
    return { handoff: { text, messages: blocos.length, tokens }, inteiras: blocos.length === messages.length }
  }
  // A mais recente sozinha não cabe: entra o fim dela. O cabeçalho é medido com
  // o maior T possível; o real tem no máximo os mesmos dígitos, então cabe.
  const m = messages[messages.length - 1]
  const prefixo = `${TAG[m.role]}\n${BEGINNING_CUT}`
  const headMax = cabecalho(meta.label, 1, Math.ceil(HANDOFF_BUDGET_CHARS / 4), meta.ref)
  const sobraC = HANDOFF_BUDGET_CHARS - headMax.length - 2 - prefixo.length
  const sobraB = HANDOFF_MAX_BYTES - Buffer.byteLength(headMax, 'utf8') - 2 - Buffer.byteLength(prefixo, 'utf8')
  const corpo = prefixo + fimQueCabe(m.text, Math.max(0, sobraC), Math.max(0, sobraB))
  const tokens = Math.ceil(corpo.length / 4)
  return { handoff: { text: `${cabecalho(meta.label, 1, tokens, meta.ref)}\n\n${corpo}`, messages: 1, tokens }, inteiras: false }
}

/**
 * Da mais recente para a mais antiga, mensagens inteiras enquanto o texto todo
 * couber em `HANDOFF_BUDGET_CHARS` e em `HANDOFF_MAX_BYTES`. A mais recente
 * sozinha grande demais entra cortada no início. Sem mensagens, `null`.
 */
export function buildHandoff(messages: HandoffMessage[], meta: { label: string; ref: string }): Handoff | null {
  return montar(messages, meta)?.handoff ?? null
}

/** O pacote com o pedido do operador junto. Aceita também o texto pronto (o `seed` do OpenCode). */
export function withRequest(handoff: Handoff | string, request: string): string {
  const text = typeof handoff === 'string' ? handoff : handoff.text
  return `${text}\n\n=== request ===\n${request}`
}

/**
 * Monta o pacote lendo o histórico de trás para a frente a partir de `before`
 * (ausente = o fim). Com `working`, tira o turno em andamento. Para quando o
 * orçamento enche, no começo da conversa ou no resumo da compactação.
 */
export async function collectHandoff(engine: Engine, projectPath: string, id: string,
  opts: { working: boolean; before?: number }): Promise<Handoff | null> {
  const meta = {
    label: engine.capabilities().label,
    ref: engine.transcriptRef?.(projectPath, id) ?? `${engine.id} conversation ${id}`,
  }
  let pieces: Piece[] = []
  let aberto = opts.working
  let before = opts.before
  for (;;) {
    const page = await readPage(engine, projectPath, id, { before, minItems: PAGE_ITEMS })
    let novas = piecesOf(page.events)
    if (aberto) {
      // Tudo depois do último texto do operador é do turno em andamento; se a
      // página não tem nenhum, ela inteira é do turno e a leitura continua.
      let i = novas.length - 1
      while (i >= 0 && !abreTurno(novas[i])) i--
      if (i >= 0) { novas = novas.slice(0, i); aberto = false } else novas = []
    }
    pieces = novas.concat(pieces)
    const msgs = assemble(pieces)
    // Sem progresso (página que não recua) também encerra: nunca fica em laço.
    const semProgresso = before !== undefined && page.start >= before
    if (page.atStart || semProgresso || pieces.some(cortaNoResumo)) return buildHandoff(msgs, meta)
    if (!aberto) {
      // A mais antiga pode continuar na página anterior (agente entre páginas):
      // só vale encerrar se as outras já não cabem inteiras — aí ela ficaria de
      // fora de qualquer jeito, e o pacote é o mesmo.
      const resto = msgs.slice(1)
      const r = montar(resto, meta)
      if (r && !r.inteiras) return r.handoff
    }
    before = page.start
  }
}
