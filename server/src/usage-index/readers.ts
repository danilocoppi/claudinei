import type { UsageRow } from './store.js'

/**
 * Leitores de uma linha dos históricos JSONL do Claude e do Codex.
 * Cada leitor faz um filtro barato por texto antes do `JSON.parse` e devolve só
 * números, modelo, pasta e hora — o texto das mensagens nunca sai daqui.
 */

export interface ClaudeHit { key: string; row: UsageRow }

export interface CodexParser {
  /** Linha de uso de um `token_count` que conta; null para o resto. */
  feed(line: string): UsageRow | null
  /** Estado serializado, guardado em `FileState.parser` junto do offset. */
  state(): string
}

const UNKNOWN_MODEL = 'desconhecido'

/** 'YYYY-MM-DDTHH' em UTC; null quando o horário não é legível. */
export function hourOf(timestamp: string): string | null {
  if (typeof timestamp !== 'string' || !timestamp) return null
  const ms = Date.parse(timestamp)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 13)
}

// Todo número de uma linha de uso precisa ser inteiro finito e não negativo:
// um NaN viraria NULL no SQLite e derrubaria a fatia inteira.
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0
}

function parse(line: string): any {
  try { return JSON.parse(line) } catch { return null }
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** null para linha que não interessa, malformada, de erro de API ou `<synthetic>`. */
export function readClaudeLine(line: string): ClaudeHit | null {
  if (!line.includes('"type":"assistant"')) return null
  const o = parse(line)
  if (!isObject(o) || o.type !== 'assistant' || o.isApiErrorMessage) return null
  const msg = o.message
  if (!isObject(msg) || typeof msg.id !== 'string' || !msg.id || !isObject(msg.usage)) return null
  if (msg.model === '<synthetic>') return null
  const hour = hourOf(o.timestamp)
  if (!hour) return null
  const u = msg.usage
  const key = typeof o.requestId === 'string' && o.requestId ? `${msg.id}:${o.requestId}` : msg.id
  return {
    key,
    row: {
      hour,
      engine: 'claude',
      model: typeof msg.model === 'string' && msg.model ? msg.model : UNKNOWN_MODEL,
      cwd: typeof o.cwd === 'string' ? o.cwd : '',
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cacheRead: count(u.cache_read_input_tokens),
      cacheWrite: count(u.cache_creation_input_tokens),
      reasoning: 0,
    },
  }
}

interface CodexState {
  model: string
  cwd: string
  /** Campos numéricos do último `total_token_usage` contado, em ordem de chave. */
  lastTotal: Record<string, number> | null
}

// Normaliza o total acumulado para comparar só os campos numéricos,
// sem depender da ordem das chaves na linha.
function totalOf(v: unknown): Record<string, number> | null {
  if (!isObject(v)) return null
  const out: Record<string, number> = {}
  for (const k of Object.keys(v).sort()) {
    const n = v[k]
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  return out
}

function sameTotal(a: Record<string, number> | null, b: Record<string, number> | null): boolean {
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => a[k] === b[k])
}

function restore(saved: string | null | undefined): CodexState {
  const fresh: CodexState = { model: UNKNOWN_MODEL, cwd: '', lastTotal: null }
  if (!saved) return fresh
  const o = parse(saved)
  if (!isObject(o)) return fresh
  return {
    model: typeof o.model === 'string' && o.model ? o.model : fresh.model,
    cwd: typeof o.cwd === 'string' ? o.cwd : fresh.cwd,
    lastTotal: totalOf(o.lastTotal),
  }
}

/** `saved` é o `FileState.parser` de uma leitura anterior do mesmo arquivo. */
export function createCodexParser(saved?: string | null): CodexParser {
  const st = restore(saved)
  return {
    feed(line: string): UsageRow | null {
      if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return null
      const o = parse(line)
      if (!isObject(o) || !isObject(o.payload)) return null
      const p = o.payload
      if (o.type === 'turn_context') {
        if (typeof p.model === 'string' && p.model) st.model = p.model
        if (typeof p.cwd === 'string') st.cwd = p.cwd
        return null
      }
      if (o.type !== 'event_msg' || p.type !== 'token_count') return null
      const info = p.info
      if (!isObject(info) || !isObject(info.last_token_usage)) return null
      // O Codex repete o token_count sem pedido novo; o total parado denuncia a repetição.
      const total = totalOf(info.total_token_usage)
      if (sameTotal(total, st.lastTotal)) return null
      const hour = hourOf(o.timestamp)
      if (!hour) return null
      st.lastTotal = total
      const last = info.last_token_usage
      const cached = count(last.cached_input_tokens)
      return {
        hour,
        engine: 'codex',
        model: st.model,
        cwd: st.cwd,
        input: Math.max(0, count(last.input_tokens) - cached),
        output: count(last.output_tokens),
        cacheRead: cached,
        cacheWrite: count(last.cache_write_input_tokens),
        reasoning: count(last.reasoning_output_tokens),
      }
    },
    state(): string {
      return JSON.stringify(st)
    },
  }
}
