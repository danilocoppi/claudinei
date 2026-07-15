import type { AgentEvent } from '../types.js'
import type { ApiMessage, ContentBlock } from '../../claude/events.js'

const assistant = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content } as ApiMessage, raw })
const user = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content } as ApiMessage, raw })

/** Um item.completed do Codex → 0..2 AgentEvents no shape do Claude. */
function classifyItem(item: any, raw: unknown): AgentEvent[] {
  switch (item?.type) {
    case 'agent_message':
      return typeof item.text === 'string' ? [assistant([{ type: 'text', text: item.text }], raw)] : []
    case 'reasoning': {
      const text = item.text ?? item.summary ?? ''
      return text ? [assistant([{ type: 'thinking', thinking: String(text) }], raw)] : []
    }
    case 'command_execution':
      return [
        assistant([{ type: 'tool_use', id: item.id, name: 'shell', input: { command: item.command } }], raw),
        user([{ type: 'tool_result', tool_use_id: item.id, content: item.aggregated_output ?? '', is_error: (item.exit_code ?? 0) !== 0 }], raw),
      ]
    case 'file_change':
    case 'mcp_tool_call':
    case 'web_search':
      // Tool genérica sem tool_result sintético (o payload é o input exibível).
      return [assistant([{ type: 'tool_use', id: item.id, name: item.type, input: item }], raw)]
    default:
      return [{ kind: 'raw', raw }]
  }
}

export function classifyCodexLine(line: string, model?: string): AgentEvent[] {
  const s = line.trim()
  if (!s) return []
  let o: any
  try { o = JSON.parse(s) } catch { return [{ kind: 'parse_error', line: s }] }
  switch (o.type) {
    case 'thread.started':
      return [{ kind: 'init', sessionId: o.thread_id, model: model ?? '', slashCommands: [], raw: o }]
    case 'item.completed':
      return classifyItem(o.item, o)
    case 'turn.completed': {
      const u = o.usage
      let tokens: { input: number; cachedInput: number; output: number; reasoning: number; total: number } | undefined
      if (u) {
        const input = u.input_tokens ?? 0
        const cachedInput = u.cached_input_tokens ?? 0
        const output = u.output_tokens ?? 0
        const reasoning = u.reasoning_output_tokens ?? 0
        tokens = { input, cachedInput, output, reasoning, total: input + output + reasoning }
      }
      return [{ kind: 'result', subtype: 'success', isError: false, resultText: '', costUsd: 0, raw: o, tokens }]
    }
    case 'turn.failed':
      return [{ kind: 'result', subtype: 'error', isError: true, resultText: o.error?.message ?? 'turn failed', costUsd: 0, raw: o }]
    case 'turn.started':
    case 'item.started':
    case 'item.updated':
      return []  // sem efeito no chat (partials ficam para depois)
    default:
      return [{ kind: 'raw', raw: o }]
  }
}

export function createCodexTurnParser(onEvent: (e: AgentEvent) => void, model?: string) {
  let buf = ''
  let lastText = ''
  return (chunk: Buffer | string): void => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      for (const e of classifyCodexLine(line, model)) {
        if (e.kind === 'assistant') {
          const content = Array.isArray(e.message.content) ? e.message.content : []
          const textBlock = content.find((b) => b.type === 'text' && typeof b.text === 'string')
          if (textBlock) lastText = textBlock.text as string
        }
        if (e.kind === 'result' && !e.resultText) e.resultText = lastText
        onEvent(e)
      }
    }
  }
}
