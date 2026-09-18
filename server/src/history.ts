import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFromTail } from './tail.js'
import { classifyLine } from './claude/parser.js'
import type { ClaudeEvent } from './claude/events.js'

export function encodeCwd(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(claudeConfigDir: string, projectPath: string, engineSessionId: string): string {
  return join(claudeConfigDir, 'projects', encodeCwd(projectPath), `${engineSessionId}.jsonl`)
}

/**
 * O transcript desta conversa existe em disco?
 *
 * `claude --resume <id>` morre com "No conversation found with session ID" quando
 * o `.jsonl` sumiu (limpeza do ~/.claude, máquina trocada). Chamar isto ANTES de
 * montar o `--resume` troca esse erro fatal por uma sessão nova.
 */
export function transcriptExists(claudeConfigDir: string, projectPath: string, engineSessionId: string): boolean {
  return existsSync(transcriptPath(claudeConfigDir, projectPath, engineSessionId))
}

/**
 * Id (basename sem .jsonl) do transcript mais recente da pasta do projeto —
 * é a conversa que `claude --continue` vai retomar. Null se não houver nenhum.
 */
export function latestTranscriptId(claudeConfigDir: string, projectPath: string, exclude?: ReadonlySet<string>): string | null {
  const dir = join(claudeConfigDir, 'projects', encodeCwd(projectPath))
  if (!existsSync(dir)) return null
  let best: { id: string; mtime: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    // Conversa de outro terminal da mesma pasta: não é candidata.
    if (exclude?.has(id)) continue
    try {
      const mtime = statSync(join(dir, name)).mtimeMs
      if (!best || mtime > best.mtime) best = { id, mtime }
    } catch { /* arquivo sumiu no meio: ignora */ }
  }
  return best?.id ?? null
}

// Async e pela CAUDA: o transcript passa de 200 MB numa sessão longa, e quem
// carrega o histórico quer os últimos 300 eventos, não o arquivo. Ler tudo
// também quebrava de vez acima de 2 GiB, devolvendo "conversa vazia" (o Codex
// chegou lá primeiro — ver src/tail.ts).
export function readTranscript(claudeConfigDir: string, projectPath: string, engineSessionId: string): Promise<ClaudeEvent[]> {
  return parseFromTail(transcriptPath(claudeConfigDir, projectPath, engineSessionId), parseTranscriptText)
}

export function parseTranscriptText(text: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = []
  for (const line of text.split('\n')) {
    const evt = classifyLine(line)
    if (evt && evt.kind !== 'parse_error') events.push(evt)
  }
  return events
}
