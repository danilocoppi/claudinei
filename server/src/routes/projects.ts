import type { FastifyInstance } from 'fastify'
import { createProjectsService } from '../projects.js'
import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { canAccessProject, requireAdmin } from '../auth/guards.js'
import { iconValueOf } from '../icons/value.js'
import { createActionsStore } from '../actions.js'
import { runKey } from './actions.js'
import type { TerminalManager } from '../terminal/manager.js'

export function registerProjectRoutes(app: FastifyInstance, deps: {
  db: Db
  manager: SessionManager
  /** Sem ele o servidor não tem como parar as ações do terminal que sai. */
  terminalManager?: Pick<TerminalManager, 'closeAndWait'>
}) {
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
    // Mesma régua do grupo e do setor. Aqui não havia validação nenhuma: por isso
    // o terminal nunca quebrou com o acervo novo, e por isso qualquer texto virava
    // "ícone" e ia parar na lista como palavra solta.
    if (body.icon !== undefined) {
      const icon = iconValueOf(body.icon)
      if (!icon) return reply.code(400).send({ error: 'ícone inválido' })
      patch.icon = icon
    }
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
    // As ações do terminal morrem COM ele.
    //
    // Era a única porta por onde um PTY escapava sem deixar rastro: o `remove`
    // apaga o projeto e, por cascata, as ações — mas o processo continuava de pé.
    // E sem a linha no banco, a ação deixava de existir para toda a interface e
    // continuava existindo para o sistema operacional. Medido com um `sleep`, que
    // sobreviveu à exclusão do próprio terminal que o criou.
    if (deps.terminalManager) {
      const actions = createActionsStore(deps.db)
      for (const a of actions.list(id)) {
        await deps.terminalManager.closeAndWait(runKey(a.id))
      }
    }
    svc.remove(id)
    return reply.code(204).send()
  })
}
