import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { SettingsService } from '../settings.js'
import { requireProjectAccess } from '../auth/guards.js'
import { UserError, errorBody } from '../user-error.js'
import type { PagesService } from './service.js'

/** Corpo do `POST /api/hermes/pages`: o `html` vai até 512 K caracteres, que em UTF-8 e JSON passam de 512 KB. */
const PUBLISH_BODY_LIMIT = 2 * 1024 * 1024

/** Status das recusas que não são 400. */
const STATUS: Record<string, number> = { no_live_session: 409, project_not_found: 404 }

export function registerPageRoutes(
  app: FastifyInstance,
  deps: { pages: PagesService; manager: Pick<SessionManager, 'get'>; settings: SettingsService },
): void {
  // O show_page do Hermes: publica a página na conversa viva do terminal (projeto + motor).
  app.post('/api/hermes/pages', { bodyLimit: PUBLISH_BODY_LIMIT }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const projectId = Number(body.projectId)
    if (!Number.isInteger(projectId) || projectId <= 0) return reply.code(400).send({ error: 'projectId is required' })
    // O acesso antes de olhar se o projeto existe: sem oráculo de ids para quem não o vê.
    if (!requireProjectAccess(req, reply, projectId)) return
    const engine = typeof body.engine === 'string' ? body.engine : ''
    if (!engine) return reply.code(400).send({ error: 'engine is required' })
    try {
      const r = deps.pages.publish({
        projectId, engine, html: body.html, path: body.path, title: body.title, height: body.height,
      })
      return reply.code(201).send(r)
    } catch (err) {
      if (err instanceof UserError) return reply.code(STATUS[err.code] ?? 400).send(errorBody(err))
      console.error('[páginas] publicar falhou', err)
      return reply.code(500).send({ error: 'could not publish the page' })
    }
  })
}
