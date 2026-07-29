// KIMI_CODE_HOME por projeto.
//
// A CLI do Kimi (`@moonshot-ai/kimi-code`) não tem flag de MCP por invocação
// (nem `--mcp-config` do Claude, nem o `-c` do Codex): ela lê `mcp.json` do
// data root, resolvido de `KIMI_CODE_HOME` com fallback `~/.kimi-code`
// (confirmado no bundle da CLI e por spike com o hermes real). Para injetar o
// hermes com o projectId CERTO em cada sessão, cada projeto ganha um data root
// próprio — derivado do caminho do projeto, portanto estável entre processos:
// `readHistory`/`latestConversationId` recalculam o mesmo dir sem estado extra.
//
// O login e as preferências do usuário são compartilhados por SYMLINK para o
// home real (credentials/oauth/config.toml/skills/...) — só `mcp.json` e as
// sessões são por projeto. Efeito colateral aceito e documentado: sessões
// criadas pela plataforma não aparecem no `kimi` rodado à mão fora dela (e
// vice-versa), porque vivem em data roots diferentes.
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HermesOptions } from '../../claude/session.js'

/** Data root real do usuário (onde vivem login e config). */
export function userKimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
}

/** Raiz dos homes por projeto. */
export function kimiHomesRoot(): string {
  return process.env.CLAUDINEI_KIMI_HOMES ?? join(homedir(), '.claudinei', 'kimi-homes')
}

/** Data root desta pasta de projeto — determinístico (hash do caminho). */
export function kimiHomeFor(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 12)
  return join(kimiHomesRoot(), hash)
}

// Compartilhado com o home real: login, config e conteúdo autoral do usuário.
// `mcp.json` fica FORA (é o que precisamos sobrescrever) e `sessions`/
// `session_index.jsonl` também (isolamento por projeto).
const SHARED = ['credentials', 'oauth', 'device_id', 'config.toml', 'tui.toml', 'skills', 'themes', 'plugins', 'agents']

function mcpConfig(hermes?: HermesOptions): unknown {
  // Preserva os MCP servers do usuário (mcp.json do home real) e adiciona o
  // hermes por cima — mesma filosofia do OPENCODE_CONFIG_CONTENT (mesclar, não
  // substituir), para não sumir com o playwright/etc. que o usuário configurou.
  let base: any = {}
  try {
    const raw = readFileSync(join(userKimiHome(), 'mcp.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') base = parsed
  } catch { /* sem mcp.json do usuário: começa vazio */ }
  const servers = { ...(base.mcpServers ?? {}) }
  if (hermes) {
    servers.hermes = {
      command: hermes.command,
      args: hermes.args,
      env: {
        CLAUDINEI_API: hermes.apiUrl,
        CLAUDINEI_PROJECT_ID: String(hermes.projectId),
        ...(hermes.serviceTokenFile
          ? { CLAUDINEI_SERVICE_TOKEN_FILE: hermes.serviceTokenFile }
          : hermes.serviceToken ? { CLAUDINEI_SERVICE_TOKEN: hermes.serviceToken } : {}),
        ...(hermes.engine ? { CLAUDINEI_ENGINE: hermes.engine } : {}),
      },
    }
  }
  return { ...base, mcpServers: servers }
}

/**
 * Garante o data root do projeto (symlinks + mcp.json atual) e devolve o
 * caminho. Idempotente: recalcula o mcp.json a cada sessão (o token de serviço
 * pode ter sido rotacionado por um revoke-all).
 */
export function ensureKimiHome(projectPath: string, hermes?: HermesOptions): string {
  const dir = kimiHomeFor(projectPath)
  mkdirSync(dir, { recursive: true })
  for (const name of SHARED) {
    const src = join(userKimiHome(), name)
    if (!existsSync(src)) continue
    // existsSync segue symlink: um link quebrado dá false e o symlinkSync
    // abaixo estoura EEXIST — daí o try/catch (nada a fazer, o link já existe).
    try { symlinkSync(src, join(dir, name)) } catch { /* já existe */ }
  }
  // tmp + rename: uma sessão nova não pode ler um mcp.json meio escrito por outra.
  const target = join(dir, 'mcp.json')
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(mcpConfig(hermes), null, 2), { mode: 0o600 })
  renameSync(tmp, target)
  return dir
}
