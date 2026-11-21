import { resolve } from 'node:path'
import type { AgentEvent } from '../engine/types.js'

// Ferramentas que escrevem arquivo, nos quatro motores: Edit/Write/MultiEdit/
// NotebookEdit (Claude), file_change (Codex), edit/write/patch (OpenCode),
// WriteFile/StrReplaceFile (Kimi).
const WRITES = /edit|write|patch|replace|create|notebook|file_change/i
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'path'] as const

/**
 * Caminhos (absolutos) que o agente declarou mexer neste evento. Só conta o
 * `tool_use` de `assistant` de uma ferramenta de escrita; o input pode vir em
 * string JSON (Kimi). Relativo resolve contra `cwd`.
 */
export function declaredPaths(event: AgentEvent, cwd: string): string[] {
  if (event.kind !== 'assistant' || !Array.isArray(event.message.content)) return []
  const out: string[] = []
  for (const block of event.message.content) {
    if (block.type !== 'tool_use' || typeof block.name !== 'string' || !WRITES.test(block.name)) continue
    let input = block.input
    if (typeof input === 'string') {
      try { input = JSON.parse(input) } catch { continue }
    }
    if (!input || typeof input !== 'object') continue
    const o = input as Record<string, unknown>
    for (const key of PATH_KEYS) {
      const v = o[key]
      if (typeof v === 'string' && v) out.push(v)
    }
    // O file_change do Codex: o item inteiro, com `changes: [{ path, kind }]`.
    if (Array.isArray(o.changes)) {
      for (const c of o.changes) {
        const v = (c as { path?: unknown } | null)?.path
        if (typeof v === 'string' && v) out.push(v)
      }
    }
  }
  return [...new Set(out.map(p => resolve(cwd, p)))]
}
