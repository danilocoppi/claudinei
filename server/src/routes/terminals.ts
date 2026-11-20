import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { canAccessProject, requireProjectAccess } from '../auth/guards.js'
import { hasEngine } from '../engine/index.js'
import { errorBody, fail } from '../user-error.js'
import type { RestartService } from '../restart/boot.js'

/**
 * Reinício sem prejuízo, por terminal (projeto + motor): os dois interruptores,
 * o Continuar e o fechar do aviso, e a lista que a interface lê ao abrir. As
 * mudanças vão às telas pelo próprio serviço, como
 * `{ type: 'terminal_state', state }`.
 */
export function registerTerminalStateRoutes(app: FastifyInstance, deps: { db: Db; restart: RestartService }) {
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

  app.get('/api/terminals/state', async (req) =>
    deps.restart.list().filter((s) => canAccessProject(req.authUser, s.projectId)))

  app.patch('/api/projects/:id/terminals/:engine/restart', async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    const body = (req.body ?? {}) as { autostart?: unknown; autoResume?: unknown }
    const prefs: { autostart?: boolean; autoResume?: boolean } = {}
    for (const key of ['autostart', 'autoResume'] as const) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean') return reply.code(400).send({ error: `${key} deve ser booleano` })
      prefs[key] = body[key]
    }
    if (Object.keys(prefs).length === 0) {
      return reply.code(400).send({ error: 'informe autostart ou autoResume (booleano)' })
    }
    return deps.restart.setPrefs(t.projectId, t.engine, prefs)
  })

  app.post('/api/projects/:id/terminals/:engine/continue', async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    try {
      if (!deps.restart.resumeTerminal(t.projectId, t.engine)) {
        return reply.code(409).send(fail('nothing_to_continue', 'não há trabalho interrompido para continuar'))
      }
    } catch (err) {
      // O revive (ou o envio) falhou: a marca fica, e o erro vai à tela como no revive comum.
      return reply.code(400).send(errorBody(err))
    }
    return { ok: true }
  })

  app.delete('/api/projects/:id/terminals/:engine/interruption', async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    deps.restart.dismiss(t.projectId, t.engine)
    return { ok: true }
  })
}
