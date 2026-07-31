// Limites de plano do Kimi para o card de uso — a mesma fonte que o `/status`
// da CLI mostra: GET <base>/usages com o Bearer do OAuth local.
//
// O access token do Kimi vive ~15 min (`expires_in: 900`) e quem o renova é a
// PRÓPRIA CLI. Aqui só LEMOS: token vencido → devolve [] (as barras somem) em
// vez de tentar o refresh, porque refresh token costuma ser de uso único e
// girá-lo por fora deslogaria a CLI do usuário.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageLimit } from '../../usage.js'
import { userKimiHome } from './kimi-home.js'

const HOUR_MS = 3_600_000

interface Opts {
  credentialsPath?: string
  endpoint?: string
  fetchFn?: typeof fetch
  cacheMs?: number
  now?: () => number
}

/** Resposta do /usages (só o que consumimos; o corpo real traz muito mais). */
interface UsagesBody {
  usage?: { limit?: string; used?: string; resetTime?: string }
  limits?: Array<{
    window?: { duration?: number; timeUnit?: string }
    detail?: { limit?: string; used?: string; resetTime?: string }
  }>
}

const UNIT_MS: Record<string, number> = {
  TIME_UNIT_SECOND: 1000,
  TIME_UNIT_MINUTE: 60_000,
  TIME_UNIT_HOUR: HOUR_MS,
  TIME_UNIT_DAY: 24 * HOUR_MS,
  TIME_UNIT_WEEK: 168 * HOUR_MS,
}

/** used/limit vêm como STRING na API ("90"/"100") → percentual inteiro. */
function percentOf(used?: string, limit?: string): number | null {
  const u = Number(used)
  const l = Number(limit)
  if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return null
  return Math.round((u / l) * 100)
}

function severityOf(percent: number): string {
  if (percent >= 85) return 'danger'
  if (percent >= 50) return 'warn'
  return 'normal'
}

/**
 * Grupo = janela, no vocabulário que o cálculo de ritmo do front já entende
 * (5h = 'session', 7d = 'weekly'). Fora dessas duas, 'other': a barra aparece,
 * só não ganha coloração por ritmo.
 */
function groupFor(windowMs: number | null): string {
  if (windowMs === 5 * HOUR_MS) return 'session'
  if (windowMs === 168 * HOUR_MS) return 'weekly'
  return 'other'
}

function kindFor(windowMs: number | null): string {
  if (windowMs === null) return 'kimi_limit'
  if (windowMs === 168 * HOUR_MS) return 'kimi_weekly'
  const hours = windowMs / HOUR_MS
  return `kimi_${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

export function createKimiUsageService(opts: Opts = {}) {
  const credentialsPath = opts.credentialsPath ?? join(userKimiHome(), 'credentials', 'kimi-code.json')
  const base = (process.env.KIMI_CODE_BASE_URL ?? 'https://api.kimi.com/coding/v1').replace(/\/+$/, '')
  const endpoint = opts.endpoint ?? `${base}/usages`
  const fetchFn = opts.fetchFn ?? fetch
  const cacheMs = opts.cacheMs ?? 60_000
  const now = opts.now ?? Date.now
  let cache: { at: number; limits: UsageLimit[] } | null = null

  return {
    async getLimits(): Promise<UsageLimit[]> {
      if (cache && now() - cache.at < cacheMs) return cache.limits
      const limits = await fetchLimits().catch(() => [])
      cache = { at: now(), limits }
      return limits
    },
  }

  async function fetchLimits(): Promise<UsageLimit[]> {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { access_token?: string; expires_at?: number }
    const token = creds.access_token
    // expires_at é epoch em SEGUNDOS; sem token válido nem chamamos (evita 401 à toa).
    if (!token || (typeof creds.expires_at === 'number' && creds.expires_at * 1000 <= now())) return []

    const res = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as UsagesBody

    const out: UsageLimit[] = []
    const push = (windowMs: number | null, d?: { limit?: string; used?: string; resetTime?: string }) => {
      const percent = percentOf(d?.used, d?.limit)
      if (percent === null || typeof d?.resetTime !== 'string') return
      out.push({
        kind: kindFor(windowMs),
        group: groupFor(windowMs),
        label: null, // o front rotula por kind (com o prefixo Kimi)
        percent,
        severity: severityOf(percent),
        resetsAt: d.resetTime,
        provider: 'kimi',
      })
    }

    // `usage` é a cota principal do plano (o "Weekly limit" do /status).
    push(168 * HOUR_MS, body.usage)
    for (const row of Array.isArray(body.limits) ? body.limits : []) {
      const unit = row.window?.timeUnit
      const duration = row.window?.duration
      const windowMs = typeof duration === 'number' && unit && UNIT_MS[unit] ? duration * UNIT_MS[unit] : null
      push(windowMs, row.detail)
    }
    return out
  }
}

export type KimiUsageService = ReturnType<typeof createKimiUsageService>
