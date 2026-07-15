import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { createProjectsService } from '../projects.js'
import { createMuralService } from '../mural.js'
import { canAccessProject, requireProjectAccess } from '../auth/guards.js'

export function registerHermesRoutes(
  app: FastifyInstance,
  deps: { db: Db; manager: SessionManager; broadcast?: (msg: object) => void },
) {
  const projects = createProjectsService(deps.db)
  const board = createMuralService(deps.db)

  app.get('/api/hermes/projects', async (req) => {
    return projects.list()
      .filter((p) => canAccessProject(req.authUser, p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        hasActiveSession: deps.manager.hasActiveSession(p.id),
      }))
  })

  app.get('/api/hermes/board', async (req) => {
    const { limit } = req.query as { limit?: string }
    const parsed = limit ? Number(limit) : undefined
    return board.list(parsed && parsed > 0 ? parsed : undefined)
      .filter((post) => canAccessProject(req.authUser, post.projectId))
  })

  app.post('/api/hermes/board', async (req, reply) => {
    const body = req.body as { projectId?: number; title?: string; content?: string }
    if (!body?.projectId || !body?.title || !body?.content) {
      return reply.code(400).send({ error: 'projectId, title and content are required' })
    }
    const project = projects.get(Number(body.projectId))
    if (!project) return reply.code(400).send({ error: 'project does not exist' })
    if (!requireProjectAccess(req, reply, project.id)) return
    const result = board.publish(project.id, body.title, body.content)
    deps.broadcast?.({
      type: 'board_post',
      id: result.id,
      projectId: project.id,
      projectName: project.name,
      title: body.title,
      content: body.content,
    })
    return reply.code(201).send(result)
  })

  app.post('/api/hermes/ask', async (req, reply) => {
    const body = req.body as { fromProjectId?: number; toProjectName?: string; question?: string }
    if (!body?.toProjectName || !body?.question) {
      return reply.code(400).send({ error: 'toProjectName and question are required' })
    }
    const target = projects.list().find((p) => p.name.toLowerCase() === body.toProjectName!.toLowerCase())
    if (!target) return reply.code(404).send({ error: `project "${body.toProjectName}" does not exist` })
    if (!requireProjectAccess(req, reply, target.id)) return

    const fromProject = body.fromProjectId ? projects.get(Number(body.fromProjectId)) : undefined
    const fromLabel = fromProject?.name ?? 'unknown'

    try {
      const answer = await deps.manager.askAgent(target.id, fromLabel, body.question)
      return { answer }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })
}
