import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { Db } from '../db.js'
import type { Config } from '../config.js'
import type { PermissionMode } from '../claude/session.js'
import { createProjectsService } from '../projects.js'
import { createSettingsService } from '../settings.js'
import { canAccessProject, requireAdmin, requireProjectAccess } from '../auth/guards.js'
import { hasEngine, DEFAULT_ENGINE_ID, getEngine, listEngines } from '../engine/index.js'

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

// Modelo válido = id declarado nas capabilities DA ENGINE da sessão ('' = Padrão,
// limpa o model salvo). Cada engine tem seus ids (kimi-code/k3, gpt-5.6-sol...) —
// validar contra o allowlist do Claude descartava o model das outras engines
// silenciosamente. Claude aceita também o nome completo (claude-*) por compat com
// clientes da API. Valor inválido → undefined ("não toca" no PATCH / vira Padrão
// no POST) — defesa: o model vai ao argv da engine.
function sanitizeModel(engineId: string, model: string | undefined): string | undefined {
  if (model === undefined || model === '') return model
  if (getEngine(engineId).capabilities().models.includes(model)) return model
  if (engineId === DEFAULT_ENGINE_ID && FULL_MODEL_RE.test(model)) return model
  return undefined
}

export function registerSessionRoutes(app: FastifyInstance, deps: {
  db: Db
  manager: SessionManager
  config: Config
  /**
   * Necessário para encerrar uma sessão ABERTA NO TERMINAL: ela sai do mapa
   * `live` do manager quando vai para o PTY, então manager.stop() não a alcança.
   */
  terminalManager?: { closeAndWait(localId: string, timeoutMs?: number): Promise<void> }
}) {
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

  // Auto-compact: limiar em % da janela de contexto (0 = desligado), global da
  // instalação (kv settings) — o manager o lê a cada result. PUT é admin-only:
  // muda o comportamento das sessões de TODOS.
  app.get('/api/auto-compact', async () => ({ pct: Number(settings.get('autoCompactPct') || 0) }))
  app.put('/api/auto-compact', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const pct = Number((req.body as { pct?: unknown })?.pct)
    if (!Number.isInteger(pct) || pct < 0 || pct > 95) {
      return reply.code(400).send({ error: 'pct deve ser 0 (desligado) ou um inteiro de 1 a 95' })
    }
    settings.set('autoCompactPct', pct > 0 ? String(pct) : '')
    return { pct }
  })

  app.post('/api/projects/:id/sessions', async (req, reply) => {
    const project = projects.get(Number((req.params as { id: string }).id))
    if (!project) return reply.code(404).send({ error: 'projeto não existe' })
    if (!requireProjectAccess(req, reply, project.id)) return
    const body = (req.body ?? {}) as { continueConversation?: boolean; permissionMode?: string; model?: string; engine?: string }
    const engine = body?.engine ?? DEFAULT_ENGINE_ID
    if (!hasEngine(engine)) return reply.code(400).send({ error: 'unknown_engine' })
    // Defesa: model vai ao argv da engine — só aceita id das capabilities dela
    // ('' = Padrão, equivale a não mandar model na criação).
    const model = sanitizeModel(engine, body?.model) || undefined
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
    const info = guardSession(req, reply, localId)
    if (!info) return
    const body = (req.body ?? {}) as { model?: string; permissionMode?: string; effort?: string }
    // '' explícito = voltar ao Padrão (limpa o model); inválido = não toca.
    const model = sanitizeModel(info.engine as string, body.model)
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
    const info = guardSession(req, reply, localId)
    if (!info) return
    // No terminal quem segura o processo é o PTY: a sessão saiu do `live` ao ser
    // aberta lá, e manager.stop() (que só olha o `live`) virava um no-op
    // silencioso — o ⏻ não fazia nada. Fechar o PTY dispara o onExit, que já
    // marca a sessão como stopped e avisa os clientes.
    if (info.status === 'in_terminal' && deps.terminalManager) {
      await deps.terminalManager.closeAndWait(localId)
      return reply.code(204).send()
    }
    await deps.manager.stop(localId)
    return reply.code(204).send()
  })

  // Parar UM subagente de background (o ✕ do chip na faixa de subagentes), sem
  // derrubar a sessão nem os outros subagentes.
  app.post('/api/sessions/:localId/tasks/:taskId/stop', async (req, reply) => {
    const { localId, taskId } = req.params as { localId: string; taskId: string }
    if (!guardSession(req, reply, localId)) return
    await deps.manager.stopBackgroundTask(localId, taskId)
    return reply.code(204).send()
  })

  // Reautenticação do Claude sem sair da web: `startAuth` devolve as URLs do
  // fluxo OAuth e `completeAuth` fecha com o código que o operador trouxe.
  app.post('/api/sessions/:localId/auth/start', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    if (!guardSession(req, reply, localId)) return
    try {
      return await deps.manager.startAuth(localId)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.post('/api/sessions/:localId/auth/complete', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    if (!guardSession(req, reply, localId)) return
    const code = (req.body as { code?: unknown })?.code
    if (typeof code !== 'string' || !code.trim()) return reply.code(400).send({ error: 'código ausente' })
    try {
      await deps.manager.completeAuth(localId, code.trim())
      return reply.code(204).send()
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
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
      return prev ? (await engine.readHistory(project.path, prev)).slice(-HISTORY_EVENT_LIMIT) : []
    }
    return (await engine.readHistory(project.path, info.engineSessionId)).slice(-HISTORY_EVENT_LIMIT)
  })
}
