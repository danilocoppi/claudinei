import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from '../types.js'
import type { ApiMessage, ContentBlock } from '../../claude/events.js'
import { OpenCodeSession } from './opencode-session.js'
import { OPENCODE_EFFORTS } from './opencode-args.js'

const SLASH = ['new', 'sessions', 'models', 'share', 'compact', 'undo', 'redo', 'init']

function bin(): string { return process.env.CLAUDINEI_OPENCODE_BIN ?? 'opencode' }

// Models são dinâmicos (dependem dos providers do usuário). Cacheados 5 min para
// não spawnar `opencode models` a cada GET /api/engines. Falha → cache anterior ou
// [] (não pode quebrar a rota).
let modelsCache: { at: number; models: string[] } | null = null
function listModels(): string[] {
  if (modelsCache && Date.now() - modelsCache.at < 300_000) return modelsCache.models
  let models: string[] = []
  try {
    const out = execFileSync(bin(), ['models'], { timeout: 5000, encoding: 'utf8' })
    models = ['', ...out.split('\n').map((l) => l.trim()).filter(Boolean)]
  } catch { models = modelsCache?.models ?? [] }
  modelsCache = { at: Date.now(), models }
  return models
}

// latestConversationId agora lê direto do SQLite do opencode (read-only, sem
// subprocesso) — cacheia por projectPath para não reabrir o db a cada recarga
// de histórico.
const LATEST_CONVERSATION_CACHE_TTL = 30_000
const latestConversationIdCache = new Map<string, { at: number; value: string | null }>()

function opencodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

/** Normaliza um `opencode export <id>` ({info, messages}) para AgentEvent[]. */
export function parseExport(json: string): AgentEvent[] {
  let d: any
  try { d = JSON.parse(json) } catch { return [] }
  const events: AgentEvent[] = []
  for (const m of Array.isArray(d.messages) ? d.messages : []) {
    const role = m.info?.role ?? m.role
    const parts = Array.isArray(m.parts) ? m.parts : []
    for (const p of parts) {
      if (p.type === 'text' && p.text) {
        events.push({ kind: role === 'assistant' ? 'assistant' : 'user', message: { role: role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: p.text }] } as ApiMessage, raw: p })
      } else if (p.type === 'tool' && p.state) {
        // Espelha EXATAMENTE o caso `tool_use` de classifyOpenCodeLine: emite o par
        // assistant tool_use + user tool_result. Sem o tool_result casado, o
        // frontend (applyEvent.ts/ToolCallCard.tsx) renderiza a tool call histórica
        // como "running" para sempre ao recarregar o histórico.
        events.push({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: p.callID, name: p.tool, input: p.state.input ?? {} } as ContentBlock] } as ApiMessage, raw: p })
        events.push({ kind: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.callID, content: p.state.output ?? '', is_error: (p.state.metadata?.exit ?? 0) !== 0 || p.state.status === 'error' } as ContentBlock] } as ApiMessage, raw: p })
      }
    }
  }
  return events
}

export const openCodeEngine: Engine = {
  id: 'opencode',
  bin,
  createSession(opts: EngineSessionOptions): EngineSession { return new OpenCodeSession(opts) },
  readHistory(_projectPath: string, sessionId: string): AgentEvent[] {
    try { return parseExport(execFileSync(bin(), ['export', sessionId], { timeout: 8000, encoding: 'utf8' })) }
    catch { return [] }
  },
  latestConversationId(projectPath: string): string | null {
    // Lê direto do SQLite do opencode (read-only, sem subprocesso). Antes rodava
    // `opencode session list` + até 12 `opencode export` SÍNCRONOS dentro do
    // handler HTTP de histórico — pior caso ~56s congelando o servidor INTEIRO
    // (todos os WS/PTYs, multi-usuário exposto). Cache por projectPath evita
    // reabrir o db a cada recarga de histórico.
    const cached = latestConversationIdCache.get(projectPath)
    if (cached && Date.now() - cached.at < LATEST_CONVERSATION_CACHE_TTL) return cached.value
    let result: string | null = null
    try {
      const db = new Database(opencodeDbPath(), { readonly: true, fileMustExist: true })
      try {
        const row = db.prepare('SELECT id FROM session WHERE directory = ? ORDER BY time_created DESC LIMIT 1').get(projectPath) as { id?: string } | undefined
        result = row?.id ?? null
      } finally { db.close() }
    } catch { result = null } // db ausente/schema mudou/lock → sem preview (degradação graciosa)
    latestConversationIdCache.set(projectPath, { at: Date.now(), value: result })
    return result
  },
  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }) {
    const file = opts.bin ?? bin()
    return opts.resumeSessionId
      ? { file, args: ['--session', opts.resumeSessionId, '--auto'] }
      : { file, args: ['--auto'] }
  },
  capabilities(): EngineCapabilities {
    return {
      models: listModels(),
      efforts: OPENCODE_EFFORTS,
      permissions: [],
      slashSource: 'curated',
      label: 'OpenCode',
      icon: '◇',
      slashCommands: SLASH,
      installHint: 'npm install -g opencode-ai',
    }
  },
}
