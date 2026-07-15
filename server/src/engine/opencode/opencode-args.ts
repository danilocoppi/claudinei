import type { HermesOptions } from '../../claude/session.js'

export const OPENCODE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max']

interface TurnArgs { model?: string; effort?: string; prompt: string; title?: string }

const FIXED = ['run', '--format', 'json', '--auto']

// O `opencode run` não tem flag inline de MCP (como o `-c` do Codex). A config é lida
// de arquivo OU da env `OPENCODE_CONFIG_CONTENT`, que o OpenCode MESCLA com a config do
// usuário (não substitui — confirmado no de-risk). Injetamos só o bloco `mcp.hermes`,
// preservando providers/models/settings do usuário.
export function hermesConfigEnv(hermes?: HermesOptions): Record<string, string> {
  if (!hermes) return {}
  const config = {
    mcp: {
      hermes: {
        type: 'local',
        command: [hermes.command, ...hermes.args],
        enabled: true,
        environment: {
          CLAUDINEI_API: hermes.apiUrl,
          CLAUDINEI_PROJECT_ID: String(hermes.projectId),
          ...(hermes.serviceToken ? { CLAUDINEI_SERVICE_TOKEN: hermes.serviceToken } : {}),
          ...(hermes.engine ? { CLAUDINEI_ENGINE: hermes.engine } : {}),
        },
      },
    },
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
}

function optionArgs(opts: TurnArgs): string[] {
  const args: string[] = []
  if (opts.model) args.push('-m', opts.model)
  if (opts.effort && OPENCODE_EFFORTS.includes(opts.effort)) args.push('--variant', opts.effort)
  return args
}

// Prompt vai como ÚLTIMO argv (posicional message), após '--' para não ser lido
// como flag. spawn não usa shell → sem escaping.
export function buildRunArgs(opts: TurnArgs): string[] {
  const title = opts.title ? ['--title', opts.title] : []
  return [...FIXED, ...title, ...optionArgs(opts), '--', opts.prompt]
}

export function buildResumeArgs(sessionId: string, opts: TurnArgs): string[] {
  return [...FIXED, '-s', sessionId, ...optionArgs(opts), '--', opts.prompt]
}
