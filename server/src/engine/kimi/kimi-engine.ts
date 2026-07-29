import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from '../types.js'
import { KimiSession } from './kimi-session.js'
import { buildTerminalArgs } from './kimi-args.js'
import { ensureKimiHome, userKimiHome } from './kimi-home.js'
import { latestSessionId, readHistory } from './kimi-history.js'

function bin(): string { return process.env.CLAUDINEI_KIMI_BIN ?? 'kimi' }

// Os modelos dependem do provider logado (o config.toml do usuário declara os
// blocos [models."..."]). Lido do arquivo com cache curto — nada de subprocesso
// no caminho do GET /api/engines. '' = usa o default_model do config.
const MODELS_TTL_MS = 300_000
let modelsCache: { at: number; models: string[] } | null = null

export function listModels(): string[] {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models
  let models = ['']
  try {
    const toml = readFileSync(join(userKimiHome(), 'config.toml'), 'utf8')
    const found = [...toml.matchAll(/^\s*\[models\."([^"]+)"\]/gm)].map((m) => m[1])
    if (found.length) models = ['', ...found]
  } catch { /* sem config.toml: só o default */ }
  modelsCache = { at: Date.now(), models }
  return models
}

export const kimiEngine: Engine = {
  id: 'kimi',
  bin,

  createSession(opts: EngineSessionOptions): EngineSession { return new KimiSession(opts) },

  readHistory(projectPath: string, sessionId: string): Promise<AgentEvent[]> {
    return readHistory(projectPath, sessionId)
  },

  latestConversationId(projectPath: string): string | null {
    return latestSessionId(projectPath)
  },

  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }) {
    // O terminal PRECISA do mesmo data root das sessões do chat (é onde vive a
    // conversa que o -r retoma e o mcp.json com o hermes deste projeto).
    return {
      file: opts.bin ?? bin(),
      args: buildTerminalArgs(opts.resumeSessionId),
      env: { KIMI_CODE_HOME: ensureKimiHome(opts.projectPath) },
    }
  },

  capabilities(): EngineCapabilities {
    return {
      models: listModels(),
      efforts: [],       // o effort vem do [thinking] do config.toml do usuário
      permissions: [],   // headless (-p) roda sem aprovação; sem seletor
      slashSource: 'none',
      label: 'Kimi Code',
      icon: '🌙',
      slashCommands: [],
      installHint: 'npm install -g @moonshot-ai/kimi-code',
    }
  },
}

/** Só para testes: zera o cache de modelos entre casos. */
export function __resetModelsCache(): void { modelsCache = null }
