import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentEvent } from '../types.js'

export function sessionsRoot(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(homedir(), '.codex', 'sessions')
}

/** Varre a árvore YYYY/MM/DD e devolve os caminhos de rollout .jsonl (mais recentes primeiro). */
function allRollouts(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(p)
      } catch { /* sumiu no meio */ }
    }
  }
  walk(root)
  return out.sort((a, b) => (statSync(b).mtimeMs - statSync(a).mtimeMs))
}

export function findRollout(root: string, threadId: string): string | null {
  return allRollouts(root).find((p) => p.includes(threadId)) ?? null
}

/** Normaliza um rollout do Codex (response_item da Responses API) para AgentEvent[]. */
export function parseRollout(file: string): AgentEvent[] {
  if (!existsSync(file)) return []
  const events: AgentEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue
    let o: any; try { o = JSON.parse(s) } catch { continue }
    if (o.type !== 'response_item') continue
    const p = o.payload
    if (p?.type === 'message') {
      const role = p.role === 'assistant' ? 'assistant' : 'user'
      const text = (Array.isArray(p.content) ? p.content : []).map((c: any) => c.text ?? '').join('')
      if (text) events.push({ kind: role === 'assistant' ? 'assistant' : 'user', message: { role, content: [{ type: 'text', text }] } as never, raw: o })
    } else if (p?.type === 'reasoning') {
      const text = p.summary?.map?.((s: any) => s.text ?? '').join('') ?? p.text ?? ''
      if (text) events.push({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } as never, raw: o })
    }
    // function_call/output do rollout: omitidos do preview (evita ruído; o ao vivo já mostra tools)
  }
  return events
}

export function latestThreadForCwd(root: string, cwd: string): string | null {
  for (const file of allRollouts(root)) {
    try {
      const first = readFileSync(file, 'utf8').split('\n', 1)[0]
      const o = JSON.parse(first)
      if (o?.type === 'session_meta' && o.payload?.cwd === cwd) return o.payload.id ?? null
    } catch { /* ignora */ }
  }
  return null
}
