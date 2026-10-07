import type { FastifyInstance } from 'fastify'
import { createProjectsService } from '../projects.js'
import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { canAccessProject, requireAdmin, requireProjectAccess } from '../auth/guards.js'
import { iconValueOf } from '../icons/value.js'
import { createActionsStore } from '../actions.js'
import { runKey } from './actions.js'
import type { TerminalManager } from '../terminal/manager.js'
import { createScratchDir } from '../scratch.js'
import { basename } from 'node:path'

/** Teto do nome de um terminal temporário: o cliente manda um rótulo curto com data. */
const SCRATCH_NAME_MAX = 120

export function registerProjectRoutes(app: FastifyInstance, deps: {
  db: Db
  manager: SessionManager
  /** Sem ele o servidor não tem como parar as ações do terminal que sai. */
  terminalManager?: Pick<TerminalManager, 'closeAndWait'>
  /** Base das pastas de terminais temporários. Ausente = a rota não existe. */
  scratchDir?: string
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

  /**
   * Terminal temporário: o servidor reserva uma pasta nova na base e cria o terminal
   * nela, sem passar pelo seletor de pastas.
   *
   * O caminho NUNCA vem do cliente — um `path` no corpo é ignorado. Tudo é validado
   * antes de reservar a pasta, para que um pedido recusado não deixe pasta órfã.
   */
  if (deps.scratchDir) {
    const scratchDir = deps.scratchDir
    app.post('/api/projects/scratch', async (req, reply) => {
      if (!requireAdmin(req, reply)) return
      const body = (req.body ?? {}) as { name?: unknown; icon?: unknown; color?: unknown }
      if (body.name !== undefined && typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'name deve ser texto' })
      }
      const name = (body.name as string | undefined)?.trim() ?? ''
      if (name.length > SCRATCH_NAME_MAX) {
        return reply.code(400).send({ error: `name passa de ${SCRATCH_NAME_MAX} caracteres` })
      }
      let icon = '🧪'
      if (body.icon !== undefined) {
        const valid = iconValueOf(body.icon)
        if (!valid) return reply.code(400).send({ error: 'ícone inválido' })
        icon = valid
      }
      if (body.color !== undefined && typeof body.color !== 'string') {
        return reply.code(400).send({ error: 'color deve ser texto' })
      }
      try {
        const path = createScratchDir(scratchDir)
        return reply.code(201).send(svc.create({
          name: name || basename(path), path, icon, color: body.color as string | undefined,
        }))
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message })
      }
    })
  }

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

  app.patch('/api/projects/:id/favorite', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'id inválido' })
    if (!requireProjectAccess(req, reply, id)) return
    const favorite = (req.body as { favorite?: unknown } | undefined)?.favorite
    if (typeof favorite !== 'boolean') return reply.code(400).send({ error: 'favorite deve ser booleano' })
    const project = svc.setFavorite(id, favorite)
    return project ?? reply.code(404).send({ error: 'projeto não existe' })
  })

  /**
   * Sessões que impedem excluir o terminal, em todas as engines. Inclui a que
   * está no terminal: ela sai do mapa `live`, mas o PTY continua rodando — o
   * delete em cascata da linha deixaria o canal órfão no terminalManager.
   */
  const openSessionsOf = (projectId: number) => deps.db.prepare(
    `SELECT local_id AS localId, engine, status FROM sessions
     WHERE project_id=? AND status IN ('starting','idle','working','needs_attention','in_terminal')`,
  ).all(projectId) as { localId: string; engine: string; status: string }[]

  app.delete('/api/projects/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as { id: string }).id)
    const stillOpen = () => deps.manager.hasActiveSession(id) || openSessionsOf(id).length > 0
    if (stillOpen()) {
      // Sem a confirmação do operador, recusa — e diz quais sessões estão abertas,
      // para o diálogo pedir o "estou ciente" com a lista certa.
      if ((req.query as { stopSessions?: string }).stopSessions !== '1') {
        return reply.code(409).send({ error: 'projeto tem uma sessão ativa; finalize-a antes de excluir', sessions: openSessionsOf(id) })
      }
      // Cada uma espera o processo encerrar de verdade antes da próxima.
      for (const s of openSessionsOf(id)) {
        if (s.status === 'in_terminal') await deps.terminalManager?.closeAndWait(s.localId)
        else await deps.manager.stop(s.localId)
      }
      // Remover com um processo de pé deixaria um agente sem terminal na lista.
      if (stillOpen()) {
        return reply.code(409).send({ error: 'não foi possível finalizar todas as sessões; o terminal não foi excluído', sessions: openSessionsOf(id) })
      }
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
