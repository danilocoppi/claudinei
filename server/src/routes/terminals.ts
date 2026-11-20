import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { canAccessProject, requireProjectAccess } from '../auth/guards.js'
import { hasEngine } from '../engine/index.js'
import { errorBody, fail, UserError } from '../user-error.js'
import type { RestartService } from '../restart/boot.js'
import type { UsageLimitService } from '../limit/usage-limit.js'
import { createTerminalStateStore, toDto } from '../restart/terminal-state.js'

/** Ações sobre o aviso do limite de uso. */
const LIMIT_ACTIONS = ['arm', 'snooze', 'cancel', 'continue'] as const
type LimitActionBody = typeof LIMIT_ACTIONS[number]
/** Recusas do serviço do limite que são estado do terminal, não falha: 409. */
const LIMIT_CONFLICTS = new Set(['no_usage_limit', 'reset_unknown', 'session_busy'])

/**
 * Reinício sem prejuízo e limite de uso, por terminal (projeto + motor): os
 * interruptores, o Continuar e o fechar do aviso do reinício, as ações sobre o
 * aviso do limite e a lista que a interface lê ao abrir. As mudanças vão às
 * telas pelos próprios serviços, como `{ type: 'terminal_state', state }`.
 */
export function registerTerminalStateRoutes(
  app: FastifyInstance,
  deps: { db: Db; restart: RestartService; limit: UsageLimitService },
) {
  const projects = createProjectsService(deps.db)
  const store = createTerminalStateStore(deps.db)

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

  /**
   * Serviço encerrando: a marca que o encerramento acabou de gravar não pode sair
   * agora. Devolve `true` se já respondeu o 409.
   */
  const refuseWhileShuttingDown = (reply: FastifyReply): boolean => {
    if (!deps.restart.isShuttingDown()) return false
    reply.code(409).send(fail('shutting_down', 'o Claudinei está reiniciando; tente de novo quando ele voltar'))
    return true
  }

  app.get('/api/terminals/state', async (req) =>
    deps.restart.list().filter((s) => canAccessProject(req.authUser, s.projectId)))

  app.patch('/api/projects/:id/terminals/:engine/restart', async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    const body = (req.body ?? {}) as { autostart?: unknown; autoResume?: unknown; autoResumeLimit?: unknown }
    const prefs: { autostart?: boolean; autoResume?: boolean; autoResumeLimit?: boolean } = {}
    for (const key of ['autostart', 'autoResume', 'autoResumeLimit'] as const) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean') return reply.code(400).send({ error: `${key} deve ser booleano` })
      prefs[key] = body[key]
    }
    if (Object.keys(prefs).length === 0) {
      return reply.code(400).send({ error: 'informe autostart, autoResume ou autoResumeLimit (booleano)' })
    }
    return deps.restart.setPrefs(t.projectId, t.engine, prefs)
  })

  app.post('/api/projects/:id/terminals/:engine/continue', async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    if (refuseWhileShuttingDown(reply)) return
    try {
      if (!deps.restart.resumeTerminal(t.projectId, t.engine)) {
        return reply.code(409).send(fail('nothing_to_continue', 'não há trabalho interrompido para continuar'))
      }
    } catch (err) {
      // Sessão no meio de um turno: a marca fica, e o operador tenta quando o turno acabar.
      if (err instanceof UserError && err.code === 'session_busy') return reply.code(409).send(errorBody(err))
      // O revive (ou o envio) falhou: a marca fica, e o erro vai à tela como no revive comum.
      return reply.code(400).send(errorBody(err))
    }
    return { ok: true }
  })

  /**
   * Ações sobre o aviso do limite de uso: armar a retomada na reabertura, adiar
   * o aviso até ela, cancelar (de armado ou adiado o aviso volta; de `none` ele
   * sai) e continuar agora. Devolve o estado do terminal; o serviço já o
   * publicou às telas.
   */
  app.post('/api/projects/:id/terminals/:engine/limit', async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    const action = ((req.body ?? {}) as { action?: unknown }).action
    if (typeof action !== 'string' || !(LIMIT_ACTIONS as readonly string[]).includes(action)) {
      return reply.code(400).send({ error: `action deve ser ${LIMIT_ACTIONS.join(', ')}` })
    }
    // Encerrando, o relógio do limite já parou: o que o operador decidir agora
    // fica para depois que o Claudinei voltar, como no Continuar do reinício.
    if (refuseWhileShuttingDown(reply)) return
    try {
      switch (action as LimitActionBody) {
        case 'arm': deps.limit.arm(t.projectId, t.engine); break
        case 'snooze': deps.limit.snooze(t.projectId, t.engine); break
        case 'cancel': deps.limit.cancel(t.projectId, t.engine); break
        case 'continue':
          // `false` é o serviço encerrando (como no Continuar do reinício) ou,
          // fora dele, outro caminho que já levou o limite.
          if (!deps.limit.continueNow(t.projectId, t.engine)) {
            if (refuseWhileShuttingDown(reply)) return
            return reply.code(409).send(fail('no_usage_limit', 'o terminal não está no limite de uso'))
          }
          break
      }
    } catch (err) {
      if (err instanceof UserError && LIMIT_CONFLICTS.has(err.code)) return reply.code(409).send(errorBody(err))
      // O revive (ou o envio) falhou: o aviso fica, e o erro vai à tela como no revive comum.
      return reply.code(400).send(errorBody(err))
    }
    return toDto(store.get(t.projectId, t.engine))
  })

  app.delete('/api/projects/:id/terminals/:engine/interruption', async (req, reply) => {
    const t = target(req, reply)
    if (!t) return
    if (refuseWhileShuttingDown(reply)) return
    deps.restart.dismiss(t.projectId, t.engine)
    return { ok: true }
  })
}
