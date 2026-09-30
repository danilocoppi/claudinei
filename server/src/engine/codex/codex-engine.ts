import { spawnSync } from 'node:child_process'
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from '../types.js'
import { CodexSession } from './codex-session.js'
import { sessionsRoot, findRollout, parseRollout, latestThreadForCwd } from './rollout.js'
import { codexMetadata } from './codex-metadata.js'

const CAPABILITIES: EngineCapabilities = {
  ...codexMetadata.catalog(),
  contextManagement: true,
  permissions: [], // full-access fixo; sem seletor
  slashSource: 'curated',
  label: 'Codex',
  icon: 'openai', // token → o frontend renderiza o logomark oficial da OpenAI (EngineIcon)
  slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
  installHint: 'npm install -g @openai/codex',
}

/**
 * Na 0.159, o TUI do Codex roda a conversa num daemon compartilhado, que
 * continua de pé quando o terminal fecha e segura a conversa por mais 60 s.
 * Voltar do terminal para o chat retoma essa conversa em outro processo, e o
 * Codex recusa com "already has an active writer" — a sessão morria ali. Sem o
 * daemon, a conversa pertence ao processo do terminal e é solta no instante em
 * que ele fecha.
 *
 * Pergunta à CLI a cada abertura (~20 ms) porque ela pode ser atualizada com o
 * Claudinei no ar; CLI anterior à opção recusaria o argumento e o terminal não
 * abriria.
 */
function supportsNoDaemon(file: string, subcommand: string[]): boolean {
  const help = spawnSync(file, [...subcommand, '--help'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, PKG_EXECPATH: '' },
  })
  return help.status === 0 && /--no-daemon\b/.test(help.stdout ?? '')
}

export const codexEngine: Engine = {
  id: 'codex',
  bin(): string {
    return process.env.CLAUDINEI_CODEX_BIN ?? 'codex'
  },
  createSession(opts: EngineSessionOptions): EngineSession {
    return new CodexSession(opts)
  },
  async readHistory(_projectPath: string, threadId: string): Promise<AgentEvent[]> {
    const file = findRollout(sessionsRoot(), threadId)
    return file ? parseRollout(file) : []
  },
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
    return latestThreadForCwd(sessionsRoot(), projectPath, exclude)
  },
  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }) {
    const file = opts.bin ?? process.env.CLAUDINEI_CODEX_BIN ?? 'codex'
    // Com thread → retoma; sem thread (sessão Codex idle sem 1º turno) → sessão nova.
    const subcommand = opts.resumeSessionId ? ['resume'] : []
    const args = opts.resumeSessionId
      ? ['resume', opts.resumeSessionId, '--dangerously-bypass-approvals-and-sandbox']
      : ['--dangerously-bypass-approvals-and-sandbox']
    return { file, args: supportsNoDaemon(file, subcommand) ? [...args, '--no-daemon'] : args }
  },
  capabilities(): EngineCapabilities { return { ...CAPABILITIES, ...codexMetadata.catalog() } },
  refreshCapabilities: () => codexMetadata.refresh(),
}
