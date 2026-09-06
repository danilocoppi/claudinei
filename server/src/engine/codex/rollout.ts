import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentEvent } from '../types.js'

// O harness envia estes blocos como role:user. A autoria vem dos metadados,
// nunca de procurar tags no texto (o operador pode colar exatamente o mesmo XML).
const ENGINE_USER_CONTENT_KINDS = new Set(['plugins.recommendations', 'environments.environment_context'])

export function sessionsRoot(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(homedir(), '.codex', 'sessions')
}

/** Varre a árvore YYYY/MM/DD e devolve os caminhos de rollout .jsonl (mais recentes primeiro). */
function allRollouts(root: string): string[] {
  // mtime coletado NA varredura: o sort antigo chamava statSync duas vezes por
  // comparação (O(n log n) syscalls a cada request de histórico).
  const out: Array<{ path: string; mtime: number }> = []
  const walk = (dir: string) => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push({ path: p, mtime: st.mtimeMs })
      } catch { /* sumiu no meio */ }
    }
  }
  walk(root)
  return out.sort((a, b) => b.mtime - a.mtime).map((e) => e.path)
}

export function findRollout(root: string, threadId: string): string | null {
  return allRollouts(root).find((p) => p.includes(threadId)) ?? null
}

/** Normaliza um rollout do Codex (response_item da Responses API) para AgentEvent[]. */
export async function parseRollout(file: string): Promise<AgentEvent[]> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch { return [] }
  const events: AgentEvent[] = []
  let preTokens: number | undefined
  for (const line of text.split('\n')) {
    const s = line.trim(); if (!s) continue
    let o: any; try { o = JSON.parse(s) } catch { continue }
    if (o.type === 'event_msg' && o.payload?.type === 'token_count') {
      const n = o.payload.info?.last_token_usage?.total_tokens
      preTokens = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
    }
    if (o.type === 'compacted') {
      events.push({ kind: 'system', subtype: 'compact_boundary', raw: { compact_metadata: { pre_tokens: preTokens } } })
      preTokens = undefined
    }
    if (o.type !== 'response_item') continue
    const p = o.payload
    if (p?.type === 'message') {
      const role = p.role ?? 'user'
      const text = (Array.isArray(p.content) ? p.content : []).map((c: any) => c.text ?? '').join('')
      // O rollout também guarda instruções internas (skills, permissões etc.).
      // Preserva o papel original e sinaliza a autoria sem adulterar o raw.
      const kinds: unknown = p.internal_chat_message_metadata_passthrough?.content_item_kinds
      const injectedUser = role === 'user' && Array.isArray(kinds) && kinds.length > 0 &&
        kinds.every((kind) => ENGINE_USER_CONTENT_KINDS.has(kind))
      const fromEngine = role === 'developer' || role === 'system' || injectedUser
      if (text) events.push({
        kind: role === 'assistant' ? 'assistant' : 'user',
        message: { role, content: [{ type: 'text', text }] },
        ...(fromEngine ? { fromEngine: true } : {}), raw: o,
      })
    } else if (p?.type === 'reasoning') {
      const text = p.summary?.map?.((s: any) => s.text ?? '').join('') ?? p.text ?? ''
      if (text) events.push({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } as never, raw: o })
    }
    // function_call/output do rollout: omitidos do preview (evita ruído; o ao vivo já mostra tools)
  }
  return events
}

// Lê só o início do arquivo: o session_meta é a 1ª linha e o rollout inteiro
// pode ter vários MB — ler tudo era o maior custo da busca por cwd.
function readFirstLine(file: string): string | null {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return null }
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.toString('utf8', 0, n)
    const nl = text.indexOf('\n')
    return nl === -1 ? text : text.slice(0, nl)
  } catch { return null } finally { closeSync(fd) }
}

export function latestThreadForCwd(root: string, cwd: string): string | null {
  for (const file of allRollouts(root)) {
    const first = readFirstLine(file)
    if (!first) continue
    try {
      const o = JSON.parse(first)
      if (o?.type === 'session_meta' && o.payload?.cwd === cwd) return o.payload.id ?? null
    } catch { /* ignora */ }
  }
  return null
}
