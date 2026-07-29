// Args do `kimi` (Kimi Code CLI). Modo headless: `-p <prompt> --output-format
// stream-json`, um processo por turno (turn-based, como Codex/OpenCode).
// Retomada: `-r <sessionId>` — é o comando que a própria CLI imprime no
// `session.resume_hint` no fim de cada turno.
//
// `-p` NÃO combina com `-y/--yolo` nem com `--auto` (a CLI recusa): no modo
// prompt as tool calls já rodam sem aprovação, verificado por spike.

export interface KimiTurnArgs {
  model?: string
  prompt: string
  resumeSessionId?: string
}

const FIXED = ['--output-format', 'stream-json']

export function buildTurnArgs(opts: KimiTurnArgs): string[] {
  const args: string[] = []
  if (opts.resumeSessionId) args.push('-r', opts.resumeSessionId)
  if (opts.model) args.push('-m', opts.model)
  // O prompt é VALOR de `-p`, então um texto começando com '-' não vira flag.
  return [...args, ...FIXED, '-p', opts.prompt]
}

/** Terminal interativo: `--auto` = totalmente autônomo (par do bypass das outras engines). */
export function buildTerminalArgs(resumeSessionId?: string | null): string[] {
  return resumeSessionId ? ['-r', resumeSessionId, '--auto'] : ['--auto']
}
