import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Uma barra do /usage, normalizada para o front. */
export interface UsageLimit {
  kind: string
  group: string
  /** Nome vindo da API (ex.: "Fable" no weekly_scoped); null → o front rotula por kind. */
  label: string | null
  percent: number
  severity: string
  resetsAt: string
  /** Provedor do limite. Ausente = Claude (default histórico); 'kimi' etc. quando a lista mistura planos. */
  provider?: string
  /** Duração real da janela, quando fornecida pelo provedor. */
  windowMinutes?: number
  /** Quando o número chegou (ISO). O front avisa quando está velho. */
  updatedAt?: string
}

export interface UsageService {
  getLimits(): Promise<UsageLimit[]>
  /** `rate_limit_info` de um `rate_limit_event` de terminal do Claude. */
  observe(info: unknown): void
}

interface Opts {
  credentialsPath?: string
  endpoint?: string
  fetchFn?: typeof fetch
  /** Intervalo entre consultas ao endpoint quando ele responde bem. */
  cacheMs?: number
  /** Teto da espera depois de falhas (429 etc.). */
  maxBackoffMs?: number
  /** Onde guardar o último valor bom; ausente = só em memória. */
  statePath?: string
  now?: () => number
}

interface Stamped { at: number; limit: UsageLimit }
interface State {
  /** Última resposta boa do endpoint. */
  endpoint: { at: number; limits: UsageLimit[] } | null
  /** Última janela vista nos terminais, por kind (session / weekly_all). */
  windows: Record<string, Stamped>
  /** Quando o endpoint pode ser consultado de novo. */
  nextFetchAt: number
  backoffMs: number
}

const MIN = 60_000
const FIRST_BACKOFF_MS = 2 * MIN

/** Janelas do stream do CLI → as barras que o endpoint já devolvia. */
const WINDOWS: Record<string, { kind: string; group: string }> = {
  five_hour: { kind: 'session', group: 'session' },
  seven_day: { kind: 'weekly_all', group: 'weekly' },
}
const SEVERITY: Record<string, string> = { allowed: 'normal', allowed_warning: 'warning', rejected: 'critical' }

/**
 * Uso do plano do Claude, para o card.
 *
 * A fonte principal é o `rate_limit_event` que todo terminal do Claude recebe no
 * stream-json a cada turno (utilização e reset das janelas de 5 h e semanal):
 * custa zero consultas. O endpoint OAuth de uso (o mesmo do /usage do CLI) traz
 * as linhas por modelo e cobre quando não há terminal trabalhando, mas tem um
 * limite de consultas por conta, dividido com os próprios terminais — por isso
 * vai no máximo a cada 10 minutos, e depois de um 429 espera cada vez mais.
 *
 * Uma falha nunca apaga o que já se sabia: o último valor bom (de cada fonte,
 * janela por janela, o mais novo vence) fica em memória e em disco. Só some uma
 * janela que já virou, porque aí o percentual guardado é sabidamente errado.
 * O token nunca sai do servidor.
 */
export function createUsageService(opts: Opts = {}): UsageService {
  const credentialsPath = opts.credentialsPath ?? join(homedir(), '.claude', '.credentials.json')
  const endpoint = opts.endpoint ?? 'https://api.anthropic.com/api/oauth/usage'
  const fetchFn = opts.fetchFn ?? fetch
  const intervalMs = opts.cacheMs ?? 10 * MIN
  const maxBackoffMs = opts.maxBackoffMs ?? 30 * MIN
  const now = opts.now ?? Date.now
  const state: State = load() ?? { endpoint: null, windows: {}, nextFetchAt: 0, backoffMs: 0 }
  let inFlight: Promise<void> | null = null

  return {
    async getLimits(): Promise<UsageLimit[]> {
      if (now() >= state.nextFetchAt) {
        inFlight ??= refresh().finally(() => { inFlight = null })
        await inFlight
      }
      return merged()
    },
    observe(info: unknown): void {
      const at = now()
      let changed = false
      for (const [type, w] of windowsOf(info)) {
        const target = WINDOWS[type]
        if (!target) continue
        state.windows[target.kind] = {
          at,
          limit: {
            ...target, label: null,
            percent: w.utilization,
            severity: SEVERITY[w.status] ?? 'normal',
            resetsAt: new Date(w.resetsAt * 1000).toISOString(),
          },
        }
        changed = true
      }
      if (changed) save()
    },
  }

  async function refresh(): Promise<void> {
    try {
      const limits = await fetchLimits()
      state.endpoint = { at: now(), limits }
      state.backoffMs = 0
      state.nextFetchAt = now() + intervalMs
    } catch (err) {
      const retryAfterMs = err instanceof RateLimited ? err.retryAfterMs : 0
      state.backoffMs = Math.min(maxBackoffMs, state.backoffMs ? state.backoffMs * 2 : FIRST_BACKOFF_MS)
      state.nextFetchAt = now() + Math.max(state.backoffMs, Math.min(retryAfterMs, maxBackoffMs))
    }
    save()
  }

  function merged(): UsageLimit[] {
    const t = now()
    const fromEndpoint = state.endpoint
      ? state.endpoint.limits.map((limit): Stamped => ({ at: state.endpoint!.at, limit }))
      : []
    const out: Stamped[] = []
    for (const item of fromEndpoint) {
      const seen = item.limit.label === null ? state.windows[item.limit.kind] : undefined
      out.push(seen && seen.at >= item.at ? seen : item)
    }
    for (const [kind, seen] of Object.entries(state.windows)) {
      if (!out.some((s) => s.limit.kind === kind && s.limit.label === null)) out.push(seen)
    }
    return out
      .filter((s) => Date.parse(s.limit.resetsAt) > t)
      .map((s) => ({ ...s.limit, updatedAt: new Date(s.at).toISOString() }))
  }

  async function fetchLimits(): Promise<UsageLimit[]> {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { claudeAiOauth?: { accessToken?: string } }
    const token = creds.claudeAiOauth?.accessToken
    if (!token) throw new Error('sem token')
    const res = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000), // sem isto um stall pendura ~300s (default do undici)
    })
    if (res.status === 429) throw new RateLimited(Number(res.headers.get('retry-after')) * 1000 || 0)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { limits?: unknown }
    if (!Array.isArray(body.limits)) throw new Error('resposta sem limits')
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

  function load(): State | null {
    if (!opts.statePath) return null
    try {
      const s = JSON.parse(readFileSync(opts.statePath, 'utf8')) as Partial<State>
      if (!s || typeof s !== 'object') return null
      return {
        endpoint: s.endpoint && Array.isArray(s.endpoint.limits) && typeof s.endpoint.at === 'number' ? s.endpoint : null,
        windows: s.windows && typeof s.windows === 'object' ? s.windows : {},
        nextFetchAt: typeof s.nextFetchAt === 'number' ? s.nextFetchAt : 0,
        backoffMs: typeof s.backoffMs === 'number' ? s.backoffMs : 0,
      }
    } catch { return null }
  }

  function save(): void {
    if (!opts.statePath) return
    // Gravar é conforto, não pode derrubar a rota nem o handler do stream.
    try {
      mkdirSync(dirname(opts.statePath), { recursive: true })
      const tmp = `${opts.statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state))
      renameSync(tmp, opts.statePath)
    } catch { /* fica só em memória */ }
  }
}

class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) { super('429') }
}

/** Janelas de um `rate_limit_info`: as de `unifiedWindows`, ou a do topo. Utilização em %. */
function windowsOf(info: unknown): Array<[string, { utilization: number; resetsAt: number; status: string }]> {
  if (!info || typeof info !== 'object') return []
  const i = info as Record<string, unknown>
  const one = (w: Record<string, unknown>) => {
    const resetsAt = w.resetsAt
    const status = typeof w.status === 'string' ? w.status : (typeof i.status === 'string' ? i.status : 'allowed')
    const raw = typeof w.utilization === 'number' ? w.utilization : status === 'rejected' ? 1 : null
    if (typeof resetsAt !== 'number' || raw === null) return null
    return { utilization: Math.round(raw * 100), resetsAt, status }
  }
  const out: Array<[string, { utilization: number; resetsAt: number; status: string }]> = []
  const unified = i.unifiedWindows
  if (unified && typeof unified === 'object') {
    for (const [type, w] of Object.entries(unified as Record<string, unknown>)) {
      const parsed = w && typeof w === 'object' ? one(w as Record<string, unknown>) : null
      if (parsed) out.push([type, parsed])
    }
  }
  if (typeof i.rateLimitType === 'string' && !out.some(([type]) => type === i.rateLimitType)) {
    const parsed = one(i)
    if (parsed) out.push([i.rateLimitType, parsed])
  }
  return out
}
