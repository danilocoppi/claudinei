import type { ClaudeEvent } from './events.js'

export function classifyLine(line: string): ClaudeEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { kind: 'parse_error', line: trimmed }
  }
  if (obj === null || typeof obj !== 'object') return { kind: 'raw', raw: obj }
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') {
        return { kind: 'init', sessionId: obj.session_id, model: obj.model ?? '', slashCommands: Array.isArray(obj.slash_commands) ? obj.slash_commands : [], raw: obj }
      }
      return { kind: 'system', subtype: obj.subtype ?? 'unknown', raw: obj }
    case 'assistant':
      return { kind: 'assistant', message: obj.message, raw: obj }
    case 'user':
      return { kind: 'user', message: obj.message, raw: obj }
    case 'result':
      return {
        kind: 'result',
        subtype: obj.subtype ?? 'unknown',
        isError: Boolean(obj.is_error),
        resultText: typeof obj.result === 'string' ? obj.result : '',
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
        raw: obj,
      }
    case 'stream_event':
      if (obj.event?.type === 'content_block_delta' && obj.event.delta?.type === 'text_delta') {
        return { kind: 'stream', text: obj.event.delta.text ?? '', raw: obj }
      }
      return { kind: 'raw', raw: obj }
    default:
      return { kind: 'raw', raw: obj }
  }
}

export function createLineParser(onEvent: (e: ClaudeEvent) => void) {
  let buffer = ''
  return (chunk: Buffer | string) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const evt = classifyLine(line)
      if (evt) onEvent(evt)
    }
  }
}
