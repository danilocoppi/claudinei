/**
 * Heurística de atividade do terminal embutido: classifica o TUI (Claude Code,
 * Codex, OpenCode) em working / waiting / idle SÓ lendo o fluxo do PTY — zero
 * configuração do usuário (hooks ficaram de fora de propósito). Sinais:
 *
 *  - working: o rodapé do spinner contém "esc to interrupt" e é redesenhado
 *    continuamente enquanto processa (frames repetem o marcador);
 *  - waiting: BEL de verdade (fora de OSC — "\x1b]0;titulo\x07" NÃO conta) ou,
 *    no silêncio, o último frame contém um prompt de escolha ("Do you want…",
 *    "❯ 1. …");
 *  - idle: silêncio (quietMs sem output) e o último frame não tem prompt.
 *
 * O buffer avaliado é o RECENTE (desde a última avaliação de silêncio) — o TUI
 * redesenha a tela inteira, então texto antigo/apagado não pode contaminar a
 * classificação. Não é 100% (heurística assumida); erra para o lado inofensivo.
 */
export type TerminalActivity = 'working' | 'waiting' | 'idle'

// OSC (\x1b]…BEL ou ST), CSI (\x1b[…letra) e escapes simples (\x1bM etc.)
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const ESC_RE = /\x1b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  return s.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '')
}

const WORKING_RE = /esc to interrupt/i
const WAITING_RE = /do you want|would you like|❯\s*\d+\.|waiting for your input/i

export interface ActivityTracker {
  feed(chunk: string): void
  dispose(): void
}

export function createActivityTracker(
  onChange: (activity: TerminalActivity) => void,
  opts: { quietMs?: number } = {},
): ActivityTracker {
  const quietMs = opts.quietMs ?? 1200
  let recent = '' // output (limpo) desde a última avaliação de silêncio
  let current: TerminalActivity | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const emit = (a: TerminalActivity) => {
    if (a !== current) {
      current = a
      onChange(a)
    }
  }

  const evalQuiet = () => {
    timer = null
    const frame = recent
    recent = ''
    if (!frame) return // nada novo desde a última avaliação: estado se mantém
    if (WAITING_RE.test(frame)) emit('waiting')
    else emit('idle')
  }

  return {
    feed(raw: string) {
      // BEL fora de OSC = sino pedindo atenção (o de OSC é só terminador de título)
      const hasBell = raw.replace(OSC_RE, '').includes('\x07')
      recent = (recent + stripAnsi(raw)).slice(-8000)
      if (timer) clearTimeout(timer)
      timer = setTimeout(evalQuiet, quietMs)
      if (hasBell) {
        emit('waiting')
        return
      }
      if (WORKING_RE.test(recent)) emit('working')
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
