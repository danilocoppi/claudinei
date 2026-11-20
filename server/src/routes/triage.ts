import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { TriageDto, TriagePatch, TriageStore } from '../triage/store.js'
import { canAccessProject } from '../auth/guards.js'
import { fail } from '../user-error.js'
import { createProjectsService } from '../projects.js'
import type { Db } from '../db.js'

/**
 * Id de armazenamento da triagem, como em routes/prefs.ts: `authUser` ausente é a
 * instalação sem auth (linha 0); token de serviço não tem triagem (`null`).
 */
export const triageUserId = (req: FastifyRequest): number | null => {
  const u = req.authUser
  if (!u) return 0
  return u.kind === 'user' ? u.id : null
}

export const SERVICE_TRIAGE_ERROR = 'token de serviço não tem triagem'

/** Mensagem do WS: só o próprio usuário a recebe (ver `canSee` em routes/ws.ts). */
export const triageMessage = (userId: number, item: TriageDto) => ({ type: 'triage', userId, item })

/** Data ISO 8601 com hora e fuso, como sai de `toISOString()` (o fuso é obrigatório). */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** Valida o corpo do PATCH. Devolve o patch ou a mensagem do 400. */
function parsePatch(body: unknown): TriagePatch | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const p: TriagePatch = {}
  if (b.pinned !== undefined) {
    if (typeof b.pinned !== 'boolean') return 'pinned deve ser booleano'
    p.pinned = b.pinned
  }
  if (b.settled !== undefined) {
    if (typeof b.settled !== 'boolean') return 'settled deve ser booleano'
    p.settled = b.settled
  }
  if (b.snoozedUntil !== undefined) {
    const s = b.snoozedUntil
    if (s !== null) {
      if (typeof s !== 'string' || !ISO.test(s) || Number.isNaN(Date.parse(s))) return 'snoozedUntil deve ser uma data ISO'
      if (Date.parse(s) <= Date.now()) return 'snoozedUntil deve estar no futuro'
    }
    p.snoozedUntil = s as string | null
  }
  if (Object.keys(p).length === 0) return 'nenhum campo de triagem'
  return p
}

export function registerTriageRoutes(app: FastifyInstance, deps: {
  store: TriageStore
  /** Para o 404 de projeto inexistente (a FK do banco recusaria com 500). */
  db: Db
  broadcast?: (msg: object) => void
}): void {
  const projects = createProjectsService(deps.db)

  app.get('/api/triage', async (req) => {
    const id = triageUserId(req)
    if (id === null) return []
    // Filtra pelo acesso de HOJE: quem perdeu o acesso a um projeto não vê mais
    // a triagem dele, mesmo que a linha continue no banco.
    return deps.store.list(id).filter((t) => canAccessProject(req.authUser, t.projectId))
  })

  app.patch('/api/projects/:id/triage', async (req, reply) => {
    const projectId = Number((req.params as { id: string }).id)
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return reply.code(400).send({ error: 'id inválido' })
    const id = triageUserId(req)
    if (id === null) return reply.code(403).send({ error: SERVICE_TRIAGE_ERROR })
    if (!canAccessProject(req.authUser, projectId)) return reply.code(403).send({ error: 'forbidden_project' })
    const patch = parsePatch(req.body)
    if (typeof patch === 'string') return reply.code(400).send({ error: patch })
    if (!projects.get(projectId)) return reply.code(404).send(fail('project_not_found', 'projeto não existe'))
    const item = deps.store.update(id, projectId, patch)
    deps.broadcast?.(triageMessage(id, item))
    return item
  })
}
