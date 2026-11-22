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
import type { UsageIndexer } from './usage-index/indexer.js'
import type { AuthService } from './auth/index.js'
import { registerAuth, registerSecurityHeaders } from './auth/plugin.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerHistorySearchRoutes } from './routes/history-search.js'
import { registerEngineRoutes } from './routes/engines.js'
import { registerHermesRoutes } from './routes/hermes.js'
import { registerProgressRoutes } from './routes/progress.js'
import { createProgressStore } from './progress.js'
import { registerOrchestratorRoutes, type OrchestratorHooks } from './routes/orchestrator.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerGroupRoutes } from './routes/groups.js'
import { registerFileRoutes } from './routes/files.js'
import { createProjectsService } from './projects.js'
import { registerTerminalRoutes } from './routes/terminal.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerTranscribeRoutes } from './routes/transcribe.js'
import { registerUsageRoutes } from './routes/usage.js'
import { registerUsageReportRoutes } from './routes/usage-report.js'
import { registerScheduleRoutes } from './routes/schedules.js'
import { registerPrefsRoutes } from './routes/prefs.js'
import { registerTriageRoutes } from './routes/triage.js'
import { createTriageStore } from './triage/store.js'
import { createTriageWaker, type TriageWaker } from './triage/wake.js'
import { registerLocalAppRoutes, type LocalAppsRouteDeps } from './routes/local-apps.js'
import { registerIconRoutes } from './routes/icons.js'
import { registerActionRoutes } from './routes/actions.js'
import { createActionsStore } from './actions.js'
import { createIconService } from './icons/service.js'
import type { IconifyDeps } from './icons/iconify.js'
import { createPrefsService } from './prefs.js'
import { createSettingsService } from './settings.js'
import { createSchedulesStore } from './schedules/store.js'
import { createScheduler, UNDO_HELD_TEXT, type Scheduler } from './schedules/scheduler.js'
import { registerStatic } from './static.js'
import { registerTerminalStateRoutes } from './routes/terminals.js'
import { createTerminalStateStore } from './restart/terminal-state.js'
import { createRestartService, type RestartService } from './restart/boot.js'
import { createUsageLimitService, type UsageLimitService } from './limit/usage-limit.js'
import { createOperatorQueueService, createOperatorQueueStore, type OperatorQueueService } from './queue/operator-queue.js'
import { createNextSend, holdsForNotice, holdsForSchedule, type NextSend } from './queue/next-send.js'
import { registerOperatorQueueRoutes } from './routes/operator-queue.js'
import { createTaskWake, type TaskWake } from './delegate/task-wake.js'
import { createGoalService, type GoalService } from './goal/goal.js'
import { getEngine } from './engine/index.js'
import { createBranchService, type BranchService, type SideTestDeps } from './branch/service.js'
import { registerBranchRoutes } from './routes/branch.js'
import { createUndo, type Undo } from './undo/index.js'
import { registerUndoRoutes } from './routes/undo.js'
import { createPagesService, registerPageRoutes, type PagesService } from './pages/service.js'
import { readNetwork } from './pages/settings.js'
import type { BrowserHost } from './browser/host.js'
import { createBrowserFeature, type BrowserFeature } from './browser/feature.js'
import { registerLocalServerRoutes } from './local-servers/routes.js'

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
  /**
   * Indexador dos históricos locais (Claude e Codex): a rota do relatório só lê o `status()`
   * dele. Ausente (testes) → a rota continua lá, com o índice dado como parado.
   */
  usageIndexer?: Pick<UsageIndexer, 'status'>
  /** Navegador do 16 (o Chromium do serviço); o 15 usa `withIsolatedPage`. */
  browserHost?: BrowserHost
  /** Recebe o navegador embutido montado (com `browserHost`): index.ts o chama na revogação. */
  onBrowserReady?: (browser: BrowserFeature) => void
  /** Caminho absoluto de web/dist (SPA buildado). Se ausente, o static não é registrado. */
  webDist?: string
  /**
   * Callback setter: chamado com os ganchos do orchestrator (`drain`,
   * `reattach`, `failInterrupted`) assim que a rota é registrada. O manager é
   * construído em index.ts ANTES do buildApp (precisa existir para as demais
   * rotas), então não há como
   * passar `drain` a ele por deps na criação — em vez disso index.ts guarda
   * uma referência mutável e a preenche aqui, conectando
   * manager.onSessionAvailable → drain sem inverter a ordem de construção.
   */
  onOrchestratorReady?: (orchestrator: OrchestratorHooks) => void
  /** Auth multi-usuário. Ausente (testes legados) = sem auth: comportamento aberto de sempre. */
  auth?: AuthService
  /** --insecure da CLI: pré-setup, libera também IPs não-loopback (rede confiável, por conta e risco). */
  insecure?: boolean
  /** --behind-proxy: há um reverse proxy na frente, então loopback não é mais prova de "dono na máquina". */
  behindProxy?: boolean
  /** Certificado/chave já lidos (ver tls.ts). Presente = o servidor fala HTTPS. */
  https?: { cert: Buffer; key: Buffer }
  /**
   * A conexão do navegador é HTTPS? Decide `Secure` no cookie e o HSTS.
   *
   * Segue o TRANSPORTE, não a topologia: vale tanto para TLS nativo (`https`
   * aqui) quanto para TLS terminado num proxy (`behindProxy`). Marcar `Secure`
   * em HTTP puro quebraria o login — o navegador não devolveria o cookie.
   */
  secureTransport?: boolean
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
  /**
   * Recebe o serviço do reinício assim que ele nasce. Mesmo motivo do
   * `onOrchestratorReady`: o manager já existe, e os ganchos dele
   * (`onTurnResult`, `onOperatorMessage`) leem uma referência que index.ts
   * preenche aqui. index.ts também roda a subida (`boot`) depois do listen.
   */
  onRestartReady?: (restart: RestartService) => void
  /**
   * Recebe o despertador da triagem assim que ele nasce. Mesmo motivo do
   * `onRestartReady`: o gancho `onNeedsOperator` do manager lê uma referência
   * que index.ts preenche aqui.
   */
  onTriageWakerReady?: (waker: TriageWaker) => void
  /**
   * Recebe o serviço do limite de uso, pelo mesmo motivo do `onRestartReady`:
   * os ganchos do manager (`onUsageLimit`, `onTurnResult`, `onOperatorMessage`)
   * leem a referência que index.ts preenche aqui. index.ts roda a subida dele
   * (`boot`) depois da do reinício e o desliga (`dispose`) no encerramento.
   */
  onLimitReady?: (limit: UsageLimitService) => void
  /**
   * Recebe o árbitro do próximo envio, pelo mesmo motivo do `onOrchestratorReady`:
   * o `onSessionAvailable` do manager (com a sessão que ficou livre) lê a
   * referência que index.ts preenche aqui. A integração registra nele os lugares
   * 4 e 6 (`register`).
   */
  onNextSendReady?: (nextSend: NextSend) => void
  /**
   * Recebe a fila do operador: os ganchos `onTurnResult` e `onSessionDied` do
   * manager leem a referência que index.ts preenche aqui (a fila pausa no erro,
   * na interrupção pelo operador e na morte da sessão; o limite de uso não
   * pausa, quem segura a fila é o aviso do limite).
   */
  onQueueReady?: (queue: OperatorQueueService) => void
  /**
   * Recebe o aviso de resultado de tarefa delegada (lugar 4 do árbitro), pelo
   * mesmo motivo do `onRestartReady`: o fim de turno do manager lê a referência
   * que index.ts preenche aqui, e a subida dele (`boot`) roda depois do listen.
   */
  onTaskWakeReady?: (taskWake: TaskWake) => void
  /**
   * Recebe o serviço do goal (lugar 6 do árbitro): o fim de turno, a mensagem
   * do operador e o `/goal` interceptado no manager leem a referência que
   * index.ts preenche aqui.
   */
  onGoalReady?: (goal: GoalService) => void
  /**
   * Recebe o serviço de ramificar a conversa (a lateral), pelo mesmo motivo do
   * `onRestartReady`: o fim da sessão principal no manager fecha a lateral pela
   * referência que index.ts preenche aqui. index.ts roda a limpeza da subida
   * (`bootCleanup`) depois do listen e o `dispose` no encerramento.
   */
  onBranchReady?: (branch: BranchService) => void
  /** Sessões e corte da lateral. Injetável para o teste não abrir as CLIs nem ler o storage real. */
  branchTest?: SideTestDeps
  /**
   * Recebe o conjunto do desfazer turno: o `turnObserver` do manager lê a
   * referência que index.ts preenche aqui, e a subida dele (`boot`) roda depois
   * do listen, antes de religar as sessões.
   */
  onUndoReady?: (undo: Undo) => void
  /**
   * Varre a pasta das páginas na subida (index.ts). Fora do serviço (testes,
   * ensaio com outro banco), a pasta padrão é a do serviço instalado, e a
   * varredura apagaria as páginas dele por não ter as linhas.
   */
  sweepPages?: boolean
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Respostas visuais: nasce depois do desfazer (o turno aberto vem dele).
  let pages: PagesService | undefined
  // O Fastify decide entre http e https no CONSTRUTOR, e tipa o servidor de forma
  // diferente em cada caso — daí os dois ramos e o cast. A API que usamos daqui
  // para baixo é idêntica nos dois (rotas, hooks, listen, server.address()).
  const app = (deps.https
    ? Fastify({ logger: false, https: deps.https })
    : Fastify({ logger: false })) as unknown as FastifyInstance
  await app.register(websocket)
  // FORA do `if (deps.auth)`: a decoração precisa existir mesmo sem auth
  // configurada (modo pré-setup). Dentro, `req.behindProxy` ficava undefined e
  // `isTrustedLocal` voltava a valer como `isLocalRequest` — o que reabria o
  // `!comando` e as rotas de host para quem chegasse pelo proxy.
  app.decorateRequest('behindProxy', !!deps.behindProxy)
  const seguro = deps.secureTransport ?? (!!deps.https || !!deps.behindProxy)
  registerSecurityHeaders(app, seguro)
  if (deps.auth) {
    await registerAuth(app, { auth: deps.auth, insecure: deps.insecure, behindProxy: deps.behindProxy, secureTransport: seguro })
    registerAuthRoutes(app, { auth: deps.auth, onRevokeAll: deps.onRevokeAll, onUserInvalidated: deps.onUserInvalidated, secureTransport: seguro })
  }

  app.get('/api/health', async () => ({ ok: true }))
  const triage = createTriageStore(deps.db)
  registerProjectRoutes(app, {
    db: deps.db, manager: deps.manager, terminalManager: deps.terminalManager, scratchDir: deps.config.scratchDir,
    triage, broadcast: deps.wsHub?.broadcast,
    onRemoving: (projectId) => pages?.removeProject(projectId),
  })
  registerTriageRoutes(app, { store: triage, db: deps.db, broadcast: deps.wsHub?.broadcast })
  const triageWaker = createTriageWaker({ store: triage, broadcast: (m) => deps.wsHub?.broadcast(m) })
  deps.onTriageWakerReady?.(triageWaker)
  registerSessionRoutes(app, deps)
  registerHistorySearchRoutes(app, { db: deps.db, manager: deps.manager })
  registerEngineRoutes(app)
  // O aviso de resultado e o goal nascem com o reinício, mais abaixo; as rotas
  // do Hermes (goal_done) e o orchestrator (fim de tarefa) leem as referências.
  let taskWake: TaskWake | undefined
  let goal: GoalService | undefined
  // O estado dos terminais (aviso do reinício, limite de uso) nasce antes do
  // Hermes e do orchestrator: com aviso aberto, nem a fila, nem as tarefas de
  // outros agentes, nem as perguntas (ask_agent), nem os agendamentos chegam ao
  // terminal. O encerramento do serviço segura também: entregar agora mandaria
  // a mensagem a um processo que vai ser derrubado.
  const terminalState = createTerminalStateStore(deps.db)
  // O desfazer turno: a escrita de um desfazer segura o terminal (o árbitro não
  // entrega nada no repositório) e, no fim, cutuca o árbitro dos terminais dele.
  let nextSendRef: NextSend | undefined
  // A lateral nasce depois (com o ramificar): o desfazer a lê pela referência.
  let branchRef: BranchService | undefined
  const undo = createUndo({
    db: deps.db, manager: deps.manager, projects: createProjectsService(deps.db),
    broadcast: (m) => deps.wsHub?.broadcast(m),
    poke: (projectId, engine) => nextSendRef?.poke(projectId, engine),
    sides: () => branchRef?.side.working() ?? [],
    onTurnsRewound: (ids) => pages?.onTurnsRewound(ids),
    onTurnsRelabeled: (ids, conversationId) => pages?.onTurnsRelabeled(ids, conversationId),
  })
  registerUndoRoutes(app, { undo, manager: deps.manager, db: deps.db })
  deps.onUndoReady?.(undo)
  const holds = (projectId: number, engine: string): boolean =>
    deps.manager.isShuttingDown() || holdsForNotice(terminalState.get(projectId, engine)) || undo.holds(projectId, engine)
  registerHermesRoutes(app, {
    db: deps.db, manager: deps.manager, broadcast: deps.wsHub?.broadcast, goal: () => goal,
    canTake: (projectId, engine) => !holds(projectId, engine),
  })
  registerProgressRoutes(app, { db: deps.db, store: createProgressStore({ dir: deps.config.progressDir }), broadcast: deps.wsHub?.broadcast })
  const orchestrator = registerOrchestratorRoutes(app, {
    db: deps.db, manager: deps.manager, broadcast: deps.wsHub?.broadcast,
    canTake: (projectId, engine) => !holds(projectId, engine),
    onTaskEnded: (taskId) => taskWake?.onTaskEnded(taskId),
  })
  deps.onOrchestratorReady?.(orchestrator)
  // A fila do operador e o árbitro do próximo envio: depois do orchestrator (o
  // lugar 5 é ele) e antes do reinício (que cutuca o árbitro quando o aviso sai).
  const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])
  const liveLocalId = (projectId: number, engine: string): string | null =>
    deps.manager.list().find((s) => s.projectId === projectId && s.engine === engine && ACTIVE.has(s.status))?.localId ?? null
  // Respostas visuais (show_page): a conversa é a da sessão viva do terminal; o turno, o trecho aberto do desfazer.
  pages = createPagesService({
    db: deps.db, dir: deps.config.pagesDir, projects: createProjectsService(deps.db),
    liveSession: (projectId, engine) => {
      const s = deps.manager.list().find((x) => x.projectId === projectId && x.engine === engine && ACTIVE.has(x.status))
      return s ? { localId: s.localId, engineSessionId: s.engineSessionId ?? null } : undefined
    },
    openTurn: (localId) => {
      const turnId = undo.tracker.openSegment(localId)
      return turnId === undefined ? undefined : { turnId, turnKey: undo.store.turn(turnId)?.textKey ?? null }
    },
    broadcast: (m) => deps.wsHub?.broadcast(m),
  })
  // Na subida do serviço, uma vez: arquivo sem linha, temporário esquecido e linha sem arquivo.
  if (deps.sweepPages) {
    try {
      pages.sweep()
    } catch (e) {
      console.error(`[páginas] varredura da subida falhou: ${(e as Error).message}`)
    }
  }
  const pageSettings = createSettingsService(deps.db)
  registerPageRoutes(app, { pages, manager: deps.manager, settings: pageSettings, network: () => readNetwork(pageSettings), browserHost: deps.browserHost })
  const queueStore = createOperatorQueueStore(deps.db)
  const queue = createOperatorQueueService({
    store: queueStore, manager: deps.manager,
    broadcast: (m) => deps.wsHub?.broadcast(m),
    holds,
    acceptsMidTurn: (engine) => !!getEngine(engine).capabilities().midTurnInput,
    liveLocalId,
    isShuttingDown: () => deps.manager.isShuttingDown(),
  })
  const nextSend = createNextSend({
    providers: [
      { name: 'operator-queue', slot: 3, offer: (ctx) => queue.offer(ctx) },
      { name: 'agent-tasks', slot: 5, offer: (ctx) => orchestrator.drain(ctx.projectId, ctx.localId) },
    ],
    holds,
    // Viva e não-working, como o hasFreeSession de sempre: a sessão revivida na
    // subida fica em `starting` até a 1ª mensagem e precisa receber o que esperou.
    // Com a auto-compactação decidida e ainda não aberta, não está livre: um
    // cutucão na mesma folga (o estado publicado no fim do turno) passaria na
    // frente dela (lugar 1).
    isFree: (localId) => {
      const s = deps.manager.get(localId)
      return !!s && deps.manager.hasFreeSession(s.projectId, { localId }) && !deps.manager.compactionPending(localId)
    },
    liveLocalId,
  })
  nextSendRef = nextSend
  registerOperatorQueueRoutes(app, { db: deps.db, queue, store: queueStore })
  deps.onQueueReady?.(queue)
  deps.onNextSendReady?.(nextSend)
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
    // Só o reinício esperando e a janela do limite fechada (o encerramento já
    // para o laço e fecha as execuções na subida). O aviso do limite que ficou
    // depois da reabertura não segura: o turno bom do agendamento o tira.
    // A escrita de um desfazer também segura (R19): pulada sem contar falha, em
    // vez de bater no `undo_writing` do rastreador e contar como erro.
    holds: (projectId, engine) => holdsForSchedule(terminalState.get(projectId, engine))
      || (undo.holds(projectId, engine) ? UNDO_HELD_TEXT : false),
  })
  registerScheduleRoutes(app, { db: deps.db, store: schedulesStore, scheduler, broadcast: deps.wsHub?.broadcast })
  deps.onSchedulerReady?.(scheduler)
  // O reinício nasce depois do orchestrator (religa as tarefas do turno
  // interrompido) e dos agendamentos (fecha as execuções que o reinício matou).
  // O broadcast do reinício (e do limite, que publica por ele) cutuca o árbitro:
  // o aviso que sai (×, Continuar, limite que reabre) libera o terminal. Na
  // microtask, e não aqui dentro: quem publica pode estar no meio do result de
  // um turno ou logo antes de mandar a retomada, e o árbitro reconfere a sessão.
  const publishTerminalState = (m: object): void => {
    deps.wsHub?.broadcast(m)
    const state = (m as { type?: string; state?: { projectId: number; engine: string } }).type === 'terminal_state'
      ? (m as { state: { projectId: number; engine: string } }).state : undefined
    if (!state) return
    queueMicrotask(() => {
      // Erro aqui seria uma exceção sem dono (derruba o processo): só no log.
      try { nextSend.poke(state.projectId, state.engine) } catch (err) { console.error('[próximo envio] cutucar falhou', err) }
    })
  }
  const restart = createRestartService({
    db: deps.db, manager: deps.manager, store: terminalState,
    orchestrator: () => orchestrator,
    broadcast: publishTerminalState,
    closeInterruptedRuns: () => schedulesStore.closeInterruptedRuns(),
    onHeld: (projectId) => triageWaker.wake(projectId, 'interrupted'),
    // Os resultados de tarefa pendentes vão no estado publicado e na lista (o
    // goal já vem do próprio estado gravado).
    decorate: (projectId, engine) => taskWake?.decorate(projectId, engine) ?? {},
    decoratedTerminals: () => taskWake?.terminals() ?? [],
  })
  // O limite nasce junto do reinício: revive e publica pelo serviço dele, e
  // absorve a marca do reinício quando o limite bate.
  const limit = createUsageLimitService({
    manager: deps.manager, store: terminalState, restart,
    onLimitNotice: (projectId) => triageWaker.wake(projectId, 'usage_limit'),
  })
  // Fechar o app desliga o relógio: nenhuma retomada dispara num app fechado.
  app.addHook('onClose', async () => { limit.dispose() })
  // O goal (lugar 6) e o aviso de resultado (lugar 4): depois do reinício (que
  // revive e publica por eles). O aviso nasce AQUI, antes do startAfterListen:
  // ele tira as marcas do limite do banco na construção, e a subida do limite
  // (que limpa o adiado vencido) roda antes da dele.
  const goalService = createGoalService({
    db: deps.db, manager: deps.manager, store: terminalState, restart, nextSend: () => nextSend,
    // O goal esperando só volta sozinho sem aviso de resultado por sair (é o aviso que o acorda).
    hasPendingResults: (projectId, engine) => taskWake?.hasPending(projectId, engine) ?? false,
    // O gancho da fila roda antes do goal no fim de turno (index.ts): a marca já está posta.
    queueInterrupted: (projectId, engine) => queue.wasOwnInterrupt(projectId, engine),
  })
  const wake = createTaskWake({
    db: deps.db, manager: deps.manager, store: terminalState, restart, nextSend: () => nextSend, holds,
    // O goal que esperava as tarefas delegadas volta a ativo quando o aviso sai.
    onDelivered: (projectId, engine) => goalService.onTaskResultDelivered(projectId, engine),
  })
  goal = goalService
  taskWake = wake
  nextSend.register(wake.provider)
  nextSend.register(goalService.provider)
  registerTerminalStateRoutes(app, { db: deps.db, restart, limit, taskWake: wake, goal: goalService })
  deps.onRestartReady?.(restart)
  deps.onLimitReady?.(limit)
  deps.onTaskWakeReady?.(wake)
  deps.onGoalReady?.(goalService)
  // Ramificar a conversa: depois do goal (a troca de motor pausa o goal do destino).
  const branch = createBranchService({
    db: deps.db, manager: deps.manager, broadcast: (m) => deps.wsHub?.broadcast(m),
    store: terminalState, restart, side: deps.branchTest,
    // Só a volta da conversa: o desfazer que só escreve arquivos não mexe nela.
    rewinding: (projectId, engine) => undo.rewind.holds(projectId, engine),
    // A lateral escreve na pasta do terminal: respeita as travas do desfazer e
    // avisa o rastreador quando trabalha.
    holdSide: (projectId, engine) => undo.holdSide(projectId, engine),
    onSideWorking: (projectId, engine, working) => undo.onSideWorking(projectId, engine, working),
    // A ⇄ recusa o destino segurado; o pacote do /fork no Kimi e o da cópia
    // recusada esperam a soltura (o desfazer cutuca o árbitro ao soltar).
    holds: (projectId, engine) => undo.holds(projectId, engine),
    // As mensagens do operador que o ramificar não conseguiu entregar voltam à
    // fila gravada dele, pausada (ver deliver.ts).
    requeue: (projectId, engine, texts) => { queue.restore(projectId, engine, texts) },
    // No limite da espera, com a sessão livre, a entrega cutuca o árbitro (que
    // respeita os avisos e a compactação pendente) em vez de mandar direto.
    poke: (projectId, engine) => nextSend.poke(projectId, engine),
  })
  nextSend.register(branch.nextSendProvider)
  branchRef = branch
  registerBranchRoutes(app, { db: deps.db, branch })
  deps.onBranchReady?.(branch)
  registerFileRoutes(app, { projects: createProjectsService(deps.db) })
  await registerUploadRoutes(app, { uploadsDir: deps.config.uploadsDir })
  if (deps.speech) await registerTranscribeRoutes(app, { speech: deps.speech, uploadsDir: deps.config.uploadsDir })
  if (deps.usage) await registerUsageRoutes(app, { usage: deps.usage, extraUsage: deps.extraUsage, engineUsage: deps.engineUsage })
  // Fora do `if (deps.usage)`: o relatório lê só o banco, que todo app tem.
  registerUsageReportRoutes(app, { db: deps.db, usageIndexer: deps.usageIndexer })
  if (deps.terminalManager) registerTerminalRoutes(app, { manager: deps.manager, terminalManager: deps.terminalManager })
  if (deps.wsHub) deps.wsHub.register(app, { manager: deps.manager, db: deps.db })
  // Os servidores locais de cada terminal (16): só /proc, valem com ou sem o navegador.
  registerLocalServerRoutes(app, { db: deps.db, servicePort: deps.config.port })
  // O navegador embutido (16): rotas do hermes e do operador; o `browser_tab` passa pelo hub.
  if (deps.browserHost) {
    const browser = createBrowserFeature({ host: deps.browserHost, db: deps.db, uploadsDir: deps.config.uploadsDir, broadcast: (m) => deps.wsHub?.broadcast(m) })
    browser.register(app); deps.onBrowserReady?.(browser)
  }

  // Static (SPA) por ÚLTIMO: garante que as rotas /api já existem antes do
  // notFoundHandler entrar em cena (o fallback SPA usa setNotFoundHandler).
  if (deps.webDist) await registerStatic(app, deps.webDist)

  return app
}
