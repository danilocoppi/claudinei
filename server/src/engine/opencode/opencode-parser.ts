import type { AgentEvent } from '../types.js'
import type { ApiMessage, ContentBlock } from '../../claude/events.js'

const assistant = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content } as ApiMessage, raw })
const user = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content } as ApiMessage, raw })

/** Um evento (linha) do `opencode run --format json` → 0..2 AgentEvents de chat. */
export function classifyOpenCodeLine(line: string): AgentEvent[] {
  const s = line.trim()
  if (!s) return []
  let o: any
  try { o = JSON.parse(s) } catch { return [{ kind: 'parse_error', line: s }] }
  switch (o.type) {
    case 'text':
      return typeof o.part?.text === 'string' ? [assistant([{ type: 'text', text: o.part.text }], o)] : []
    case 'reasoning':
      return o.part?.text ? [assistant([{ type: 'thinking', thinking: String(o.part.text) }], o)] : []
    case 'tool_use': {
      const p = o.part ?? {}
      const st = p.state ?? {}
      return [
        assistant([{ type: 'tool_use', id: p.callID, name: p.tool, input: st.input ?? {} }], o),
        user([{ type: 'tool_result', tool_use_id: p.callID, content: st.output ?? '', is_error: (st.metadata?.exit ?? 0) !== 0 || st.status === 'error' }], o),
      ]
    }
    case 'step_start':
    case 'step_finish':
    case 'error':
      return []  // tratados pelo turn parser (tokens/sessionId/erro), não viram chat
    default:
      return [{ kind: 'raw', raw: o }]
  }
}

interface Tokens { input: number; cachedInput: number; output: number; reasoning: number; total: number }

/** Stateful por turno: emite init (1º sessionID) + eventos de chat; acumula texto/tokens/erro; finish() = o result do turno. */
export function createOpenCodeTurnParser(onEvent: (e: AgentEvent) => void, model?: string) {
  let buf = ''
  let sessionId: string | undefined
  let lastText = ''
  let tokens: Tokens | undefined
  let errorMsg: string | undefined

  const handleLine = (line: string): void => {
    const s = line.trim()
    if (!s) return
    let o: any
    try { o = JSON.parse(s) } catch { onEvent({ kind: 'parse_error', line: s }); return }
    // 1º sessionID → init
    if (!sessionId && typeof o.sessionID === 'string') {
      const sid: string = o.sessionID
      sessionId = sid
      onEvent({ kind: 'init', sessionId: sid, model: model ?? '', slashCommands: [], raw: o })
    }
    // step_finish carrega os tokens em part.tokens (não no topo do evento).
    const stepTokens = o.type === 'step_finish' ? (o.part?.tokens ?? o.tokens) : undefined
    if (stepTokens) {
      tokens = {
        input: stepTokens.input ?? 0,
        cachedInput: stepTokens.cache?.read ?? 0,
        output: stepTokens.output ?? 0,
        reasoning: stepTokens.reasoning ?? 0,
        total: stepTokens.total ?? 0,
      }
    }
    if (o.type === 'error') { errorMsg = o.error?.data?.message ?? o.error?.message ?? 'opencode error' }
    if (o.type === 'text' && typeof o.part?.text === 'string') lastText = o.part.text
    for (const e of classifyOpenCodeLine(line)) onEvent(e)
  }

  return {
    feed(chunk: Buffer | string): void {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    },
    /** Chamado no close do processo (fim do turno). */
    finish(): AgentEvent {
      if (buf.trim()) { handleLine(buf); buf = '' }
      return errorMsg
        ? { kind: 'result', subtype: 'error', isError: true, resultText: errorMsg, costUsd: 0, tokens, raw: {} }
        : { kind: 'result', subtype: 'success', isError: false, resultText: lastText, costUsd: 0, tokens, raw: {} }
    },
  }
}
