import { CODEX_EFFORTS, CODEX_FALLBACK_CATALOG } from '../../../../shared/codex-models.js'
import type { ModelCatalog, ModelOptions } from '../../../../shared/engine-options.js'
import type { UsageLimit } from '../../usage.js'
import { readCodexMetadata, type CodexMetadataSnapshot } from './codex-app-server.js'

export function codexCatalog(rows: unknown[], configuredModel?: string): ModelCatalog | null {
  const modelOptions: Record<string, ModelOptions> = Object.create(null)
  let defaultModel: string | undefined
  for (const row of rows) {
    const m = row as any
    if (!m || m.hidden === true || typeof m.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(m.model)) continue
    const efforts: string[] = [...new Set<string>((Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
      .map((e: any) => e?.reasoningEffort).filter((e: unknown) => typeof e === 'string' && CODEX_EFFORTS.includes(e)))]
    if (!efforts.length) continue
    modelOptions[m.model] = { efforts, defaultEffort: efforts.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : efforts[0] }
    if (m.isDefault) defaultModel = m.model
  }
  const models = Object.keys(modelOptions)
  if (!models.length) return null
  return {
    models: ['', ...models], modelOptions,
    defaultModel: configuredModel || defaultModel || models[0],
    efforts: ['auto', ...CODEX_EFFORTS.filter((e) => models.some((m) => modelOptions[m].efforts.includes(e)))],
  }
}

/** Cotas são percentuais da conta, não um teto de tokens deduzido do histórico. */
export function codexLimits(body: unknown): UsageLimit[] {
  const r = body as any
  const buckets = new Map<string, any>()
  if (r?.rateLimits) buckets.set(r.rateLimits.limitId ?? 'codex', r.rateLimits)
  if (r?.rateLimitsByLimitId && typeof r.rateLimitsByLimitId === 'object') {
    for (const [id, bucket] of Object.entries(r.rateLimitsByLimitId)) buckets.set(id, bucket)
  }
  const limits: UsageLimit[] = []
  for (const [id, b] of buckets) {
    for (const key of ['primary', 'secondary']) {
      const w = b?.[key]
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)
        || typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt)) continue
      const reset = new Date(w.resetsAt * 1000)
      if (!Number.isFinite(reset.getTime())) continue
      const mins = w.windowDurationMins
      const group = mins === 300 ? 'session' : mins === 10080 ? 'weekly' : 'unknown'
      const duration = typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? mins : undefined
      const percent = Math.min(100, Math.max(0, w.usedPercent))
      const label = typeof b.limitName === 'string' && b.limitName ? b.limitName : id === 'codex' ? null : id
      limits.push({
        kind: `codex_${id}_${key}`, group, label, percent,
        severity: percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal',
        resetsAt: reset.toISOString(), provider: 'codex', windowMinutes: duration,
      })
    }
  }
  return limits
}

export function createCodexMetadataService(opts: {
  read?: () => Promise<CodexMetadataSnapshot>; cacheMs?: number; now?: () => number
} = {}) {
  const read = opts.read ?? readCodexMetadata
  const now = opts.now ?? Date.now
  let catalog = CODEX_FALLBACK_CATALOG
  let limits: UsageLimit[] = []
  let refreshedAt = -Infinity
  let pending: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (pending) return pending
    if (now() - refreshedAt < (opts.cacheMs ?? 60_000)) return Promise.resolve()
    pending = Promise.resolve().then(() => read()).then((snapshot) => {
      if (snapshot.models) catalog = codexCatalog(snapshot.models, snapshot.configuredModel) ?? catalog
      limits = codexLimits(snapshot.rateLimits)
    }).catch(() => { limits = [] }).finally(() => {
      refreshedAt = now()
      pending = undefined
    })
    return pending
  }
  return {
    catalog: () => catalog,
    refresh,
    async getLimits(): Promise<UsageLimit[]> { await refresh(); return limits },
  }
}

export const codexMetadata = createCodexMetadataService()
