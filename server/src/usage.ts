import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Uma barra do /usage, normalizada para o front. */
export interface UsageLimit {
  kind: string
  group: string
  /** Nome vindo da API (ex.: "Fable" no weekly_scoped); null → o front rotula por kind. */
  label: string | null
  percent: number
  severity: string
  resetsAt: string
}

export interface UsageService { getLimits(): Promise<UsageLimit[]> }

interface Opts {
  credentialsPath?: string
  endpoint?: string
  fetchFn?: typeof fetch
  cacheMs?: number
}

/**
 * Proxy do endpoint OAuth de uso do Claude (o mesmo que alimenta o /usage do CLI).
 * Lê o token de ~/.claude/.credentials.json; qualquer falha vira [] — o card some.
 * O token nunca sai do servidor.
 */
export function createUsageService(opts: Opts = {}): UsageService {
  const credentialsPath = opts.credentialsPath ?? join(homedir(), '.claude', '.credentials.json')
  const endpoint = opts.endpoint ?? 'https://api.anthropic.com/api/oauth/usage'
  const fetchFn = opts.fetchFn ?? fetch
  const cacheMs = opts.cacheMs ?? 60_000
  let cache: { at: number; limits: UsageLimit[] } | null = null

  return {
    async getLimits(): Promise<UsageLimit[]> {
      if (cache && Date.now() - cache.at < cacheMs) return cache.limits
      const limits = await fetchLimits().catch(() => [])
      cache = { at: Date.now(), limits }
      return limits
    },
  }

  async function fetchLimits(): Promise<UsageLimit[]> {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { claudeAiOauth?: { accessToken?: string } }
    const token = creds.claudeAiOauth?.accessToken
    if (!token) return []
    const res = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) return []
    const body = (await res.json()) as { limits?: unknown }
    if (!Array.isArray(body.limits)) return []
    return body.limits.flatMap((raw) => {
      const l = raw as { kind?: string; group?: string; percent?: number; severity?: string; resets_at?: string; scope?: { model?: { display_name?: string } } | null }
      if (typeof l.kind !== 'string' || typeof l.percent !== 'number' || typeof l.resets_at !== 'string') return []
      return [{
        kind: l.kind,
        group: typeof l.group === 'string' ? l.group : 'unknown',
        label: l.scope?.model?.display_name ?? null,
        percent: l.percent,
        severity: typeof l.severity === 'string' ? l.severity : 'normal',
        resetsAt: l.resets_at,
      }]
    })
  }
}
