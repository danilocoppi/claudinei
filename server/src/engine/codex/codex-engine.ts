import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from '../types.js'
import { CodexSession } from './codex-session.js'
import { sessionsRoot, findRollout, parseRollout, latestThreadForCwd } from './rollout.js'

const CAPABILITIES: EngineCapabilities = {
  // Lista canônica fixada no de-risk (Task 1). '' = padrão do config do usuário.
  models: ['', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  efforts: ['low', 'medium', 'high', 'xhigh'],
  permissions: [], // full-access fixo; sem seletor
  slashSource: 'curated',
  label: 'Codex',
  icon: 'openai', // token → o frontend renderiza o logomark oficial da OpenAI (EngineIcon)
  slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
  installHint: 'npm install -g @openai/codex',
}

export const codexEngine: Engine = {
  id: 'codex',
  bin(): string {
    return process.env.CLAUDINEI_CODEX_BIN ?? 'codex'
  },
  createSession(opts: EngineSessionOptions): EngineSession {
    return new CodexSession(opts)
  },
  readHistory(_projectPath: string, threadId: string): AgentEvent[] {
    const file = findRollout(sessionsRoot(), threadId)
    return file ? parseRollout(file) : []
  },
  latestConversationId(projectPath: string): string | null {
    return latestThreadForCwd(sessionsRoot(), projectPath)
  },
  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }) {
    const file = opts.bin ?? process.env.CLAUDINEI_CODEX_BIN ?? 'codex'
    // Com thread → retoma; sem thread (sessão Codex idle sem 1º turno) → sessão nova.
    return opts.resumeSessionId
      ? { file, args: ['resume', opts.resumeSessionId, '--dangerously-bypass-approvals-and-sandbox'] }
      : { file, args: ['--dangerously-bypass-approvals-and-sandbox'] }
  },
  capabilities(): EngineCapabilities { return CAPABILITIES },
}
