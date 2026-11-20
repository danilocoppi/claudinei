import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { requireAdmin } from '../auth/guards.js'
import { createProjectsService } from '../projects.js'
import { buildUsageReport, type UsagePeriod } from '../usage-index/report.js'
import { ensureUsageSchema } from '../usage-index/store.js'
import type { IndexStatus, UsageIndexer } from '../usage-index/indexer.js'

export interface UsageReportRouteDeps {
  db: Db
  /** Ausente (testes, ou servidor sem indexador) → `index` sai parado e zerado. */
  usageIndexer?: Pick<UsageIndexer, 'status'>
}

const PERIODS: readonly UsagePeriod[] = ['24h', '7d', '30d', '90d']
const IDLE: IndexStatus = { running: false, filesDone: 0, filesTotal: 0, lastPassAt: null }

/** Minutos do `Date.getTimezoneOffset()` do navegador; ausente, inválido ou fora de −840..840 vale 0. */
function parseTz(raw: unknown): number {
  const tz = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : 0
  return Number.isFinite(tz) && tz >= -840 && tz <= 840 ? tz : 0
}

export function registerUsageReportRoutes(app: FastifyInstance, deps: UsageReportRouteDeps): void {
  const projects = createProjectsService(deps.db)
  // As tabelas do índice são criadas uma vez aqui, mesmo que o indexador ainda não tenha rodado.
  ensureUsageSchema(deps.db)
  // Só lê o índice: nunca dispara nem espera uma passada, que roda sozinha no indexador.
  app.get('/api/usage/report', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = req.query as { period?: string; tz?: string }
    const period = PERIODS.find((p) => p === q.period)
    if (!period) return reply.code(400).send({ error: 'invalid_period' })
    const report = buildUsageReport(deps.db, {
      period,
      now: new Date(),
      tzOffsetMin: parseTz(q.tz),
      projects: projects.list(),
    })
    return { ...report, index: deps.usageIndexer?.status() ?? { ...IDLE } }
  })
}
