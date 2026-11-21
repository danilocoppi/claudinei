import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig, migrateLegacyDataDir, parseCliArgs, resolveSelfUrl } from './config.js'
import { assertExposureAllowed, isLoopbackHost } from './expose-guard.js'
import { loadTlsOptions } from './tls.js'
import { moduleDirname } from './dirname.js'

const __dirname = moduleDirname(import.meta.url)

// Tudo dentro de uma IIFE async: o esbuild (scripts/package.mjs) bundla este
// arquivo pra CJS, e "top-level await" não é suportado nesse formato de saída
// (só ESM) — mesmo comportamento em dev (tsx roda isto como ESM de verdade,
// onde top-level await é permitido; a IIFE funciona igual nos dois).
void (async () => {
if (process.argv.includes('--hermes')) {
  // Modo MCP: sobe só o hermes (stdio) e sai — sem migração, sem db, sem porta.
  // É o modo que o binário empacotado usa como `command` do mcp-config (T2/T3);
  // em dev também é exercitado diretamente (server/test/hermes-mode.test.ts).
  const { runHermes } = await import('./hermes/run-hermes.js')
  await runHermes({
    api: process.env.CLAUDINEI_API || 'http://127.0.0.1:9105',
    projectId: Number(process.env.CLAUDINEI_PROJECT_ID || '0'),
    serviceToken: process.env.CLAUDINEI_SERVICE_TOKEN,
    serviceTokenFile: process.env.CLAUDINEI_SERVICE_TOKEN_FILE,
    engine: process.env.CLAUDINEI_ENGINE,
  })
} else if (process.argv.includes('--speech-worker')) {
  // Modo worker de fala: mesma ideia do --hermes acima — dispatch por flag
  // dentro do PRÓPRIO bundle, em vez de extrair+spawnar um script real (ver
  // run-worker.ts pro detalhe empírico do pkg/child_process). O transcriber.ts
  // usa este modo (workerPath='--speech-worker') quando empacotado; em dev
  // continua spawnando o shim server/src/speech/worker.mjs via `node` (ver
  // createSpeechService abaixo).
  const { runSpeechWorker } = await import('./speech/run-worker.js')
  runSpeechWorker()
} else {
  // Binário empacotado (@yao-pkg/pkg): extrai os nativos (better_sqlite3.node,
  // pty.node, sherpa) e o web/dist do snapshot pra um cache real em disco e
  // re-executa a si mesmo com o LD_LIBRARY_PATH certo — TEM que acontecer
  // ANTES de qualquer import nativo abaixo, porque o dlopen das .so não
  // enxerga o snapshot do pkg (só arquivo real) e o env só pega no arranque
  // do processo (ver server/src/pkg-runtime.ts, mecanismo provado por spike).
  // Fora do binário (dev/teste), isPackaged() é sempre false — no-op total.
  const { isPackaged, ensureNativeCache, reexecIfNeeded, installInspectorFallback } = await import('./pkg-runtime.js')
  if (isPackaged()) {
    const version = process.env.CLAUDINEI_VERSION ?? 'v1'
    // Caminho do snapshot p/ os assets — EMPÍRICO (T3, rodando o binário real):
    // o esbuild bundla server/src/index.ts inteiro (esta IIFE) num único
    // dist-pkg/server.cjs; dentro do snapshot pkg, __dirname deste arquivo
    // bundlado é o dirname DESSE arquivo de saída (dist-pkg), não o
    // server/src/ original. scripts/package.mjs monta os assets como
    // dist-pkg/assets/ — IRMÃO de server.cjs, não um nível acima — por isso é
    // join(__dirname, 'assets'), não join(__dirname, '..', 'assets') (essa
    // segunda forma apontava pra fora do snapshot e quebrava com ENOENT — ver
    // task-3-report.md).
    const snapshotAssets = join(__dirname, 'assets')
    const { nativeDir, webDir, ldPath } = ensureNativeCache({ snapshotAssets, version })
    // require('better-sqlite3')/require('node-pty')/require('bindings') (nome nu,
    // deixados external pelo esbuild — ver scripts/package.mjs) não resolvem via
    // node_modules normal dentro do snapshot pkg. NODE_PATH resolve nomes nus
    // testando <entrada>/<nome-do-pacote> direto — por isso cada pacote nativo
    // extraído fica filho DIRETO de nativeDir (não node_modules/ aninhado).
    // CRÍTICO: o Node só lê NODE_PATH uma vez, no boot do processo (antes do
    // 1º require) — setar process.env aqui não afeta ESTE processo já rodando.
    // Por isso o valor tem que estar no env ANTES do reexecIfNeeded logo abaixo:
    // o reexec spawna um processo NOVO (boot do zero), que aí sim lê o NODE_PATH
    // certo desde o início (mesmo truque já usado para LD_LIBRARY_PATH).
    process.env.NODE_PATH = [nativeDir, process.env.NODE_PATH].filter(Boolean).join(':')
    reexecIfNeeded(ldPath) // se re-exec, o processo atual sai aqui e não chega nos imports abaixo
    process.env.CLAUDINEI_PKG_NATIVE = nativeDir
    process.env.CLAUDINEI_PKG_WEB = webDir
    // O Node do pkg vem sem `inspector`, e o playwright-core (navegador embutido)
    // faz require("inspector") ao carregar: o desvio entra antes do primeiro require dele.
    installInspectorFallback()
    // Empacotado: o mcp-config do hermes tem que chamar o PRÓPRIO binário (não há
    // `node` na máquina do usuário). process.execPath dentro de um binário pkg É o
    // caminho do próprio executável — já é o valor default de hermesCommand (T1);
    // só o hermesArgs precisa trocar de [hermesScript] para ['--hermes'] (o modo
    // multi-modo deste arquivo, ver topo). loadConfig() lê essas envs (T1/config.ts).
    if (!process.env.CLAUDINEI_HERMES_COMMAND) process.env.CLAUDINEI_HERMES_COMMAND = process.execPath
    if (!process.env.CLAUDINEI_HERMES_ARGS) process.env.CLAUDINEI_HERMES_ARGS = JSON.stringify(['--hermes'])
  } else {
    // Fora do binário, CLAUDINEI_PKG_* herdado é SEMPRE lixo de outro processo:
    // o binário empacotado seta essas envs pra si e elas vazam pros filhos — um
    // terminal aberto PELO Claudinei que rode `tsx src/index.ts` (dogfooding)
    // herdaria o web/dist extraído do binário e serviria a SPA VELHA em dev.
    delete process.env.CLAUDINEI_PKG_WEB
    delete process.env.CLAUDINEI_PKG_NATIVE
  }

  // Conferência do navegador embutido (o binário empacotado acha o playwright-core
  // e o Chromium?): sem banco, sem porta, sem migração. Imprime uma linha JSON e sai.
  if (process.argv.includes('--browser-selftest')) {
    const { browserSelfTest } = await import('./browser/selftest.js')
    process.exit(await browserSelfTest(console.log))
  }

  // Imports pesados (nativos: better-sqlite3, node-pty, sherpa) só aqui dentro,
  // fora do topo do módulo — imports ESM no topo são hoisted e carregariam
  // antes do dispatch do --hermes acima, quebrando o modo MCP leve no binário
  // empacotado (nativos só são extraídos no modo servidor — ver Task 2/3).
  const { openDb } = await import('./db.js')
  // Bootstrap do registry de engines (side-effect: registra o claudeEngine) —
  // tem que rodar antes de createSessionManager, que resolve sessões via
  // getEngine() (ver server/src/engine/index.ts).
  await import('./engine/index.js')
  const { createSessionManager } = await import('./claude/manager.js')
  const { createWsHub } = await import('./routes/ws.js')
  const { buildApp } = await import('./app.js')
  const { createTerminalManager } = await import('./terminal/manager.js')
  const { nodePtyFactory } = await import('./terminal/pty.js')
  const { createSettingsService } = await import('./settings.js')
  const { createSpeechService } = await import('./speech/transcriber.js')
  const { createUsageService } = await import('./usage.js')
  const { createEngineUsageService } = await import('./engine-usage.js')
  const { createAuthService } = await import('./auth/index.js')
  const { captureCrashed, createTerminalStateStore } = await import('./restart/terminal-state.js')
  const { captureShutdown } = await import('./restart/capture.js')
  const { startAfterListen } = await import('./restart/boot.js')
  const { createUsageIndexStore } = await import('./usage-index/store.js')
  const { createUsageIndexer } = await import('./usage-index/indexer.js')
  const { sessionsRoot } = await import('./engine/codex/rollout.js')
  const { observerOf } = await import('./undo/index.js')
  const { createBrowserHost } = await import('./browser/host.js')

  migrateLegacyDataDir()
  const config = loadConfig()
  const cli = parseCliArgs(process.argv.slice(2))
  const host = cli.host ?? config.host
  const port = cli.port ?? config.port
  // Recalibra selfUrl considerando --port da CLI (loadConfig só viu env) — ver
  // resolveSelfUrl em config.ts (helper puro, testado em server/test/config.test.ts).
  config.selfUrl = resolveSelfUrl(config, cli, process.env)
  // O Chromium do navegador embutido: um host só, aberto sob demanda (nada sobe aqui).
  const browserHost = createBrowserHost({ log: (l) => console.log(`[navegador] ${l}`) })
  const db = openDb(config.dbPath)
  const auth = createAuthService({ db, secretPath: join(dirname(config.dbPath), 'jwt-secret') })
  // O guard de exposição roda DEPOIS do openDb: authConfigured depende de já
  // haver usuários cadastrados no banco (auth.configured() consulta a tabela).
  try {
    assertExposureAllowed(host, { insecure: !!cli.insecure, authConfigured: auth.configured() })
  } catch (err) {
    console.error(String((err as Error).message))
    process.exit(1)
  }
  const serviceToken = auth.tokens.signService(auth.users.serviceTokenVersion())
  // O token de serviço NUNCA vai em argv (visível em `ps` para qualquer usuário
  // do SO): fica num arquivo 0600 e as engines recebem só o caminho.
  const serviceTokenFile = join(dirname(config.dbPath), 'service-token')
  writeFileSync(serviceTokenFile, serviceToken, { mode: 0o600 })
  const settings = createSettingsService(db)
  const wsHub = createWsHub()
  const terminalManager = createTerminalManager({ ptyFactory: nodePtyFactory })
  const speech = createSpeechService({
    speechDir: config.speechDir,
    // Empacotado: join(__dirname, '..') aponta pro DIRETÓRIO DO SNAPSHOT
    // (algo como /snapshot/.../Termaster) — não existe no disco real. O
    // transcriber.ts usa serverDir como `cwd` do spawn do worker; child_process
    // faz um chdir() de verdade no processo filho, então um cwd inexistente
    // faz o spawn falhar com ENOENT/ENOTDIR ("worker de fala falhou ao
    // iniciar", visto rodando o binário — ver task-3-report.md). nativeDir
    // (CLAUDINEI_PKG_NATIVE) já é um diretório REAL (extraído do snapshot pro
    // cache) — serve igual de bem como cwd, já que o worker só usa caminhos
    // absolutos (SPEECH_DIR/NODE_PATH), nunca relativos ao cwd.
    serverDir: process.env.CLAUDINEI_PKG_NATIVE ?? join(__dirname, '..'),
    nativeDirOverride: process.env.CLAUDINEI_PKG_NATIVE,
    // Empacotado: não dá pra spawnar um caminho de arquivo real (worker.mjs)
    // pelo binário pkg (ver comentário em run-worker.ts) — o transcriber.ts
    // spawna `<nodeBin> <workerPath> ...workerArgs`; usar a flag --speech-worker
    // como "workerPath" faz o binário (nodeBin=process.execPath, igual ao
    // --hermes) cair no dispatch de cima em vez de tentar abrir um script.
    workerPath: process.env.CLAUDINEI_PKG_NATIVE ? '--speech-worker' : undefined,
  })
  // O último uso bom fica junto do banco: sobrevive a reiniciar e a um 429.
  const usage = createUsageService({ statePath: join(dirname(config.dbPath), 'claude-usage.json') })
  // Limites do plano do Kimi (mesma fonte do /status da CLI) na MESMA lista do card.
  const { createKimiUsageService } = await import('./engine/kimi/kimi-usage.js')
  const kimiUsage = createKimiUsageService()
  const { codexMetadata } = await import('./engine/codex/codex-metadata.js')
  const engineUsage = createEngineUsageService(db)
  // Índice de uso dos históricos locais (Claude e Codex) para a página de uso. Só liga
  // depois do listen; as passadas cedem o laço entre fatias e nunca seguram a subida.
  const usageIndexer = createUsageIndexer({
    store: createUsageIndexStore(db),
    claudeProjectsDir: join(config.claudeConfigDir, 'projects'),
    codexSessionsDir: sessionsRoot(),
  })
  // drain nasce do orchestrator, que só existe depois do buildApp — mas o
  // manager (criado agora, antes) precisa poder chamá-lo assim que uma sessão
  // libera. Guarda numa referência mutável que buildApp preenche via
  // onOrchestratorReady, e o hook do manager sempre lê o valor atual dela.
  let drain: ((projectId: number) => boolean) | undefined
  // O árbitro do próximo envio e a fila do operador nascem no buildApp, depois do
  // orchestrator: o "livre" do manager vai ao árbitro (com a sessão), e o fim de
  // turno e a morte da sessão vão à fila (que pausa).
  let nextSend: import('./queue/next-send.js').NextSend | undefined
  let queue: import('./queue/operator-queue.js').OperatorQueueService | undefined
  // Mesmo padrão para o serviço do reinício, que nasce no buildApp: os ganchos
  // do manager (fim de turno, mensagem do operador) leem a referência atual.
  let restart: import('./restart/boot.js').RestartService | undefined
  // E para o despertador da triagem, que nasce com o store dela no buildApp.
  let triageWaker: import('./triage/wake.js').TriageWaker | undefined
  // E para o do limite de uso, que nasce junto dele: o limite que bateu, o fim
  // de turno e a mensagem do operador chegam pela referência atual.
  let limit: import('./limit/usage-limit.js').UsageLimitService | undefined
  // E para o aviso de resultado de tarefa delegada e o goal, que nascem com o
  // reinício: o fim de turno, a mensagem do operador e o `/goal` chegam por elas.
  let taskWake: import('./delegate/task-wake.js').TaskWake | undefined
  let goal: import('./goal/goal.js').GoalService | undefined
  // E para o de ramificar a conversa (a lateral): o fim da sessão principal a fecha.
  let branch: import('./branch/service.js').BranchService | undefined
  // E para o desfazer turno: o rastreador vê cada mensagem, status e evento do manager.
  let undo: import('./undo/index.js').Undo | undefined
  /** Um gancho que falha não pode impedir os outros (aceita N): cada serviço cuida do seu estado. */
  const both = (label: string, ...calls: Array<() => void>): void => {
    for (const call of calls) {
      try { call() } catch (err) { console.error(`[${label}] gancho falhou`, err) }
    }
  }
  const terminalState = createTerminalStateStore(db)
  // Queda brusca da vez anterior: quem ficou `working` no banco estava no meio
  // de um turno. Tem que ler ANTES do createSessionManager, que reescreve esses
  // status para `dead` ao subir.
  const caidas = captureCrashed(db)
  if (caidas > 0) console.log(`[reinício] ${caidas} terminal(is) caíram no meio de um turno`)
  const manager = createSessionManager({
    db,
    broadcast: (m) => wsHub.broadcast(m),
    hermes: { command: config.hermesCommand, args: config.hermesArgs, apiUrl: config.selfUrl, serviceTokenFile },
    keepSessionsPerProject: config.keepSessionsPerProject,
    onSlashCommands: (cmds) => settings.setSlashCommands(cmds),
    autoCompactPct: () => Number(settings.get('autoCompactPct') || 0),
    // Sem a sessão (ou antes de o árbitro existir), direto às tarefas, como sempre.
    onSessionAvailable: (projectId, ctx) => both('sessão livre', () => {
      if (ctx && nextSend) nextSend.onSessionAvailable({ projectId, engine: ctx.engine, localId: ctx.localId })
      else drain?.(projectId)
    }),
    onEngineUsage: (engine, tokens) => engineUsage.record(engine, tokens),
    onRateLimit: (info) => usage.observe(info),
    onTurnResult: (projectId, engine, info) => both('fim de turno',
      () => restart?.onTurnResult(projectId, engine),
      () => limit?.onTurnResult(projectId, engine, info),
      () => queue?.onTurnResult(projectId, engine, info),
      () => taskWake?.onTurnResult(projectId, engine, info),
      () => goal?.onTurnResult(projectId, engine, info),
      () => branch?.onTurnResult(projectId, engine)),
    // Só a morte de verdade: o manager não chama no encerramento do serviço.
    onSessionDied: (projectId, engine) => both('sessão morreu',
      () => queue?.onSessionDied(projectId, engine),
      () => branch?.onSessionDied(projectId, engine)),
    // Parada ou morta: a lateral do terminal fecha junto (no encerramento o dispose já a tirou).
    onSessionEnded: (projectId, engine, localId) => branch?.onSessionEnded(projectId, engine, localId),
    onOperatorMessage: (projectId, engine, info) => both('mensagem do operador',
      () => restart?.onOperatorMessage(projectId, engine),
      () => limit?.onOperatorMessage(projectId, engine),
      () => goal?.onOperatorMessage(projectId, engine, info),
      () => branch?.onOperatorMessage(projectId, engine, info)),
    // O `/goal` digitado (ou vindo da fila) é do goal; antes de ele existir, segue como mensagem comum.
    interceptCommand: (ctx, text) => goal?.command(ctx, text) ?? false,
    // Também pelo both: só para a falha sair no log (o manager engole o erro).
    onUsageLimit: (projectId, engine, p) => both('limite de uso',
      () => limit?.onUsageLimit(projectId, engine, p)),
    // Limite detectado só pelo texto, sem rate_limit_event: o horário vem do último 429 do uso.
    lastRejectedResetsAt: () => usage.lastRejectedResetsAt(),
    onNeedsOperator: (projectId, reason) => triageWaker?.wake(projectId, reason),
    turnObserver: observerOf(() => undo),
    terminalLauncher: (opts) => terminalManager.open(opts.localId, {
      cwd: opts.cwd,
      file: opts.file,
      args: opts.args,
      env: opts.env,
      onExit: opts.onExit,
      onActivity: opts.onActivity,
    }),
  })

  // Empacotado: o SPA já foi extraído pro cache (CLAUDINEI_PKG_WEB) — usa direto,
  // sem tocar no disco de dev. Fora do binário: __dirname = server/src; sobe dois
  // níveis (server/src → server → repo raiz) e desce para web/dist. Vale tanto
  // para `tsx watch src/index.ts` (cwd=server) quanto para bin/claudinei.mjs
  // (cwd=repo raiz): __dirname vem do caminho real do arquivo (fileURLToPath),
  // não do cwd do processo.
  const webDist = process.env.CLAUDINEI_PKG_WEB ?? join(__dirname, '..', '..', 'web', 'dist')
  // O agendador nasce dentro do buildApp (precisa do manager já montado); guardamos
  // a referência para ligar o laço depois do listen e desligá-lo no shutdown.
  let scheduler: import('./schedules/scheduler.js').Scheduler | undefined
  // Proxy reverso na frente? Então loopback deixa de valer como "dono na máquina"
  // (é o proxy que conecta em 127.0.0.1). Aceita CLI e env — em systemd, a env é
  // mais prática que editar o ExecStart.
  const behindProxy = !!cli.behindProxy || process.env.CLAUDINEI_TRUSTED_PROXY === '1'
  // TLS próprio (opcional). CLI tem precedência sobre env — quem digitou a flag
  // agora quer aquilo, não o que está no unit do systemd.
  let https: ReturnType<typeof loadTlsOptions> = null
  try {
    https = loadTlsOptions({
      cert: cli.tlsCert ?? config.tlsCert,
      key: cli.tlsKey ?? config.tlsKey,
    })
  } catch (err) {
    // Morrer aqui é o certo: subir em HTTP depois de pedirem HTTPS seria expor em
    // texto puro alguém que acredita estar protegido.
    console.error((err as Error).message)
    process.exit(1)
  }
  const app = await buildApp({
    config, db, manager, wsHub, terminalManager, speech, usage, extraUsage: [kimiUsage, codexMetadata], engineUsage, usageIndexer, auth,
    browserHost,
    insecure: !!cli.insecure,
    behindProxy,
    https: https ?? undefined,
    webDist: existsSync(webDist) ? webDist : undefined,
    onOrchestratorReady: (o) => { drain = o.drain },
    onNextSendReady: (n) => { nextSend = n },
    onQueueReady: (q) => { queue = q },
    onSchedulerReady: (s) => { scheduler = s },
    onRestartReady: (r) => { restart = r },
    onTriageWakerReady: (w) => { triageWaker = w },
    onLimitReady: (l) => { limit = l },
    onTaskWakeReady: (w) => { taskWake = w },
    onGoalReady: (g) => { goal = g },
    onBranchReady: (b) => { branch = b },
    onUndoReady: (u) => { undo = u },
    onRevokeAll: () => {
      wsHub.closeAll()
      // Reassina com a versão nova e reescreve o arquivo: o hermes lê o token
      // do arquivo a cada chamada, então sessões vivas continuam funcionando.
      writeFileSync(serviceTokenFile, auth.tokens.signService(auth.users.serviceTokenVersion()), { mode: 0o600 })
    },
    onUserInvalidated: (id) => wsHub.closeUser(id),
  })
  await app.listen({ port, host })
  // Depois do listen: a subida dos terminais (retomadas e "iniciar com o
  // Claudinei", em lotes) e o primeiro tick do agendador sobem sessões, e isso
  // não deve atrasar o momento em que a porta começa a aceitar conexões. O
  // agendador só liga depois da subida: um agendamento não disputa a sessão com
  // a retomada. Sem await: a subida espera entre lotes, e nem o log abaixo nem
  // os ouvintes de SIGINT/SIGTERM (que registram a interrupção) podem esperar.
  // O limite de uso sobe depois do reinício, e os avisos de resultado de tarefa
  // pendentes depois do limite, todos antes do agendador (ver startAfterListen).
  // O desfazer sobe antes de todos (fecha os turnos que ficaram abertos antes de
  // qualquer sessão voltar); a retenção dele roda na subida e a cada 24 h.
  void startAfterListen({ undo, restart, limit, taskWake, scheduler, isShuttingDown: () => manager.isShuttingDown() })
    .catch((err) => console.error('[reinício/limite] arranque depois do listen falhou', err))
  const undoRetention = setInterval(() => { void undo?.retain() }, 24 * 60 * 60 * 1000)
  undoRetention.unref()
  // Sem await: a primeira passada roda em segundo plano e repete a cada 10 min; uma
  // passada que lança é registrada no log pelo próprio indexador.
  usageIndexer.start()
  // Rastros de laterais que a vez anterior deixou (queda, encerramento). Sem
  // await, pelo mesmo motivo da subida acima: o `opencode session delete` de cada
  // uma pode levar segundos, e os ouvintes de SIGINT/SIGTERM não podem esperar.
  void branch?.bootCleanup().catch((err) => console.error('[lateral] limpeza da subida falhou', err))
  console.log(
    `Termaster server em ${https ? 'https' : 'http'}://${host}:${port}` +
    (cli.insecure && !isLoopbackHost(host) ? '  ⚠ EXPOSTO SEM AUTH' : '') +
    (behindProxy ? '  🔒 atrás de proxy (funções de host desativadas p/ acesso remoto)' : ''),
  )
  // Beco sem saída silencioso: proxy ligado + nenhum usuário = o setup do 1º admin
  // fica bloqueado (é o que se quer contra a rede), mas ninguém avisou o dono.
  if (behindProxy && !auth.configured()) {
    console.log(
      '  ⚠ --behind-proxy com ZERO usuários: o setup do primeiro admin está bloqueado ' +
      'para a rede. Suba UMA vez SEM --behind-proxy (em localhost) para criar o admin, ' +
      'depois religue com o proxy.',
    )
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log('encerrando sessões...')
      // Antes de parar qualquer coisa: registra quem estava no meio de um turno
      // (e liga o modo de encerramento, que segura a subida em lotes e mantém as
      // tarefas encaminhadas abertas para a próxima subida religar).
      const marcadas = captureShutdown(manager, terminalState)
      if (marcadas > 0) console.log(`[reinício] ${marcadas} terminal(is) interrompidos no meio de um turno`)
      // O relógio do limite para: uma retomada armada fica no banco para a próxima subida.
      limit?.dispose()
      clearInterval(undoRetention)
      scheduler?.stop()
      // Só os processos das laterais: a limpeza fica para a próxima subida.
      await branch?.dispose()
      await manager.stopAll()
      await speech.stop()
      // Interrompe a passada na próxima fatia; o que já foi gravado fica coerente.
      await usageIndexer.stop()
      // Fecha as abas e o Chromium antes de fechar o servidor.
      await browserHost.shutdown()
      await app.close()
      process.exit(0)
    })
  }
}
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
