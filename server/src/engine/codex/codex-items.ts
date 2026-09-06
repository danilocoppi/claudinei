import type { AgentEvent } from '../types.js'

/** Itens finais do App Server → o mesmo contrato de chat das demais engines. */
export function codexItemEvents(item: any, raw: unknown): AgentEvent[] {
  const assistant = (content: any[]): AgentEvent => ({ kind: 'assistant', message: { role: 'assistant', content }, raw })
  const tool = (name: string, input: unknown, output?: unknown, failed = false): AgentEvent[] => [
    assistant([{ type: 'tool_use', id: item.id, name, input }]),
    ...(output === undefined ? [] : [{ kind: 'user' as const, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: item.id, content: typeof output === 'string' ? output : JSON.stringify(output), is_error: failed },
    ] }, raw }]),
  ]
  switch (item?.type) {
    case 'agentMessage': return typeof item.text === 'string' ? [assistant([{ type: 'text', text: item.text }])] : []
    case 'reasoning': {
      const text = Array.isArray(item.summary) ? item.summary.join('\n') : ''
      return text ? [assistant([{ type: 'thinking', thinking: text }])] : []
    }
    case 'commandExecution': return tool('shell', { command: item.command }, item.aggregatedOutput ?? '', item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0))
    case 'fileChange': return tool('file_change', item)
    case 'mcpToolCall': return tool(`${item.server}/${item.tool}`, item.arguments, item.error ?? item.result, !!item.error)
    case 'webSearch': return tool('web_search', item)
    case 'collabAgentToolCall': return tool(item.tool ?? 'Agent', item)
    default: return []
  }
}

export type CodexUsage = { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }
export const tokenNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** `total` é cumulativo da thread; `last` mede a última chamada, que alimenta o contexto. */
export function usageTotals(value: any): CodexUsage | undefined {
  if (!value || !tokenNumber(value.totalTokens) || !tokenNumber(value.inputTokens) || !tokenNumber(value.outputTokens)) return
  return {
    totalTokens: value.totalTokens, inputTokens: value.inputTokens,
    cachedInputTokens: tokenNumber(value.cachedInputTokens) ? value.cachedInputTokens : 0,
    outputTokens: value.outputTokens,
    reasoningOutputTokens: tokenNumber(value.reasoningOutputTokens) ? value.reasoningOutputTokens : 0,
  }
}
