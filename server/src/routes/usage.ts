import type { FastifyInstance } from 'fastify'
import type { UsageService } from '../usage.js'
import type { EngineUsageService } from '../engine-usage.js'
import { requireAdmin } from '../auth/guards.js'

export interface UsageRouteDeps {
  usage: Pick<UsageService, 'getLimits'>
  /** Limites de plano de outros provedores (Codex, Kimi) — entram na mesma lista. */
  extraUsage?: Array<Pick<UsageService, 'getLimits'>>
  /** Ausente (ex.: testes legados) → tokens devolve {}. */
  engineUsage?: Pick<EngineUsageService, 'all'> & Partial<Pick<EngineUsageService, 'recentEngines'>>
}

export async function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps): Promise<void> {
  app.get('/api/usage', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    // Um provedor fora do ar não pode sumir com as barras dos outros: cada fonte
    // já engole o próprio erro devolvendo [], e o allSettled é o cinto extra.
    const sources = [deps.usage, ...(deps.extraUsage ?? [])]
    const results = await Promise.allSettled(sources.map((s) => s.getLimits()))
    const limits = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    // `active`: motores que o cartão da lateral mostra — tokens nas últimas 24 h
    // OU alguma janela de plano acima de 0% (o Claude só entra pelo plano, já que
    // não reporta tokens aqui). A página de uso continua mostrando todos.
    const active = new Set(deps.engineUsage?.recentEngines?.() ?? [])
    for (const l of limits) if (l.percent > 0) active.add(l.provider ?? 'claude')
    return { limits, tokens: deps.engineUsage?.all() ?? {}, active: [...active].sort() }
  })
}
