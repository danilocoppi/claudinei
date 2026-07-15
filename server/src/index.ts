import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig, migrateLegacyDataDir, parseCliArgs, resolveSelfUrl } from './config.js'
import { assertExposureAllowed, isLoopbackHost } from './expose-guard.js'
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
  const { isPackaged, ensureNativeCache, reexecIfNeeded } = await import('./pkg-runtime.js')
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
    // Empacotado: o mcp-config do hermes tem que chamar o PRÓPRIO binário (não há
    // `node` na máquina do usuário). process.execPath dentro de um binário pkg É o
    // caminho do próprio executável — já é o valor default de hermesCommand (T1);
    // só o hermesArgs precisa trocar de [hermesScript] para ['--hermes'] (o modo
    // multi-modo deste arquivo, ver topo). loadConfig() lê essas envs (T1/config.ts).
    if (!process.env.CLAUDINEI_HERMES_COMMAND) process.env.CLAUDINEI_HERMES_COMMAND = process.execPath
    if (!process.env.CLAUDINEI_HERMES_ARGS) process.env.CLAUDINEI_HERMES_ARGS = JSON.stringify(['--hermes'])
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

  migrateLegacyDataDir()
  const config = loadConfig()
  const cli = parseCliArgs(process.argv.slice(2))
  const host = cli.host ?? config.host
  const port = cli.port ?? config.port
  // Recalibra selfUrl considerando --port da CLI (loadConfig só viu env) — ver
  // resolveSelfUrl em config.ts (helper puro, testado em server/test/config.test.ts).
  config.selfUrl = resolveSelfUrl(config, cli, process.env)
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
  const serviceToken = auth.tokens.signService()
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
  const usage = createUsageService()
  const engineUsage = createEngineUsageService(db)
  // drain nasce do orchestrator, que só existe depois do buildApp — mas o
  // manager (criado agora, antes) precisa poder chamá-lo assim que uma sessão
  // libera. Guarda numa referência mutável que buildApp preenche via
  // onOrchestratorReady, e o hook do manager sempre lê o valor atual dela.
  let drain: ((projectId: number) => void) | undefined
  const manager = createSessionManager({
    db,
    broadcast: (m) => wsHub.broadcast(m),
    hermes: { command: config.hermesCommand, args: config.hermesArgs, apiUrl: config.selfUrl, serviceToken },
    keepSessionsPerProject: config.keepSessionsPerProject,
    onSlashCommands: (cmds) => settings.setSlashCommands(cmds),
    onSessionAvailable: (projectId) => drain?.(projectId),
    onEngineUsage: (engine, tokens) => engineUsage.record(engine, tokens),
    terminalLauncher: (opts) => terminalManager.open(opts.localId, {
      cwd: opts.cwd,
      file: opts.file,
      args: opts.args,
      onExit: opts.onExit,
    }),
  })

  // Empacotado: o SPA já foi extraído pro cache (CLAUDINEI_PKG_WEB) — usa direto,
  // sem tocar no disco de dev. Fora do binário: __dirname = server/src; sobe dois
  // níveis (server/src → server → repo raiz) e desce para web/dist. Vale tanto
  // para `tsx watch src/index.ts` (cwd=server) quanto para bin/claudinei.mjs
  // (cwd=repo raiz): __dirname vem do caminho real do arquivo (fileURLToPath),
  // não do cwd do processo.
  const webDist = process.env.CLAUDINEI_PKG_WEB ?? join(__dirname, '..', '..', 'web', 'dist')
  const app = await buildApp({
    config, db, manager, wsHub, terminalManager, speech, usage, engineUsage, auth,
    webDist: existsSync(webDist) ? webDist : undefined,
    onOrchestratorReady: (d) => { drain = d },
    onRevokeAll: () => wsHub.closeAll(),
    onUserInvalidated: (id) => wsHub.closeUser(id),
  })
  await app.listen({ port, host })
  console.log(
    `Termaster server em http://${host}:${port}` +
    (cli.insecure && !isLoopbackHost(host) ? '  ⚠ EXPOSTO SEM AUTH' : ''),
  )

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log('encerrando sessões...')
      await manager.stopAll()
      await speech.stop()
      await app.close()
      process.exit(0)
    })
  }
}
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
