// Parser do `kimi -p --output-format stream-json`. O stream é uma mensagem
// COMPLETA por linha, no shape de chat da OpenAI (verificado por spike):
//   {"role":"assistant","content":"texto"}
//   {"role":"assistant","tool_calls":[{"id","function":{"name","arguments"}}]}
//   {"role":"tool","tool_call_id":"...","content":"..."}
//   {"role":"meta","type":"session.resume_hint","session_id":"session_..."}
// Não há deltas de texto nem usage — daí não emitirmos partials nem tokens
// (mesma situação do Claude, que também não expõe tokens por turno aqui).
import type { AgentEvent } from '../types.js'
import type { ApiMessage, ContentBlock } from '../../claude/events.js'

const assistant = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content } as ApiMessage, raw })
const user = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content } as ApiMessage, raw })

/** `arguments` vem como STRING JSON (formato OpenAI); objeto também é aceito. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : { value: o }
  } catch {
    return { raw }
  }
}

export function classifyKimiLine(line: string, model?: string): AgentEvent[] {
  const s = line.trim()
  if (!s) return []
  let o: any
  try { o = JSON.parse(s) } catch { return [{ kind: 'parse_error', line: s }] }

  if (o.role === 'meta') {
    // O id da conversa só chega no FIM do turno (a CLI não o anuncia no início,
    // ao contrário do Codex): emitimos init assim mesmo para o manager
    // persistir/broadcastar o engineSessionId e o próximo turno retomar com -r.
    if (o.type === 'session.resume_hint' && o.session_id) {
      return [{ kind: 'init', sessionId: String(o.session_id), model: model ?? '', slashCommands: [], raw: o }]
    }
    return []
  }

  if (o.role === 'assistant') {
    const out: AgentEvent[] = []
    if (typeof o.content === 'string' && o.content) out.push(assistant([{ type: 'text', text: o.content }], o))
    for (const call of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
      out.push(assistant([{
        type: 'tool_use',
        id: call?.id ?? '',
        name: call?.function?.name ?? call?.name ?? 'tool',
        input: parseToolArgs(call?.function?.arguments),
      }], o))
    }
    return out
  }

  if (o.role === 'tool') {
    return [user([{
      type: 'tool_result',
      tool_use_id: o.tool_call_id ?? '',
      content: typeof o.content === 'string' ? o.content : JSON.stringify(o.content ?? ''),
      is_error: !!o.is_error,
    }], o)]
  }

  if (o.role === 'user' && typeof o.content === 'string') return [user([{ type: 'text', text: o.content }], o)]

  return [{ kind: 'raw', raw: o }]
}

export function createKimiTurnParser(onEvent: (e: AgentEvent) => void, model?: string) {
  let buf = ''
  let lastText = ''
  return {
    feed(chunk: Buffer | string): void {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        for (const e of classifyKimiLine(line, model)) {
          if (e.kind === 'assistant') {
            const content = Array.isArray(e.message.content) ? e.message.content : []
            const text = content.find((b) => b.type === 'text' && typeof b.text === 'string')
            if (text) lastText = text.text as string
          }
          onEvent(e)
        }
      }
    },
    /** Texto da última mensagem do assistente — vira o resultText do turno. */
    lastText: () => lastText,
  }
}
