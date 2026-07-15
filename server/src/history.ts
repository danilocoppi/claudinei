import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { classifyLine } from './claude/parser.js'
import type { ClaudeEvent } from './claude/events.js'

export function encodeCwd(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(claudeConfigDir: string, projectPath: string, engineSessionId: string): string {
  return join(claudeConfigDir, 'projects', encodeCwd(projectPath), `${engineSessionId}.jsonl`)
}

/**
 * Id (basename sem .jsonl) do transcript mais recente da pasta do projeto —
 * é a conversa que `claude --continue` vai retomar. Null se não houver nenhum.
 */
export function latestTranscriptId(claudeConfigDir: string, projectPath: string): string | null {
  const dir = join(claudeConfigDir, 'projects', encodeCwd(projectPath))
  if (!existsSync(dir)) return null
  let best: { id: string; mtime: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const mtime = statSync(join(dir, name)).mtimeMs
      if (!best || mtime > best.mtime) best = { id: name.slice(0, -'.jsonl'.length), mtime }
    } catch { /* arquivo sumiu no meio: ignora */ }
  }
  return best?.id ?? null
}

export function readTranscript(claudeConfigDir: string, projectPath: string, engineSessionId: string): ClaudeEvent[] {
  const file = transcriptPath(claudeConfigDir, projectPath, engineSessionId)
  if (!existsSync(file)) return []
  const events: ClaudeEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const evt = classifyLine(line)
    if (evt && evt.kind !== 'parse_error') events.push(evt)
  }
  return events
}
