import type { ForkFrom } from '../engine/types.js'

/**
 * Cópia nativa da conversa no Claude e no Codex: as flags e os params que
 * transformam o lançamento de sempre numa cópia (ramo ou conversa lateral).
 * Funções puras; os ensaios com as CLIs reais (20/11/2026) fixaram os valores.
 */

/** Opções da cópia que mexem no lançamento do Claude. */
export interface ClaudeBranchOptions {
  forkFrom?: ForkFrom
  sessionId?: string
  readOnly?: boolean
  ephemeral?: boolean
}

/** Ferramentas que escrevem arquivo, barradas na conversa só de leitura. */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/**
 * Ajusta os args do `claude` para abrir uma cópia. Sem nenhum campo, devolve os
 * args iguais. Não altera o array recebido.
 *
 * - `forkFrom`: troca a retomada do original (`--resume <x>`/`--continue`) por
 *   `--resume <origem> --fork-session`; com `cut`, `--resume-session-at <cut>`.
 *   O corte é o `uuid` da entrada do transcript, inclusivo (com o `msg_…` da
 *   API a CLI sai com código 1 antes do init).
 * - `sessionId`: `--session-id <id>`; a cópia ganha exatamente esse id.
 * - `ephemeral`: `--no-session-persistence` (não grava transcript).
 * - `readOnly`: sai o bypass; entra o modo plano e as ferramentas de escrita
 *   barradas. A lista de `--disallowed-tools` é variádica, então fica por
 *   último: depois dela só o fim dos args.
 */
export function claudeBranchArgs(args: string[], o: ClaudeBranchOptions): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (o.forkFrom && a === '--resume') { i++; continue } // pula a flag e o id
    if (o.forkFrom && a === '--continue') continue
    if (o.readOnly && a === '--dangerously-skip-permissions') continue
    out.push(a)
  }
  if (o.forkFrom) {
    out.push('--resume', o.forkFrom.sourceId, '--fork-session')
    if (o.forkFrom.cut) out.push('--resume-session-at', o.forkFrom.cut)
  }
  if (o.sessionId) out.push('--session-id', o.sessionId)
  if (o.ephemeral) out.push('--no-session-persistence')
  if (o.readOnly) out.push('--permission-mode', 'plan', '--disallowed-tools', ...WRITE_TOOLS)
  return out
}

/**
 * Params do `thread/fork` do App Server do Codex, a partir dos de `thread/start`
 * (`cwd`, `approvalPolicy`, `model`, `config` e, no ramo, `developerInstructions`).
 * `excludeTurns: true` sempre: o fork efêmero de conversa paginada é recusado
 * sem ele (-32600), e a sessão não precisa dos turnos na resposta.
 */
export function codexForkParams(
  base: Record<string, unknown>,
  o: { forkFrom: ForkFrom; readOnly?: boolean; ephemeral?: boolean },
): Record<string, unknown> {
  const { cut } = o.forkFrom
  return {
    ...base,
    threadId: o.forkFrom.sourceId,
    ...(cut ? { lastTurnId: cut } : {}),
    excludeTurns: true,
    ...(o.ephemeral ? { ephemeral: true } : {}),
    sandbox: o.readOnly ? 'read-only' : base.sandbox,
  }
}
