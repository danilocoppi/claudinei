import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { speechPaths, speechInstalled } from './paths.js'
import { moduleDirname, moduleFilename } from '../dirname.js'

const __dirname = moduleDirname(import.meta.url)

export interface SpeechService {
  installed(): boolean
  transcribe(wavPath: string): Promise<string>
  stop(): Promise<void>
}

interface Opts {
  speechDir: string
  /** Raiz do pacote server (onde fica node_modules com o sherpa). */
  serverDir: string
  /** Override p/ testes: caminho do worker (default: worker.mjs real). */
  workerPath?: string
  nodeBin?: string
  timeoutMs?: number
  workerArgs?: string[]
  /** Dir real onde o sherpa-onnx.node foi extraído (binário empacotado — ver
   *  pkg-runtime.ts). Quando setado, sobrepõe a resolução via require.resolve,
   *  que não enxerga o pacote de dentro do snapshot do pkg. */
  nativeDirOverride?: string
}

interface Pending { resolve: (t: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export function createSpeechService(opts: Opts): SpeechService {
  const workerPath = opts.workerPath ?? join(__dirname, 'worker.mjs')
  const nodeBin = opts.nodeBin ?? process.execPath
  const timeoutMs = opts.timeoutMs ?? 30_000
  // Resolve o dir real dos binários do sherpa (npm workspace faz hoisting p/ a raiz).
  // Falha silenciosa (string vazia) se o pacote não estiver instalado — o RUNPATH
  // $ORIGIN dos .so cobre as deps internas; o crítico no LD_LIBRARY_PATH é o stdcxx.
  // Empacotado (pkg), o pacote não existe em node_modules — nativeDirOverride
  // (o dir do cache extraído, ver pkg-runtime.ts) tem prioridade. Aceita tanto a
  // raiz do cache nativo (procura a subpasta que tem sherpa-onnx.node) quanto já
  // o dir exato — mesma busca do ensureNativeCache em pkg-runtime.ts.
  let sherpaLibDir = ''
  if (opts.nativeDirOverride) {
    const base = opts.nativeDirOverride
    if (existsSync(join(base, 'sherpa-onnx.node'))) {
      sherpaLibDir = base
    } else {
      sherpaLibDir = readdirSync(base)
        .map((n) => join(base, n))
        .find((p) => existsSync(join(p, 'sherpa-onnx.node'))) ?? base
    }
  } else {
    const require = createRequire(moduleFilename(import.meta.url))
    try {
      sherpaLibDir = dirname(require.resolve('sherpa-onnx-linux-x64/package.json'))
    } catch {
      sherpaLibDir = join(opts.serverDir, 'node_modules', 'sherpa-onnx-linux-x64') // fallback: layout sem hoisting
    }
  }
  let proc: ChildProcessWithoutNullStreams | null = null
  let readyPromise: Promise<void> | null = null
  let seq = 0
  const pending = new Map<number, Pending>()
  // fila: uma transcrição por vez (o decode é rápido; simplicidade > paralelismo)
  let tail: Promise<unknown> = Promise.resolve()

  function killPending(msg: string) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(msg)) }
    pending.clear()
  }

  function ensureWorker(): Promise<void> {
    if (proc && readyPromise) return readyPromise
    const p = speechPaths(opts.speechDir)
    const child = spawn(nodeBin, [workerPath, ...(opts.workerArgs ?? [])], {
      cwd: opts.serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // EMPÍRICO (T3 — ver task-3-report.md): @yao-pkg/pkg faz monkey-patch
        // de child_process.spawn (bootstrap-shared.js: patchChildProcess) — TODO
        // spawn cujo `env` não tenha PKG_EXECPATH definido ganha
        // `PKG_EXECPATH=<execPath do binário>` automaticamente. O bootstrap do
        // FILHO então vê `PKG_EXECPATH === EXECPATH` e assume "fui spawnado
        // deliberadamente pra rodar outro script" — descarta o placeholder de
        // entrypoint (splice) e tenta resolver o PRÓXIMO arg (aqui,
        // '--speech-worker') como um CAMINHO DE ARQUIVO REAL via path.resolve(),
        // em vez de cair no entrypoint padrão (dist-pkg/server.cjs) — daí o
        // MODULE_NOT_FOUND tentando achar um arquivo chamado "--speech-worker".
        // Setar PKG_EXECPATH pra uma string vazia (≠ EXECPATH, mas definida)
        // faz o patch não sobrescrever (ele só age quando === undefined) e o
        // bootstrap do filho cai no branch padrão — os mesmos args (--port,
        // --hermes) já funcionam assim quando o binário é invocado direto.
        // Fora do pkg (dev/testes), isto não tem efeito nenhum (var ignorada).
        PKG_EXECPATH: '',
        SPEECH_DIR: opts.speechDir,
        LD_LIBRARY_PATH: [
          dirname(p.stdcxxLib),
          sherpaLibDir,
          process.env.LD_LIBRARY_PATH ?? '',
        ].filter(Boolean).join(':'),
        // Empacotado: o worker.mjs faz require('sherpa-onnx-node') (nome nu) —
        // não resolve via node_modules normal fora do repo. nativeDirOverride é
        // o cache extraído (pkg-runtime.ts), com cada pacote nativo como filho
        // DIRETO — exatamente o que NODE_PATH espera (cada entrada é testada
        // como <entrada>/<nome-do-pacote>, não <entrada>/node_modules/<nome>).
        // Um spawn é sempre um processo NOVO, então o NODE_PATH é lido certinho
        // no boot dele (sem o problema de timing que exige re-exec no processo
        // principal — ver index.ts).
        ...(opts.nativeDirOverride ? { NODE_PATH: [opts.nativeDirOverride, process.env.NODE_PATH ?? ''].filter(Boolean).join(':') } : {}),
      },
    })
    proc = child
    const stderrTail: string[] = []
    child.stderr.on('data', (d: Buffer) => {
      stderrTail.push(d.toString())
      if (stderrTail.length > 20) stderrTail.shift()
    })
    const tailStr = () => stderrTail.join('').trim().slice(-500)
    child.stdin.on('error', () => { /* write pós-morte — o exit/error já limpa as pendências */ })
    readyPromise = new Promise<void>((resolve, reject) => {
      const bootTimer = setTimeout(() => {
        // espelha o handler de exit: sem isso o serviço fica preso numa readyPromise
        // rejeitada para sempre e o filho (carregando o modelo) vira órfão
        proc = null
        readyPromise = null
        child.kill('SIGKILL')
        killPending('worker de fala não ficou pronto (tempo limite)')
        reject(new Error('worker de fala não ficou pronto (tempo limite)'))
      }, timeoutMs)
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        let msg: { type?: string; id?: number; text?: string; error?: string }
        try { msg = JSON.parse(line) } catch { return }
        if (msg.type === 'ready') { clearTimeout(bootTimer); resolve(); return }
        if (typeof msg.id === 'number') {
          const req = pending.get(msg.id)
          if (!req) return
          clearTimeout(req.timer)
          pending.delete(msg.id)
          if (msg.error) req.reject(new Error(msg.error))
          else req.resolve(msg.text ?? '')
        }
      })
      child.once('exit', () => {
        clearTimeout(bootTimer)
        if (proc !== child) return // um worker novo já assumiu (ex.: morte pós-timeout de boot)
        proc = null
        readyPromise = null
        const tail = tailStr()
        killPending(`worker de fala encerrou${tail ? `: ${tail}` : ''}`)
        reject(new Error(`worker de fala encerrou no arranque${tail ? `: ${tail}` : ''}`))
      })
      child.on('error', () => {
        clearTimeout(bootTimer)
        if (proc !== child) return
        proc = null
        readyPromise = null
        const tail = tailStr()
        killPending(`worker de fala falhou ao iniciar${tail ? `: ${tail}` : ''}`)
        reject(new Error(`worker de fala falhou ao iniciar${tail ? `: ${tail}` : ''}`))
      })
    })
    // erro no arranque não pode virar unhandled rejection quando ninguém está aguardando
    readyPromise.catch(() => {})
    return readyPromise
  }

  function transcribeOnce(wavPath: string): Promise<string> {
    return ensureWorker().then(() => new Promise<string>((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('transcrição excedeu o tempo limite'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      proc!.stdin.write(JSON.stringify({ id, wav: wavPath }) + '\n')
    }))
  }

  return {
    installed: () => speechInstalled(opts.speechDir),
    transcribe(wavPath: string) {
      const run = tail.then(() => transcribeOnce(wavPath))
      tail = run.catch(() => {}) // fila sobrevive a falhas
      return run
    },
    async stop() {
      const child = proc
      proc = null
      readyPromise = null
      killPending('serviço de fala parado')
      if (child) {
        child.stdin.end()
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
          child.once('exit', () => { clearTimeout(t); resolve() })
        })
      }
    },
  }
}
