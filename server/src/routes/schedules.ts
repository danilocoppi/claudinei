import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { canAccessProject } from '../auth/guards.js'
import { nextRun, validateCadence, type Cadence } from '../schedules/cadence.js'
import type { SchedulesStore, ScheduleInput } from '../schedules/store.js'
import type { Scheduler } from '../schedules/scheduler.js'

const MAX_TASK = 8000

/**
 * Agendamentos são do TERMINAL, não da instalação: quem tem acesso ao projeto
 * administra os dele. Exigir admin tornaria o recurso inútil para quem só opera
 * os próprios terminais.
 */
export function registerScheduleRoutes(
  app: FastifyInstance,
  deps: { db: Db; store: SchedulesStore; scheduler?: Scheduler; broadcast?: (msg: object) => void },
): void {
  const { store } = deps

  const validName = (v: unknown): string | null => {
    const name = typeof v === 'string' ? v.trim() : ''
    return name.length >= 1 && name.length <= 60 ? name : null
  }
  const validTask = (v: unknown): string | null => {
    const task = typeof v === 'string' ? v.trim() : ''
    return task.length >= 1 && task.length <= MAX_TASK ? task : null
  }

  /** Devolve o agendamento se o usuário pode vê-lo; senão responde e devolve null. */
  const reachable = (req: any, reply: any, id: number) => {
    const s = store.get(id)
    if (!s) { reply.code(404).send({ error: `agendamento ${id} não existe` }); return null }
    if (!canAccessProject(req.authUser, s.projectId)) { reply.code(403).send({ error: 'sem acesso a este terminal' }); return null }
    return s
  }

  const changed = (projectId: number) => deps.broadcast?.({ type: 'schedules_changed', projectId })

  // Lista enxuta de tudo que o usuário alcança: é ela que acende o ⏱ na sidebar,
  // então não carrega execução nem resultado.
  app.get('/api/schedules', async (req) =>
    store.list().filter((s) => canAccessProject(req.authUser, s.projectId)))

  app.get('/api/projects/:id/schedules', async (req, reply) => {
    const projectId = Number((req.params as { id: string }).id)
    if (!canAccessProject(req.authUser, projectId)) return reply.code(403).send({ error: 'sem acesso a este terminal' })
    return store.listByProject(projectId)
  })

  app.post('/api/projects/:id/schedules', async (req, reply) => {
    const projectId = Number((req.params as { id: string }).id)
    if (!canAccessProject(req.authUser, projectId)) return reply.code(403).send({ error: 'sem acesso a este terminal' })
    const body = req.body as Partial<ScheduleInput>
    const name = validName(body?.name)
    if (!name) return reply.code(400).send({ error: 'nome inválido (1..60 caracteres)' })
    const task = validTask(body?.task)
    if (!task) return reply.code(400).send({ error: `tarefa inválida (1..${MAX_TASK} caracteres)` })
    const problem = validateCadence(body?.cadence as Cadence)
    if (problem) return reply.code(400).send({ error: problem })
    const keep = body?.keepResults ?? 10
    if (!Number.isInteger(keep) || keep < 1 || keep > 50) return reply.code(400).send({ error: 'guardar entre 1 e 50 resultados' })

    const created = store.create(projectId, {
      name, task, cadence: body!.cadence as Cadence,
      engine: body?.engine ?? null, model: body?.model ?? null, effort: body?.effort ?? null,
      expectsResult: body?.expectsResult !== false, keepResults: keep,
    })
    changed(projectId)
    return reply.code(201).send(created)
  })

  app.patch('/api/schedules/:id', async (req, reply) => {
    const cur = reachable(req, reply, Number((req.params as { id: string }).id))
    if (!cur) return
    const body = req.body as Partial<ScheduleInput> & { enabled?: boolean }
    const patch: Partial<ScheduleInput> = {}
    if (body?.name !== undefined) {
      const name = validName(body.name)
      if (!name) return reply.code(400).send({ error: 'nome inválido (1..60 caracteres)' })
      patch.name = name
    }
    if (body?.task !== undefined) {
      const task = validTask(body.task)
      if (!task) return reply.code(400).send({ error: `tarefa inválida (1..${MAX_TASK} caracteres)` })
      patch.task = task
    }
    if (body?.cadence !== undefined) {
      const problem = validateCadence(body.cadence as Cadence)
      if (problem) return reply.code(400).send({ error: problem })
      patch.cadence = body.cadence as Cadence
    }
    if (body?.keepResults !== undefined) {
      if (!Number.isInteger(body.keepResults) || body.keepResults < 1 || body.keepResults > 50) {
        return reply.code(400).send({ error: 'guardar entre 1 e 50 resultados' })
      }
      patch.keepResults = body.keepResults
    }
    for (const k of ['engine', 'model', 'effort'] as const) {
      if (body?.[k] !== undefined) patch[k] = body[k] === '' ? null : body[k]
    }
    if (body?.expectsResult !== undefined) patch.expectsResult = !!body.expectsResult

    let out = Object.keys(patch).length ? store.update(cur.id, patch) : cur
    // enabled vem por último: pausar/retomar recalcula o horário, e fazê-lo antes
    // da edição da cadência gravaria o horário da cadência antiga.
    if (body?.enabled !== undefined) out = store.setEnabled(cur.id, !!body.enabled)
    changed(cur.projectId)
    return out
  })

  app.delete('/api/schedules/:id', async (req, reply) => {
    const cur = reachable(req, reply, Number((req.params as { id: string }).id))
    if (!cur) return
    store.remove(cur.id)
    changed(cur.projectId)
    return reply.code(204).send()
  })

  app.post('/api/schedules/:id/run', async (req, reply) => {
    const cur = reachable(req, reply, Number((req.params as { id: string }).id))
    if (!cur) return
    if (!deps.scheduler) return reply.code(503).send({ error: 'agendador indisponível' })
    // Não espera a execução terminar: um turno pode levar meia hora, e a resposta
    // do clique não pode ficar pendurada nele. O feed conta o resto pelo WS.
    void deps.scheduler.runNow(cur.id).catch((err) => app.log?.error?.(err))
    return reply.code(202).send({ ok: true })
  })

  app.get('/api/schedules/:id/runs', async (req, reply) => {
    const cur = reachable(req, reply, Number((req.params as { id: string }).id))
    if (!cur) return
    const limit = Math.min(Number((req.query as { limit?: string })?.limit) || 20, 50)
    return store.listRuns(cur.id, limit)
  })

  app.get('/api/schedules/:id/runs/:seq/content', async (req, reply) => {
    const cur = reachable(req, reply, Number((req.params as { id: string }).id))
    if (!cur) return
    const seq = Number((req.params as { seq: string }).seq)
    const content = store.readContent(cur.id, seq)
    // 200 com content nulo, e não 404: a execução existe e está no feed — o que
    // falta é o arquivo, e a tela precisa dizer isso em vez de sumir com a linha.
    return { content }
  })

  /**
   * Preview das próximas execuções. Vem do servidor de propósito: um preview
   * calculado no front acabaria discordando do agendador, e um preview que mente
   * é pior que preview nenhum.
   */
  app.post('/api/schedules/preview', async (req, reply) => {
    const cadence = (req.body as { cadence?: Cadence })?.cadence
    const problem = validateCadence(cadence as Cadence)
    if (problem) return reply.code(400).send({ error: problem })
    return { next: nextRun(cadence as Cadence, new Date(), 4).map((d) => d.toISOString()) }
  })
}
