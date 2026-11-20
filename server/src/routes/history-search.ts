import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { requireProjectAccess } from '../auth/guards.js'
import { getEngine } from '../engine/index.js'
import { readPage } from '../history-page.js'
import { searchEvents, SEARCH_HIT_LIMIT, SEARCH_SLICE_BYTES, type SearchHit } from '../history-search.js'
import { fail } from '../user-error.js'
import { historyConversationId, parseBefore } from './sessions.js'

const Q_MIN = 2
const Q_MAX = 200

/**
 * Busca na conversa do terminal, uma fatia por pedido.
 *
 * Cada pedido lê no máximo SEARCH_SLICE_BYTES do arquivo da engine, antes de
 * `before`, e devolve as ocorrências dali com o `before` da fatia seguinte: o
 * cliente encadeia os pedidos (e pode parar, cancelar ou pedir "mais para
 * trás"). Assim nenhum pedido lê o arquivo inteiro nem segura o laço de eventos
 * por mais que uma fatia.
 *
 * Mesmo arquivo que a rota de histórico mostra, inclusive na prévia.
 */
export function registerHistorySearchRoutes(app: FastifyInstance, deps: { db: Db; manager: SessionManager }) {
  const projects = createProjectsService(deps.db)

  app.get('/api/sessions/:localId/search', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    const info = deps.manager.get(localId)
    if (!info) return reply.code(404).send(fail('session_not_found', 'sessão não existe'))
    if (!requireProjectAccess(req, reply, info.projectId)) return

    const query = req.query as Record<string, unknown>
    const q = typeof query.q === 'string' ? query.q.trim() : ''
    if (q.length < Q_MIN || q.length > Q_MAX) {
      return reply.code(400).send(fail('invalid_query', `a busca deve ter de ${Q_MIN} a ${Q_MAX} caracteres`))
    }
    if (query.tools !== undefined && query.tools !== '0' && query.tools !== '1') {
      return reply.code(400).send(fail('invalid_tools', 'tools deve ser 0 ou 1'))
    }
    const tools = query.tools === '1'
    const before = parseBefore(query.before)
    if (before === null) return reply.code(400).send(fail('invalid_before', 'before deve ser um inteiro não negativo'))

    const vazio: { hits: SearchHit[]; before: number; atStart: boolean } = { hits: [], before: 0, atStart: true }
    const project = projects.get(info.projectId)
    if (!project) return vazio
    const engine = getEngine(info.engine as string)
    try {
      const id = historyConversationId(deps.db, info, project.path, engine)
      if (!id) return vazio
      const page = await readPage(engine, project.path, id, {
        before, minItems: Infinity, maxBytes: SEARCH_SLICE_BYTES, firstChunkBytes: SEARCH_SLICE_BYTES,
      })
      // Uma além do teto: é como o cliente sabe que passou dele ("500+").
      const hits = searchEvents(page.events, q, tools, SEARCH_HIT_LIMIT + 1)
      return { hits, before: page.start, atStart: page.atStart }
    } catch (err) {
      // Erro de leitura não é "chegou ao começo": a busca pararia ali e o que
      // vem antes ficaria sem resposta, sem aviso.
      req.log.error({ err, localId }, 'falha ao ler o histórico para a busca')
      return reply.code(500).send(fail('history_read_failed', 'não foi possível ler o histórico da conversa'))
    }
  })
}
