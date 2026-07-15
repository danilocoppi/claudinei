import { homedir } from 'node:os'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { moduleDirname } from './dirname.js'

const __dirname = moduleDirname(import.meta.url)

export interface Config {
  port: number
  host: string
  dbPath: string
  claudeBin: string
  codexBin: string
  opencodeBin: string
  claudeConfigDir: string
  /** Caminho absoluto do script stdio do servidor MCP hermes (server/hermes/hermes-mcp.mjs). */
  hermesScript: string
  /** Executável usado para rodar o MCP hermes via --mcp-config (dev: process.execPath/node; empacotado: o próprio binário — ver Task 2/3). */
  hermesCommand: string
  /** Args fixos passados a hermesCommand (dev: [hermesScript]; empacotado: ['--hermes']). */
  hermesArgs: string[]
  /** URL onde este próprio servidor Termaster escuta, usada pelo script hermes-mcp.mjs para chamar a API. */
  selfUrl: string
  /** Sessões terminais mantidas por projeto no prune de arranque (default 5). */
  keepSessionsPerProject: number
  /** Pasta global de uploads do chat (rotação de 100). */
  uploadsDir: string
  /** Pasta do modelo de fala (Parakeet/sherpa) e do libstdc++ portátil. */
  speechDir: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = env.CLAUDINEI_PORT ? Number(env.CLAUDINEI_PORT) : 9105
  const hermesScript = env.CLAUDINEI_HERMES_SCRIPT ?? join(__dirname, '..', 'hermes', 'hermes-mcp.mjs')
  let hermesArgs = [hermesScript]
  if (env.CLAUDINEI_HERMES_ARGS) {
    try {
      const parsed = JSON.parse(env.CLAUDINEI_HERMES_ARGS)
      if (Array.isArray(parsed)) hermesArgs = parsed
    } catch { /* env malformada → mantém o default (hermesScript) */ }
  }
  return {
    port,
    host: env.CLAUDINEI_HOST ?? '127.0.0.1',
    dbPath: env.CLAUDINEI_DB ?? join(homedir(), '.claudinei', 'claudinei.db'),
    claudeBin: env.CLAUDINEI_CLAUDE_BIN ?? 'claude',
    codexBin: env.CLAUDINEI_CODEX_BIN ?? 'codex',
    opencodeBin: env.CLAUDINEI_OPENCODE_BIN ?? 'opencode',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    hermesScript,
    // Em dev, o mcp-config spawna `node <hermes-mcp.mjs>`: o shim resolve o
    // loader tsx e o run-hermes.ts relativos à PRÓPRIA localização (não ao cwd
    // do processo, que é a pasta do projeto do usuário) — ver comentário em
    // server/hermes/hermes-mcp.mjs. Empacotado (T2/T3), quem monta o config
    // sobrescreve para o binário + ['--hermes'].
    hermesCommand: env.CLAUDINEI_HERMES_COMMAND ?? process.execPath,
    hermesArgs,
    selfUrl: env.CLAUDINEI_API ?? `http://127.0.0.1:${port}`,
    keepSessionsPerProject: env.CLAUDINEI_KEEP_SESSIONS ? Number(env.CLAUDINEI_KEEP_SESSIONS) : 5,
    uploadsDir: env.CLAUDINEI_UPLOADS ?? join(homedir(), '.claudinei', 'uploads'),
    speechDir: env.CLAUDINEI_SPEECH ?? join(homedir(), '.claudinei', 'speech'),
  }
}

/**
 * selfUrl efetiva (usada pelo mcp-config do hermes — ver claude/session.ts).
 * loadConfig() já calcula config.selfUrl a partir de CLAUDINEI_PORT/9105, ANTES
 * de sabermos se o usuário passou --port por CLI (só lido depois, no index.ts).
 * Sem essa recalibração, `./claudinei --port 9199` sobe certo mas o hermes
 * injetado nas sessões chama http://127.0.0.1:9105 (a porta ERRADA) — bug real,
 * achado fazendo o smoke da T3 com --port (a 9105 default estava ocupada por
 * outro processo). Prioridade: CLAUDINEI_API (env) > --port (CLI) > config.selfUrl.
 */
export function resolveSelfUrl(
  config: Pick<Config, 'selfUrl'>,
  cli: { port?: number },
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.CLAUDINEI_API) return env.CLAUDINEI_API
  if (cli.port !== undefined) return `http://127.0.0.1:${cli.port}`
  return config.selfUrl
}

/** Parser mínimo de flags de CLI (host/port/insecure). Puro e testável. */
export function parseCliArgs(argv: string[]): { host?: string; port?: number; insecure?: boolean } {
  const out: { host?: string; port?: number; insecure?: boolean } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const eq = a.indexOf('=')
      return eq >= 0 ? a.slice(eq + 1) : argv[++i]
    }
    if (a === '--insecure') out.insecure = true
    else if (a === '--host' || a.startsWith('--host=')) { const v = val(); if (v) out.host = v }
    else if (a === '--port' || a.startsWith('--port=')) { const n = Number(val()); if (Number.isInteger(n)) out.port = n }
  }
  return out
}

/**
 * Migração única do rename do app: ~/.termaster → ~/.claudinei (e termaster.db →
 * claudinei.db). É um rename de diretório — barato mesmo com o modelo de voz de
 * 630MB dentro. Nunca sobrescreve uma instalação nova; falha vira no-op (o boot
 * segue com o caminho novo vazio em vez de morrer).
 */
export function migrateLegacyDataDir(baseDir: string = homedir()): void {
  try {
    const oldDir = join(baseDir, '.termaster')
    const newDir = join(baseDir, '.claudinei')
    if (!existsSync(newDir) && existsSync(oldDir)) renameSync(oldDir, newDir)
    const oldDb = join(newDir, 'termaster.db')
    const newDb = join(newDir, 'claudinei.db')
    if (existsSync(oldDb) && !existsSync(newDb)) {
      renameSync(oldDb, newDb)
      for (const suf of ['-shm', '-wal']) {
        if (existsSync(oldDb + suf)) renameSync(oldDb + suf, newDb + suf)
      }
    }
  } catch { /* melhor abrir vazio no caminho novo do que impedir o boot */ }
}
