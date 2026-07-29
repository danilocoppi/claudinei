import type { FastifyInstance } from 'fastify'
import { createProjectsService } from '../projects.js'
import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { canAccessProject, requireAdmin } from '../auth/guards.js'

export function registerProjectRoutes(app: FastifyInstance, deps: { db: Db; manager: SessionManager }) {
  const svc = createProjectsService(deps.db)

  app.get('/api/projects', async (req) =>
    svc.list().filter((p) => canAccessProject(req.authUser, p.id)))

  app.post('/api/projects', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { name?: string; path?: string; color?: string; icon?: string }
    if (!body?.name || !body?.path) {
      return reply.code(400).send({ error: 'name e path são obrigatórios' })
    }
    try {
      return reply.code(201).send(svc.create({ name: body.name, path: body.path, color: body.color, icon: body.icon }))
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.put('/api/projects/order', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { ids?: unknown }
    if (!Array.isArray(body?.ids) || !body.ids.every((n) => Number.isInteger(n))) {
      return reply.code(400).send({ error: 'ids deve ser uma lista de números' })
    }
    return svc.reorder(body.ids as number[])
  })

  app.patch('/api/projects/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as { id: string }).id)
    // Whitelist: só name/color/icon são editáveis — path nunca muda por PATCH.
    const body = (req.body ?? {}) as { name?: string; color?: string; icon?: string }
    const patch: { name?: string; color?: string; icon?: string } = {}
    if (typeof body.name === 'string' && body.name) patch.name = body.name
    if (typeof body.color === 'string') patch.color = body.color
    if (typeof body.icon === 'string') patch.icon = body.icon
    try {
      return svc.update(id, patch)
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/projects/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as { id: string }).id)
    // Sessão in_terminal sai do mapa `live` mas o PTY continua rodando — o
    // delete em cascata da linha da sessão deixaria o canal órfão no
    // terminalManager (onExit vira no-op). Barra também esse caso.
    const inTerminal = (deps.db.prepare(
      `SELECT COUNT(*) c FROM sessions WHERE project_id=? AND status='in_terminal'`,
    ).get(id) as any).c as number
    if (deps.manager.hasActiveSession(id) || inTerminal > 0) {
      return reply.code(409).send({ error: 'projeto tem uma sessão ativa; finalize-a antes de excluir' })
    }
    svc.remove(id)
    return reply.code(204).send()
  })
}
