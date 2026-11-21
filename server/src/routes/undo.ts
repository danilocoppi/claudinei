import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import type { SessionInfo, SessionManager } from '../claude/manager.js'
import { requireProjectAccess } from '../auth/guards.js'
import { errorBody, fail, UserError } from '../user-error.js'
import { UndoChangedError, type UndoRequest } from '../undo/service.js'
import type { Undo } from '../undo/index.js'
import type { TurnRow } from '../undo/store.js'
import type { ViewerFull } from '../../../shared/undo.js'

/**
 * Rotas do desfazer turno. A autorização segue o projeto do turno, do
 * desfazer ou da sessão (`requireProjectAccess`); o que cada um vê dentro do
 * projeto (arquivos fora da pasta viram `hiddenOutside`) é do serviço, pelo
 * `ViewerFull` do pedido. Sem auth, vale como administrador.
 */

/** Status de cada recusa do serviço. Código sem entrada: 400. */
const STATUS: Record<string, number> = {
  undo_no_turns: 400,
  undo_mixed_terminals: 400,
  undo_bad_decision: 400,
  undo_not_redoable: 400,
  undo_bad_request: 400,
  forbidden_project: 403,
  forbidden_path: 403,
  // Quem não é administrador não refaz desfazer com arquivos de fora (R16): pede ao administrador.
  redo_hidden_files: 403,
  session_not_found: 404,
  undo_turn_not_found: 404,
  undo_run_not_found: 404,
  undo_path_not_in_turn: 404,
  undo_interval_not_found: 404,
  undo_unavailable: 409,
  undo_blocked: 409,
  undo_writing: 409,
  undo_already_redone: 409,
  snapshot_lost: 410,
  // Dá para tentar de novo: o git não respondeu ou o marco não saiu.
  snapshot_check_failed: 503,
  undo_snapshot_failed: 503,
}

function viewerOf(req: FastifyRequest): ViewerFull {
  const u = req.authUser
  if (!u || u.kind === 'service' || u.isAdmin) return { isAdmin: true, projectIds: 'all' }
  return { isAdmin: false, projectIds: [...u.projectIds] }
}

function sendError(reply: FastifyReply, err: unknown) {
  // 409 com a prévia nova: a tela troca a que mostrava e pede de novo.
  if (err instanceof UndoChangedError) return reply.code(409).send({ ...errorBody(err), preview: err.preview })
  if (err instanceof UserError) return reply.code(STATUS[err.code] ?? 400).send(errorBody(err))
  console.error('[undo] rota falhou', err)
  return reply.code(500).send(errorBody(err))
}

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function registerUndoRoutes(app: FastifyInstance, deps: { undo: Undo; manager: Pick<SessionManager, 'get'>; db: Db }) {
  const { undo } = deps

  /** A sessão do `localId`, com acesso conferido; undefined = resposta já enviada. */
  const sessionOf = (req: FastifyRequest, reply: FastifyReply, localId: unknown): SessionInfo | undefined => {
    if (typeof localId !== 'string' || !localId) {
      reply.code(400).send(fail('undo_bad_request', 'falta o terminal (localId)'))
      return undefined
    }
    const info = deps.manager.get(localId)
    if (!info) { reply.code(404).send(fail('session_not_found', 'sessão não existe')); return undefined }
    if (!requireProjectAccess(req, reply, info.projectId)) return undefined
    return info
  }

  /** Um turno pelo id da rota, com acesso conferido. */
  const turnOf = (req: FastifyRequest, reply: FastifyReply): TurnRow | undefined => {
    const id = positiveInt((req.params as { id: string }).id)
    if (id === null) { reply.code(400).send(fail('undo_bad_request', 'id inválido')); return undefined }
    const t = undo.store.turn(id)
    if (!t) { reply.code(404).send(fail('undo_turn_not_found', `turno ${id} não encontrado`, { id })); return undefined }
    if (!requireProjectAccess(req, reply, t.projectId)) return undefined
    return t
  }

  /** Os turnos do corpo: existem, o pedido vê todos, e são do mesmo terminal. */
  const turnsOf = (req: FastifyRequest, reply: FastifyReply): number[] | undefined => {
    const raw = (req.body as { turnIds?: unknown } | undefined)?.turnIds
    const ids = Array.isArray(raw) ? raw.map(positiveInt) : []
    if (!ids.length || ids.some(id => id === null)) {
      reply.code(400).send(fail('undo_no_turns', 'nenhum turno para desfazer'))
      return undefined
    }
    // O acesso aos que existem vem antes do 404 dos que faltam: misturar um id
    // alheio com um inexistente dá 403, como o alheio sozinho. Id que não existe
    // não tem projeto, então dá 404 para todos (inclusive o administrador).
    const turns = (ids as number[]).map(id => ({ id, t: undo.store.turn(id) }))
    for (const { t } of turns) if (t && !requireProjectAccess(req, reply, t.projectId)) return undefined
    const missing = turns.find(x => !x.t)
    if (missing) {
      reply.code(404).send(fail('undo_turn_not_found', `turno ${missing.id} não encontrado`, { id: missing.id }))
      return undefined
    }
    const rows = turns.map(x => x.t!)
    if (rows.some(t => t.projectId !== rows[0].projectId || t.engine !== rows[0].engine)) {
      reply.code(400).send(fail('undo_mixed_terminals', 'os turnos são de terminais diferentes'))
      return undefined
    }
    return ids as number[]
  }

  /** Um desfazer pelo id da rota, com acesso conferido. */
  const runOf = (req: FastifyRequest, reply: FastifyReply): number | undefined => {
    const id = positiveInt((req.params as { id: string }).id)
    if (id === null) { reply.code(400).send(fail('undo_bad_request', 'id inválido')); return undefined }
    const run = undo.store.run(id)
    if (!run) { reply.code(404).send(fail('undo_run_not_found', `desfazer ${id} não encontrado`, { id })); return undefined }
    if (!requireProjectAccess(req, reply, run.projectId)) return undefined
    return id
  }

  /** O intervalo da rota, aberto a partir do terminal `?localId=` (o projeto que autoriza e recorta). */
  const intervalOf = (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { from: string; to: string }
    const from = positiveInt(params.from)
    const to = positiveInt(params.to)
    if (from === null || to === null) { reply.code(400).send(fail('undo_bad_request', 'intervalo inválido')); return undefined }
    const info = sessionOf(req, reply, (req.query as { localId?: unknown }).localId)
    if (!info) return undefined
    return { from, to, projectId: info.projectId }
  }

  const bodyOf = (req: FastifyRequest) => {
    const b = (req.body ?? {}) as { token?: unknown; decisions?: unknown }
    return { token: typeof b.token === 'string' ? b.token : '', decisions: (b.decisions ?? {}) as UndoRequest['decisions'] }
  }

  app.get('/api/undo/terminals/:localId/turns', async (req, reply) => {
    const info = sessionOf(req, reply, (req.params as { localId: string }).localId)
    if (!info) return
    try {
      return await undo.terminalTurns(info)
    } catch (err) { return sendError(reply, err) }
  })

  app.get('/api/undo/turns/:id/files', async (req, reply) => {
    const t = turnOf(req, reply)
    if (!t) return
    try {
      return await undo.turnFiles(t.id, viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })

  app.get('/api/undo/turns/:id/diff', async (req, reply) => {
    const t = turnOf(req, reply)
    if (!t) return
    try {
      return await undo.service.turnDiff(t.id, String((req.query as { path?: unknown }).path ?? ''), viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })

  app.get('/api/undo/intervals/:from/:to/files', async (req, reply) => {
    const iv = intervalOf(req, reply)
    if (!iv) return
    try {
      return await undo.intervalFiles(iv.from, iv.to, iv.projectId, viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })

  app.get('/api/undo/intervals/:from/:to/diff', async (req, reply) => {
    const iv = intervalOf(req, reply)
    if (!iv) return
    try {
      const path = String((req.query as { path?: unknown }).path ?? '')
      return await undo.intervalDiff(iv.from, iv.to, iv.projectId, path, viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })

  app.post('/api/undo/preview', async (req, reply) => {
    const ids = turnsOf(req, reply)
    if (!ids) return
    try {
      return await undo.service.preview(ids, viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })

  app.post('/api/undo/apply', async (req, reply) => {
    const ids = turnsOf(req, reply)
    if (!ids) return
    try {
      return await undo.service.apply(ids, bodyOf(req), viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })

  app.post('/api/undo/runs/:id/redo/preview', async (req, reply) => {
    const id = runOf(req, reply)
    if (id === undefined) return
    try {
      return await undo.service.previewRedo(id, viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })

  app.post('/api/undo/runs/:id/redo', async (req, reply) => {
    const id = runOf(req, reply)
    if (id === undefined) return
    try {
      return await undo.service.redo(id, bodyOf(req), viewerOf(req))
    } catch (err) { return sendError(reply, err) }
  })
}
