export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export interface ApiMessage {
  role: string
  content: ContentBlock[] | string
  id?: string
  model?: string
}

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string; slashCommands: string[]; raw: unknown }
  | { kind: 'assistant'; message: ApiMessage; raw: unknown }
  | { kind: 'user'; message: ApiMessage; raw: unknown }
  | { kind: 'system'; subtype: string; raw: unknown }
  | { kind: 'result'; subtype: string; isError: boolean; resultText: string; costUsd: number; raw: unknown; tokens?: { input: number; cachedInput: number; output: number; reasoning: number; total: number } }
  | { kind: 'raw'; raw: unknown }
  | { kind: 'parse_error'; line: string }
  | { kind: 'stream'; text: string; raw: unknown }
