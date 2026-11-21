import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { requireProjectAccess } from '../auth/guards.js'
import { hasEngine } from '../engine/index.js'
import { errorBody, fail, UserError } from '../user-error.js'
import type { BranchService } from '../branch/service.js'

/** Recusas que são o estado do terminal, não falha: já há lateral, ou nada para copiar. */
const CONFLICTS = new Set(['side_exists', 'no_conversation'])

/** Status HTTP de um erro do serviço da lateral. */
const statusOf = (err: unknown): number => {
  if (!(err instanceof UserError)) return 400
  if (CONFLICTS.has(err.code)) return 409
  if (err.code === 'side_not_found') return 404
  return 400
}

/**
 * A conversa lateral (`/side`, `/btw`) por terminal (projeto + motor): abrir,
 * conversar, interromper, fechar e o estado que a interface lê ao recarregar.
 * As mudanças vão às telas pelo próprio serviço, como `side_state` e
 * `side_event`, sempre com o `projectId` (o filtro por usuário do ws).
 */
export function registerBranchRoutes(app: FastifyInstance, deps: { db: Db; branch: BranchService }) {
  const projects = createProjectsService(deps.db)

  /** Valida projeto, acesso e motor (do corpo ou da query). Devolve o alvo ou `undefined` (resposta já enviada). */
  const target = (req: FastifyRequest, reply: FastifyReply, engine: unknown): { projectId: number; engine: string } | undefined => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isSafeInteger(id) || id <= 0) { reply.code(400).send({ error: 'id inválido' }); return undefined }
    if (!requireProjectAccess(req, reply, id)) return undefined
    if (typeof engine !== 'string' || !hasEngine(engine)) { reply.code(400).send({ error: 'unknown_engine' }); return undefined }
    if (!projects.get(id)) { reply.code(404).send(fail('project_not_found', 'projeto não existe')); return undefined }
    return { projectId: id, engine }
  }
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>
  const queryEngine = (req: FastifyRequest) => (req.query as { engine?: unknown } | undefined)?.engine

  app.get('/api/projects/:id/side', async (req, reply) => {
    const t = target(req, reply, queryEngine(req))
    if (!t) return
    return deps.branch.side.snapshot(t.projectId, t.engine) ?? { side: null, events: [] }
  })

  app.post('/api/projects/:id/side', async (req, reply) => {
    const b = body(req)
    const t = target(req, reply, b.engine)
    if (!t) return
    if (b.text !== undefined && typeof b.text !== 'string') return reply.code(400).send({ error: 'text deve ser texto' })
    if (b.replace !== undefined && typeof b.replace !== 'boolean') return reply.code(400).send({ error: 'replace deve ser booleano' })
    try {
      const side = await deps.branch.side.open(t.projectId, t.engine, (b.text as string | undefined) ?? null, { replace: b.replace === true })
      return reply.code(201).send(side)
    } catch (err) {
      return reply.code(statusOf(err)).send(errorBody(err))
    }
  })

  app.post('/api/projects/:id/side/message', async (req, reply) => {
    const b = body(req)
    const t = target(req, reply, b.engine)
    if (!t) return
    if (typeof b.text !== 'string' || !b.text.trim()) return reply.code(400).send({ error: 'text vazio' })
    try {
      deps.branch.side.send(t.projectId, t.engine, b.text)
    } catch (err) {
      return reply.code(statusOf(err)).send(errorBody(err))
    }
    return reply.code(204).send()
  })

  app.post('/api/projects/:id/side/interrupt', async (req, reply) => {
    const t = target(req, reply, body(req).engine)
    if (!t) return
    try {
      await deps.branch.side.interrupt(t.projectId, t.engine)
    } catch (err) {
      return reply.code(statusOf(err)).send(errorBody(err))
    }
    return reply.code(204).send()
  })

  app.delete('/api/projects/:id/side', async (req, reply) => {
    const t = target(req, reply, queryEngine(req))
    if (!t) return
    await deps.branch.side.close(t.projectId, t.engine)
    return reply.code(204).send()
  })
}
