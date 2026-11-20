import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { requireProjectAccess } from '../auth/guards.js'
import { hasEngine } from '../engine/index.js'
import { errorBody, fail, UserError } from '../user-error.js'
import type { OperatorQueueService, OperatorQueueStore, QueueDto } from '../queue/operator-queue.js'

/**
 * A fila do operador de um terminal (projeto + motor): ver, acrescentar, editar,
 * reordenar, remover, "enviar agora", pausar e retomar. Toda resposta é o DTO
 * da fila; o serviço já o transmitiu às telas (`{ type: 'operator_queue' }`).
 */
export function registerOperatorQueueRoutes(
  app: FastifyInstance,
  deps: { db: Db; queue: OperatorQueueService; store: Pick<OperatorQueueStore, 'terminalOf'> },
) {
  const projects = createProjectsService(deps.db)

  /** Valida projeto, acesso e motor. Devolve o alvo ou `undefined` (resposta já enviada). */
  const target = (req: FastifyRequest, reply: FastifyReply): { projectId: number; engine: string } | undefined => {
    const params = req.params as { id: string; engine: string }
    const id = Number(params.id)
    if (!Number.isSafeInteger(id) || id <= 0) { reply.code(400).send({ error: 'id inválido' }); return undefined }
    if (!requireProjectAccess(req, reply, id)) return undefined
    if (!hasEngine(params.engine)) { reply.code(400).send({ error: 'unknown_engine' }); return undefined }
    if (!projects.get(id)) { reply.code(404).send(fail('project_not_found', 'projeto não existe')); return undefined }
    return { projectId: id, engine: params.engine }
  }

  /**
   * O item da URL, conferido contra o terminal da URL: item de outro terminal
   * (ou que não existe) é 404, para ninguém mexer na fila alheia pelo id.
   */
  const itemOf = (req: FastifyRequest, reply: FastifyReply): number | undefined => {
    const t = target(req, reply)
    if (!t) return undefined
    const itemId = Number((req.params as { itemId: string }).itemId)
    if (!Number.isSafeInteger(itemId) || itemId <= 0) { reply.code(400).send({ error: 'id de item inválido' }); return undefined }
    const owner = deps.store.terminalOf(itemId)
    if (!owner || owner.projectId !== t.projectId || owner.engine !== t.engine) {
      reply.code(404).send(fail('queue_item_not_found', `item ${itemId} não está na fila`))
      return undefined
    }
    return itemId
  }

  /** Erro de tela vira 400 com o código; o item que sumiu no meio, 404. */
  const run = (reply: FastifyReply, fn: () => QueueDto, okCode = 200): QueueDto | FastifyReply => {
    try {
      const dto = fn()
      return okCode === 200 ? dto : reply.code(okCode).send(dto)
    } catch (err) {
      if (!(err instanceof UserError)) throw err
      return reply.code(err.code === 'queue_item_not_found' ? 404 : 400).send(errorBody(err))
    }
  }

  const base = '/api/projects/:id/terminals/:engine/queue'

  app.get(base, async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    return deps.queue.dto(t.projectId, t.engine)
  })

  app.post(base, async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    const { text } = (req.body ?? {}) as { text?: unknown }
    // O serviço recusa o que não é texto (queue_item_empty), como o vazio.
    return run(reply, () => deps.queue.add(t.projectId, t.engine, text as string), 201)
  })

  app.put(`${base}/order`, async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    const { ids } = (req.body ?? {}) as { ids?: unknown }
    return run(reply, () => deps.queue.reorder(t.projectId, t.engine, ids as number[]))
  })

  app.post(`${base}/pause`, async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    return deps.queue.pause(t.projectId, t.engine)
  })

  app.post(`${base}/resume`, async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    return deps.queue.resume(t.projectId, t.engine)
  })

  app.patch(`${base}/:itemId`, async (req, reply) => {
    const itemId = itemOf(req, reply)
    if (itemId === undefined) return
    const { text } = (req.body ?? {}) as { text?: unknown }
    return run(reply, () => deps.queue.update(itemId, text as string))
  })

  app.delete(`${base}/:itemId`, async (req, reply) => {
    const itemId = itemOf(req, reply)
    if (itemId === undefined) return
    return run(reply, () => deps.queue.remove(itemId))
  })

  app.post(`${base}/:itemId/send-now`, async (req, reply) => {
    const itemId = itemOf(req, reply)
    if (itemId === undefined) return
    return run(reply, () => deps.queue.sendNow(itemId))
  })
}
