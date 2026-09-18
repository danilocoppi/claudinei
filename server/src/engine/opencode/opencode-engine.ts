import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from '../types.js'
import type { ApiMessage, ContentBlock } from '../../claude/events.js'
import { OpenCodeSession } from './opencode-session.js'
import { OPENCODE_EFFORTS } from './opencode-args.js'

const SLASH = ['new', 'sessions', 'models', 'share', 'compact', 'undo', 'redo', 'init']

function bin(): string { return process.env.CLAUDINEI_OPENCODE_BIN ?? 'opencode' }

const execFileP = promisify(execFile)

// Models são dinâmicos (dependem dos providers do usuário). Cacheados 5 min. O
// refresh é ASSÍNCRONO e em background: `opencode models` pode levar até 5 s e a
// versão síncrona congelava o GET /api/engines (e o event loop inteiro) — na
// primeira chamada devolve [] e a lista aparece na recarga seguinte.
let modelsCache: { at: number; models: string[] } | null = null
let modelsRefreshing = false
function listModels(): string[] {
  const fresh = modelsCache && Date.now() - modelsCache.at < 300_000
  if (!fresh && !modelsRefreshing) {
    modelsRefreshing = true
    execFile(bin(), ['models'], { timeout: 5000, encoding: 'utf8' }, (err, out) => {
      modelsRefreshing = false
      const models = err
        ? (modelsCache?.models ?? []) // falha → mantém cache anterior ou [] (não quebra a rota)
        : ['', ...out.split('\n').map((l) => l.trim()).filter(Boolean)]
      modelsCache = { at: Date.now(), models }
    })
  }
  return modelsCache?.models ?? []
}

// latestConversationId agora lê direto do SQLite do opencode (read-only, sem
// subprocesso) — cacheia por projectPath para não reabrir o db a cada recarga
// de histórico. Só resultados POSITIVOS entram no cache: o null é o estado
// transitório de um terminal que ainda não criou sessão, e cacheá-lo deixaria
// o histórico/preview vazio por até 30 s DEPOIS de a conversa existir.
const LATEST_CONVERSATION_CACHE_TTL = 30_000
const latestConversationIdCache = new Map<string, { at: number; value: string }>()

function opencodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

/** "Última conversa da pasta" no db do opencode, degradando graciosamente se o schema mudar. */
function queryLatestConversation(db: Database.Database, projectPath: string, exclude?: ReadonlySet<string>): string | null {
  // O schema do opencode evolui entre versões: só referencia a coluna quando ela
  // existe — um id aproximado ainda é melhor que preview nenhum.
  const cols = new Set((db.prepare('PRAGMA table_info(session)').all() as { name?: string }[]).map((c) => c?.name))
  // Subagentes criam sessões FILHAS (parent_id) no MESMO directory: sem filtrar,
  // a "última conversa" vira o transcript de um subagente em vez do que o
  // operador conversou no terminal — e o chat web mostrava a conversa errada.
  const where = [cols.has('parent_id') ? 'directory = ? AND parent_id IS NULL' : 'directory = ?']
  const params: unknown[] = [projectPath]
  // As conversas do terminal vizinho saem no SQL, não em JS: o LIMIT 1 tem que
  // valer para o que SOBROU, não para o que foi descartado depois.
  if (exclude && exclude.size) {
    where.push(`id NOT IN (${[...exclude].map(() => '?').join(', ')})`)
    params.push(...exclude)
  }
  // time_updated, não time_created: retomar uma sessão no TUI não muda a data de
  // criação dela, e é ela (a recém-usada) que o terminal/chat deve reencontrar.
  const order = cols.has('time_updated') ? 'COALESCE(time_updated, time_created)' : 'time_created'
  const row = db.prepare(`SELECT id FROM session WHERE ${where.join(' AND ')} ORDER BY ${order} DESC LIMIT 1`).get(...params) as { id?: string } | undefined
  return row?.id ?? null
}

/**
 * Chave do cache. O `exclude` entra nela porque "a última da pasta" e "a última
 * da pasta que não seja a do vizinho" são perguntas DIFERENTES — com a mesma
 * chave, a resposta de uma valeria pela outra por até 30 s.
 */
function cacheKey(projectPath: string, exclude?: ReadonlySet<string>): string {
  return exclude && exclude.size ? `${projectPath}\u0000${[...exclude].sort().join(',')}` : projectPath
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
  async readHistory(_projectPath: string, sessionId: string): Promise<AgentEvent[]> {
    // Async: o export pode levar até 8 s — a versão síncrona congelava o event
    // loop inteiro (WS/PTYs de todos) a cada carga de histórico.
    try {
      const { stdout } = await execFileP(bin(), ['export', sessionId], { timeout: 8000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return parseExport(stdout)
    } catch { return [] }
  },
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
    // Lê direto do SQLite do opencode (read-only, sem subprocesso). Antes rodava
    // `opencode session list` + até 12 `opencode export` SÍNCRONOS dentro do
    // handler HTTP de histórico — pior caso ~56s congelando o servidor INTEIRO
    // (todos os WS/PTYs, multi-usuário exposto). Cache por projectPath evita
    // reabrir o db a cada recarga de histórico.
    const key = cacheKey(projectPath, exclude)
    const cached = latestConversationIdCache.get(key)
    if (cached && Date.now() - cached.at < LATEST_CONVERSATION_CACHE_TTL) return cached.value
    let result: string | null = null
    try {
      const db = new Database(opencodeDbPath(), { readonly: true, fileMustExist: true })
      try { result = queryLatestConversation(db, projectPath, exclude) } finally { db.close() }
    } catch { result = null } // db ausente/schema mudou/lock → sem preview (degradação graciosa)
    if (result) latestConversationIdCache.set(key, { at: Date.now(), value: result })
    return result
  },
  invalidateLatestConversation(projectPath: string): void {
    // Uma pasta tem várias entradas agora (uma por conjunto de exclusões): quem
    // invalida quer dizer "esta pasta mudou", e todas elas ficaram velhas juntas.
    for (const k of latestConversationIdCache.keys()) {
      if (k === projectPath || k.startsWith(`${projectPath}\u0000`)) latestConversationIdCache.delete(k)
    }
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
