import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { Db } from '../db.js'
import type { Config } from '../config.js'
import type { PermissionMode } from '../claude/session.js'
import { createProjectsService } from '../projects.js'
import { createSettingsService } from '../settings.js'
import { canAccessProject, requireProjectAccess } from '../auth/guards.js'
import { hasEngine, DEFAULT_ENGINE_ID, getEngine, listEngines } from '../engine/index.js'

const MODEL_ALLOWLIST = new Set(['fable', 'opus', 'sonnet', 'haiku'])
const PERMISSION_MODES = new Set(['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'])
// Níveis persistíveis do effort ('auto' limpa; 'ultracode' é por sessão — o front não persiste).
// Vão ao argv/config da engine no relaunch, então allowlist estrita — mas
// aberta à união de todas as engines registradas (cada uma tem seus efforts).
function isValidEffort(effort: string): boolean {
  if (effort === 'auto' || effort === 'ultracode') return true
  return listEngines().some((e) => e.capabilities().efforts.includes(effort))
}
/**
 * Máximo de eventos devolvidos pelo histórico/preview (os N mais recentes).
 * Transcripts reais passam de 30 MB / milhares de eventos — renderizar tudo
 * congela o navegador; o operador precisa do fim da conversa, não do começo.
 */
export const HISTORY_EVENT_LIMIT = 300
// Nomes completos (ex.: claude-fable-5, claude-haiku-4-5-20251001): charset
// estrito — vai ao argv do claude, então nada de metachars.
const FULL_MODEL_RE = /^claude-[a-z0-9-]+$/

export function registerSessionRoutes(app: FastifyInstance, deps: { db: Db; manager: SessionManager; config: Config }) {
  const projects = createProjectsService(deps.db)
  const settings = createSettingsService(deps.db)

  // Resolve a sessão e barra acesso a projeto fora da lista do usuário.
  const guardSession = (req: any, reply: any, localId: string) => {
    const info = deps.manager.get(localId)
    if (!info) { reply.code(404).send({ error: 'sessão não existe' }); return undefined }
    if (!requireProjectAccess(req, reply, info.projectId)) return undefined
    return info
  }

  app.get('/api/sessions', async (req) => deps.manager.list().filter((s) => canAccessProject(req.authUser, s.projectId)))

  // Lista de slash commands instalados (capturada de eventos init e persistida),
  // para o autocomplete do chat estar disponível já no carregamento da página.
  app.get('/api/slash-commands', async () => settings.getSlashCommands())

  app.post('/api/projects/:id/sessions', async (req, reply) => {
    const project = projects.get(Number((req.params as { id: string }).id))
    if (!project) return reply.code(404).send({ error: 'projeto não existe' })
    if (!requireProjectAccess(req, reply, project.id)) return
    const body = (req.body ?? {}) as { continueConversation?: boolean; permissionMode?: string; model?: string; engine?: string }
    const engine = body?.engine ?? DEFAULT_ENGINE_ID
    if (!hasEngine(engine)) return reply.code(400).send({ error: 'unknown_engine' })
    // Defesa: model vai ao argv do claude (--model <valor>) — só aceita alias
    // do allowlist ou nome completo com charset seguro; o resto vira Padrão.
    const model = body?.model && (MODEL_ALLOWLIST.has(body.model) || FULL_MODEL_RE.test(body.model))
      ? body.model
      : undefined
    const permissionMode = body?.permissionMode && PERMISSION_MODES.has(body.permissionMode)
      ? (body.permissionMode as PermissionMode)
      : 'bypassPermissions'
    try {
      return reply.code(201).send(deps.manager.start(project, {
        continueLatest: body?.continueConversation ?? true,
        permissionMode,
        model,
        engine,
      }))
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message })
    }
  })

  app.patch('/api/sessions/:localId/options', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    if (!guardSession(req, reply, localId)) return
    const body = (req.body ?? {}) as { model?: string; permissionMode?: string; effort?: string }
    const model = body.model && (MODEL_ALLOWLIST.has(body.model) || FULL_MODEL_RE.test(body.model)) ? body.model : undefined
    if (body.permissionMode !== undefined && !PERMISSION_MODES.has(body.permissionMode)) {
      return reply.code(400).send({ error: 'modo de permissão inválido' })
    }
    if (body.effort !== undefined && !isValidEffort(body.effort)) {
      return reply.code(400).send({ error: 'nível de effort inválido' })
    }
    try {
      return await deps.manager.setSessionOptions(localId, { model, permissionMode: body.permissionMode as PermissionMode | undefined, effort: body.effort })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.post('/api/sessions/:localId/stop', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    if (!guardSession(req, reply, localId)) return
    await deps.manager.stop(localId)
    return reply.code(204).send()
  })

  app.post('/api/sessions/:localId/revive', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    if (!guardSession(req, reply, localId)) return
    try {
      return deps.manager.revive(localId)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/api/sessions/:localId/history', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    const info = deps.manager.get(localId)
    if (!info) return reply.code(404).send({ error: 'sessão não existe' })
    if (!requireProjectAccess(req, reply, info.projectId)) return
    const project = projects.get(info.projectId)
    if (!project) return []
    const engine = getEngine(info.engine as string)
    if (!info.engineSessionId) {
      // Preview: sessão iniciada com --continue ainda não emitiu o init (só vem
      // com a 1ª mensagem), mas o operador precisa se contextualizar. Mostra a
      // conversa que o --continue vai retomar (conversa mais recente da pasta).
      const row = deps.db.prepare('SELECT continue_latest FROM sessions WHERE local_id=?').get(localId) as any
      if (!row?.continue_latest) return []
      const prev = engine.latestConversationId(project.path)
      return prev ? engine.readHistory(project.path, prev).slice(-HISTORY_EVENT_LIMIT) : []
    }
    return engine.readHistory(project.path, info.engineSessionId).slice(-HISTORY_EVENT_LIMIT)
  })
}
