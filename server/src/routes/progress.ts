import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { requireProjectAccess } from '../auth/guards.js'
import { validateProgress, type ProgressStore } from '../progress.js'
import { UserError, errorBody } from '../user-error.js'

/**
 * Acompanhamento de tarefas longas (ver src/progress.ts). O Hermes publica pelo
 * POST; a coluna da interface lê e descarta pelas rotas do projeto. Toda mudança
 * vai às telas como `{ type: 'progress', projectId, engine, progress }` — o
 * WebSocket só entrega a quem tem acesso ao projeto.
 */
export function registerProgressRoutes(
  app: FastifyInstance,
  deps: { db: Db; store: ProgressStore; broadcast?: (msg: object) => void },
) {
  const projects = createProjectsService(deps.db)
  const send = (projectId: number, engine: string, progress: unknown) =>
    deps.broadcast?.({ type: 'progress', projectId, engine, progress })
  /** Erro de motor/projeto inválido do store vira 400; o resto sobe. */
  const badRequest = (err: unknown) => {
    if (err instanceof UserError) return errorBody(err)
    throw err
  }

  app.post('/api/hermes/progress', async (req, reply) => {
    const body = (req.body ?? {}) as { projectId?: unknown; engine?: unknown; state?: unknown }
    const project = projects.get(Number(body.projectId))
    if (!project) return reply.code(404).send({ error: 'project does not exist' })
    if (!requireProjectAccess(req, reply, project.id)) return
    const engine = typeof body.engine === 'string' ? body.engine : ''
    const checked = validateProgress(body.state)
    if (!checked.ok) return reply.code(400).send({ error: checked.error })
    try {
      const progress = deps.store.set(project.id, engine, checked.value)
      send(project.id, engine, progress)
      return progress
    } catch (err) {
      return reply.code(400).send(badRequest(err))
    }
  })

  const target = (req: { params: unknown; query: unknown }) => ({
    project: projects.get(Number((req.params as { id: string }).id)),
    engine: String((req.query as { engine?: string }).engine ?? ''),
  })

  app.get('/api/projects/:id/progress', async (req, reply) => {
    const { project, engine } = target(req)
    if (!project) return reply.code(404).send({ error: 'projeto não existe' })
    if (!requireProjectAccess(req, reply, project.id)) return
    try {
      return { progress: deps.store.get(project.id, engine), path: deps.store.pathOf(project.id, engine) }
    } catch (err) {
      return reply.code(400).send(badRequest(err))
    }
  })

  app.delete('/api/projects/:id/progress', async (req, reply) => {
    const { project, engine } = target(req)
    if (!project) return reply.code(404).send({ error: 'projeto não existe' })
    if (!requireProjectAccess(req, reply, project.id)) return
    try {
      deps.store.clear(project.id, engine)
    } catch (err) {
      return reply.code(400).send(badRequest(err))
    }
    send(project.id, engine, null)
    return reply.code(204).send()
  })
}
