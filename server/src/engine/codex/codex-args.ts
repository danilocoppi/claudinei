import type { HermesOptions } from '../../claude/session.js'

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']

interface TurnArgs { model?: string; effort?: string; hermes?: HermesOptions }

const FIXED = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']

// Escapa uma string para uso como valor TOML entre aspas ("..."): barras invertidas
// e aspas duplas precisam ser escapadas, senão um valor com " ou \ quebra o parsing
// do -c do Codex (e pode injetar chaves/tabelas TOML arbitrárias).
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function optionArgs(opts: TurnArgs): string[] {
  const args: string[] = []
  if (opts.model) args.push('-m', opts.model)
  if (opts.effort && CODEX_EFFORTS.includes(opts.effort)) {
    args.push('-c', `model_reasoning_effort=${tomlStr(opts.effort)}`)
  }
  if (opts.hermes) {
    // Forma confirmada no de-risk (Task 1): declara o hermes como MCP server via -c.
    // TOML no valor: strings entre aspas, args como array TOML.
    args.push('-c', `mcp_servers.hermes.command=${tomlStr(opts.hermes.command)}`)
    args.push('-c', `mcp_servers.hermes.args=[${opts.hermes.args.map((a) => tomlStr(a)).join(',')}]`)
    args.push('-c', `mcp_servers.hermes.env.CLAUDINEI_API=${tomlStr(opts.hermes.apiUrl)}`)
    // projectId é number, mas passa pelo mesmo escaper (coagido a string) — não
    // confiar no tipo TS em runtime; remove a assimetria validador/sanitizador.
    args.push('-c', `mcp_servers.hermes.env.CLAUDINEI_PROJECT_ID=${tomlStr(String(opts.hermes.projectId))}`)
    if (opts.hermes.serviceToken) {
      args.push('-c', `mcp_servers.hermes.env.CLAUDINEI_SERVICE_TOKEN=${tomlStr(opts.hermes.serviceToken)}`)
    }
    if (opts.hermes.engine) {
      args.push('-c', `mcp_servers.hermes.env.CLAUDINEI_ENGINE=${tomlStr(opts.hermes.engine)}`)
    }
  }
  return args
}

export function buildExecArgs(opts: TurnArgs): string[] {
  return ['exec', ...FIXED, ...optionArgs(opts), '-']
}

export function buildResumeArgs(threadId: string, opts: TurnArgs): string[] {
  return ['exec', 'resume', threadId, ...FIXED, ...optionArgs(opts), '-']
}
