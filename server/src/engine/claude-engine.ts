import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeSession, type PermissionMode } from '../claude/session.js'
import { latestTranscriptId, readTranscript } from '../history.js'
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from './types.js'

// Diretório de config do Claude (mesma regra do config.ts) — a engine resolve
// sozinha, para readHistory/latestConversationId não dependerem do manager.
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

const CAPABILITIES: EngineCapabilities = {
  models: ['', 'fable', 'opus', 'sonnet', 'haiku'],
  efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'],
  slashSource: 'protocol',
  label: 'Claude Code',
  icon: '✳',
  slashCommands: [],
  installHint: 'npm install -g @anthropic-ai/claude-code',
}

export const claudeEngine: Engine = {
  id: 'claude',

  bin(): string {
    return process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude'
  },

  createSession(opts: EngineSessionOptions): EngineSession {
    // Mapeia as opções genéricas para as SessionOptions do ClaudeSession.
    return new ClaudeSession({
      projectPath: opts.projectPath,
      resumeSessionId: opts.resumeSessionId,
      continueLatest: opts.continueLatest,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode as PermissionMode | undefined, // validado a montante (routes)
      hermes: opts.hermes,
      claudeBin: opts.bin ?? process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude',
      extraArgsOverride: opts.extraArgsOverride,
    })
  },

  readHistory(projectPath: string, engineSessionId: string): AgentEvent[] {
    return readTranscript(claudeConfigDir(), projectPath, engineSessionId)
  },

  latestConversationId(projectPath: string): string | null {
    return latestTranscriptId(claudeConfigDir(), projectPath)
  },

  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }) {
    return {
      file: opts.bin ?? process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude',
      // Com conversa → retoma; sem conversa → sessão nova (fresh).
      args: opts.resumeSessionId
        ? ['--resume', opts.resumeSessionId, '--dangerously-skip-permissions']
        : ['--dangerously-skip-permissions'],
    }
  },

  capabilities(): EngineCapabilities {
    return CAPABILITIES
  },
}
