import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { createProjectsService } from '../projects.js'
import { createTasksService, type Task } from '../tasks.js'
import { canAccessProject, requireProjectAccess } from '../auth/guards.js'
import { hasEngine } from '../engine/index.js'

export function registerOrchestratorRoutes(
  app: FastifyInstance,
  deps: { db: Db; manager: SessionManager; broadcast?: (msg: object) => void },
): { drain: (projectId: number) => void } {
  const projects = createProjectsService(deps.db)
  const tasks = createTasksService(deps.db)

  const broadcastTask = (id: number): void => {
    const task = tasks.get(id)
    if (task) deps.broadcast?.({ type: 'task_update', task })
  }

  // Entrega a queued mais antiga do projeto alvo, se ele estiver livre agora.
  // Único caminho de entrega: o dispatch HTTP sempre cria a tarefa como
  // 'queued' e chama drain em seguida — a "entrega imediata" é só o caso em
  // que o alvo já está livre nesse instante. O encadeamento da fila (tarefa
  // termina → próxima é entregue) vem do hook onSessionAvailable do manager
  // chamando drain de novo quando o alvo volta a ficar livre.
  const drain = (projectId: number): void => {
    if (!deps.manager.hasFreeSession(projectId)) return
    const next = tasks.nextQueued(projectId)
    if (!next) return
    tasks.markInProgress(next.id)
    const delivered = deps.manager.dispatchTask(next.toProjectId, next.fromProjectName ?? 'unknown', next.description, (status, result) => {
      tasks.setResult(next.id, status, result)
      broadcastTask(next.id)
    })
    // A engine que executa só é conhecida na entrega (o dispatch pega a 1ª sessão
    // livre do projeto — pode ser o Claude, o Codex ou o OpenCode dele).
    if (delivered) tasks.setToEngine(next.id, delivered)
    broadcastTask(next.id)
  }

  app.get('/api/orchestrator/tasks', async (req) => {
    const { limit } = req.query as { limit?: string }
    const parsed = limit ? Number(limit) : undefined
    return tasks.list(parsed && parsed > 0 ? parsed : undefined)
      .filter((t) => canAccessProject(req.authUser, t.toProjectId))
  })

  app.post('/api/orchestrator/dispatch', async (req, reply) => {
    const body = req.body as { fromProjectId?: number; toProjectName?: string; description?: string; fromEngine?: string }
    if (!body?.toProjectName || !body?.description) {
      return reply.code(400).send({ error: 'toProjectName and description are required' })
    }
    const target = projects.list().find((p) => p.name.toLowerCase() === body.toProjectName!.toLowerCase())
    if (!target) return reply.code(404).send({ error: `project "${body.toProjectName}" does not exist` })
    if (!requireProjectAccess(req, reply, target.id)) return

    const fromProject = body.fromProjectId ? projects.get(Number(body.fromProjectId)) : undefined

    // Sempre nasce queued; drain entrega na hora se o alvo já estiver livre
    // (cobrindo também a janela entre o check de disponibilidade e o insert).
    // fromEngine é auto-declarado pelo MCP (env da sessão); valida contra o registry.
    const fromEngine = typeof body.fromEngine === 'string' && hasEngine(body.fromEngine) ? body.fromEngine : null
    const { id } = tasks.create(fromProject?.id ?? null, target.id, body.description, 'queued', fromEngine)
    broadcastTask(id)
    drain(target.id)

    return { id }
  })

  return { drain }
}
