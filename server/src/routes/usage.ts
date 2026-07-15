import type { FastifyInstance } from 'fastify'
import type { UsageService } from '../usage.js'
import type { EngineUsageService } from '../engine-usage.js'
import { requireAdmin } from '../auth/guards.js'

export interface UsageRouteDeps {
  usage: Pick<UsageService, 'getLimits'>
  /** Ausente (ex.: testes legados) → tokens devolve {}. */
  engineUsage?: Pick<EngineUsageService, 'all'>
}

export async function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps): Promise<void> {
  app.get('/api/usage', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return { limits: await deps.usage.getLimits(), tokens: deps.engineUsage?.all() ?? {} }
  })
}
