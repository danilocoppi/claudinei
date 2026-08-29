import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { Config } from './config.js'
import type { Db } from './db.js'
import type { SessionManager } from './claude/manager.js'
import type { WsHub } from './routes/ws.js'
import type { TerminalManager } from './terminal/manager.js'
import type { SpeechService } from './speech/transcriber.js'
import type { UsageService } from './usage.js'
import type { EngineUsageService } from './engine-usage.js'
import type { AuthService } from './auth/index.js'
import { registerAuth } from './auth/plugin.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerEngineRoutes } from './routes/engines.js'
import { registerHermesRoutes } from './routes/hermes.js'
import { registerOrchestratorRoutes } from './routes/orchestrator.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerGroupRoutes } from './routes/groups.js'
import { registerFileRoutes } from './routes/files.js'
import { createProjectsService } from './projects.js'
import { registerTerminalRoutes } from './routes/terminal.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerTranscribeRoutes } from './routes/transcribe.js'
import { registerUsageRoutes } from './routes/usage.js'
import { registerScheduleRoutes } from './routes/schedules.js'
import { registerPrefsRoutes } from './routes/prefs.js'
import { registerLocalAppRoutes, type LocalAppsRouteDeps } from './routes/local-apps.js'
import { registerIconRoutes } from './routes/icons.js'
import { registerActionRoutes } from './routes/actions.js'
import { createActionsStore } from './actions.js'
import { createIconService } from './icons/service.js'
import type { IconifyDeps } from './icons/iconify.js'
import { createPrefsService } from './prefs.js'
import { createSettingsService } from './settings.js'
import { createSchedulesStore } from './schedules/store.js'
import { createScheduler, type Scheduler } from './schedules/scheduler.js'
import { registerStatic } from './static.js'

export interface AppDeps {
  config: Config
  db: Db
  manager: SessionManager
  wsHub?: WsHub
  terminalManager?: TerminalManager
  speech?: Pick<SpeechService, 'installed' | 'transcribe'>
  usage?: Pick<UsageService, 'getLimits'>
  /** Limites de plano de outros provedores (Kimi) — misturados na mesma lista do /api/usage. */
  extraUsage?: Array<Pick<UsageService, 'getLimits'>>
  /** Acumulador de tokens por engine (Codex etc.) exposto ao lado dos limites de plano em /api/usage. */
  engineUsage?: Pick<EngineUsageService, 'all'>
  /** Caminho absoluto de web/dist (SPA buildado). Se ausente, o static não é registrado. */
  webDist?: string
  /**
   * Callback setter: chamado com o `drain(projectId)` do orchestrator assim
   * que a rota é registrada. O manager é construído em index.ts ANTES do
   * buildApp (precisa existir para as demais rotas), então não há como
   * passar `drain` a ele por deps na criação — em vez disso index.ts guarda
   * uma referência mutável e a preenche aqui, conectando
   * manager.onSessionAvailable → drain sem inverter a ordem de construção.
   */
  onOrchestratorReady?: (drain: (projectId: number) => void) => void
  /** Auth multi-usuário. Ausente (testes legados) = sem auth: comportamento aberto de sempre. */
  auth?: AuthService
  /** --insecure da CLI: pré-setup, libera também IPs não-loopback (rede confiável, por conta e risco). */
  insecure?: boolean
  /** Pós revoke-all: derruba todos os WS. */
  onRevokeAll?: () => void
  /** Tokens/permissões de um usuário mudaram: derruba os WS dele. */
  onUserInvalidated?: (userId: number) => void
  /** Abrir pasta/editor/terminal do host. Injetável para o teste não abrir janelas. */
  localApps?: Omit<LocalAppsRouteDeps, 'projects' | 'settings'>
  /** Recebe o agendador assim que ele nasce, para index.ts pará-lo no shutdown. */
  onSchedulerReady?: (scheduler: Scheduler) => void
  /** Acervo de ícones (Iconify). Injetável para o teste não falar com a internet. */
  iconify?: IconifyDeps
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)
  if (deps.auth) {
    await registerAuth(app, { auth: deps.auth, insecure: deps.insecure })
    registerAuthRoutes(app, { auth: deps.auth, onRevokeAll: deps.onRevokeAll, onUserInvalidated: deps.onUserInvalidated })
  }

  app.get('/api/health', async () => ({ ok: true }))
  registerProjectRoutes(app, { db: deps.db, manager: deps.manager })
  registerSessionRoutes(app, deps)
  registerEngineRoutes(app)
  registerHermesRoutes(app, { db: deps.db, manager: deps.manager, broadcast: deps.wsHub?.broadcast })
  const { drain } = registerOrchestratorRoutes(app, { db: deps.db, manager: deps.manager, broadcast: deps.wsHub?.broadcast })
  deps.onOrchestratorReady?.(drain)
  registerFsRoutes(app)
  registerGroupRoutes(app, { db: deps.db })
  registerPrefsRoutes(app, { prefs: createPrefsService(deps.db) })
  registerLocalAppRoutes(app, {
    projects: createProjectsService(deps.db), settings: createSettingsService(deps.db), ...deps.localApps,
  })
  registerIconRoutes(app, { icons: createIconService(deps.db, deps.iconify) })
  if (deps.terminalManager) {
    registerActionRoutes(app, {
      actions: createActionsStore(deps.db),
      projects: createProjectsService(deps.db),
      terminalManager: deps.terminalManager,
      broadcast: deps.wsHub?.broadcast,
    })
  }
  // O agendador nasce aqui porque precisa do manager E do broadcast, que só existem
  // montados. index.ts recebe a referência para parar o laço no shutdown.
  const schedulesStore = createSchedulesStore(deps.db, { dir: deps.config.schedulesDir })
  const scheduler = createScheduler({
    db: deps.db, store: schedulesStore, manager: deps.manager, broadcast: deps.wsHub?.broadcast,
  })
  registerScheduleRoutes(app, { db: deps.db, store: schedulesStore, scheduler, broadcast: deps.wsHub?.broadcast })
  deps.onSchedulerReady?.(scheduler)
  registerFileRoutes(app, { projects: createProjectsService(deps.db) })
  await registerUploadRoutes(app, { uploadsDir: deps.config.uploadsDir })
  if (deps.speech) await registerTranscribeRoutes(app, { speech: deps.speech, uploadsDir: deps.config.uploadsDir })
  if (deps.usage) await registerUsageRoutes(app, { usage: deps.usage, extraUsage: deps.extraUsage, engineUsage: deps.engineUsage })
  if (deps.terminalManager) registerTerminalRoutes(app, { manager: deps.manager, terminalManager: deps.terminalManager })
  if (deps.wsHub) deps.wsHub.register(app, { manager: deps.manager, db: deps.db })

  // Static (SPA) por ÚLTIMO: garante que as rotas /api já existem antes do
  // notFoundHandler entrar em cena (o fallback SPA usa setNotFoundHandler).
  if (deps.webDist) await registerStatic(app, deps.webDist)

  return app
}
