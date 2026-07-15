// Lógica do processo filho de transcrição — extraída de server/src/speech/worker.mjs
// (Task 3 do binário único) pra ficar importável tanto pelo shim .mjs (dev: `node
// worker.mjs`, spawnado pelo transcriber.ts) quanto pelo modo `--speech-worker` do
// entry empacotado (server/src/index.ts).
//
// Por quê precisa de um modo próprio no entry, em vez de só copiar worker.mjs pro
// binário e spawnar o caminho real extraído do cache: @yao-pkg/pkg monkey-patcha
// child_process.spawn (bootstrap-shared.js: patchChildProcess) — todo spawn cujo
// `env` não define PKG_EXECPATH ganha `PKG_EXECPATH=<execPath>` automaticamente;
// o bootstrap do FILHO então vê PKG_EXECPATH===execPath e assume "fui spawnado
// deliberadamente pra rodar OUTRO script", tentando resolver o arg seguinte como
// caminho real via path.resolve() — comportamento OFICIAL do pkg pra rodar
// scripts bundlados via `spawn(process.execPath, [caminho])`. Um caminho real
// extraído do cache TERIA funcionado (é exatamente esse o caso de uso oficial),
// mas dispatch por flag (mesma solução que o hermes/Task 1 já usa pro --hermes)
// é mais simples: sem asset extra pra copiar/extrair, sem depender de
// path.resolve() encontrar o arquivo certo. transcriber.ts seta
// `env.PKG_EXECPATH=''` no spawn do worker pra evitar a auto-injeção e manter
// o entry padrão + a flag como argv normal — ver o comentário lá (empírico,
// ver task-3-report.md).
//
// Carrega o sherpa-onnx (precisa do LD_LIBRARY_PATH já definido no spawn do
// processo — ver transcriber.ts) e atende requisições JSON-line via stdio:
// {id, wav} → {id, text|error}.
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { MODEL_DIR_NAME } from './paths.js'
import { moduleFilename } from '../dirname.js'

interface SherpaWave { samples: Float32Array; sampleRate: number }
interface SherpaStream { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void }
interface SherpaRecognizer {
  createStream(): SherpaStream
  decode(s: SherpaStream): void
  getResult(s: SherpaStream): { text: string }
}
interface SherpaModule {
  readWave(path: string): SherpaWave
  OfflineRecognizer: new (cfg: unknown) => SherpaRecognizer
}

/** Sobe o worker de transcrição (stdio) e só retorna quando o stdin fecha (fila
 *  de linhas JSON esgota) — mesmo ciclo de vida do worker.mjs original: o
 *  processo se mantém vivo pelo próprio listener do stdin. */
export function runSpeechWorker(): void {
  // 'sherpa-onnx-node' é nativo (deixado external pelo esbuild — ver
  // scripts/package.mjs); sem @types, por isso via createRequire + cast.
  // moduleFilename (não import.meta.url direto): no bundle CJS empacotado
  // import.meta.url vira undefined e createRequire(undefined) explode com
  // ERR_INVALID_ARG_VALUE (visto rodando o binário — ver task-3-report.md).
  const require = createRequire(moduleFilename(import.meta.url))
  const sherpa = require('sherpa-onnx-node') as SherpaModule

  const speechDir = process.env.SPEECH_DIR
  if (!speechDir) throw new Error('SPEECH_DIR não setado (esperado no env do spawn — ver transcriber.ts)')
  const dir = join(speechDir, MODEL_DIR_NAME)
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(dir, 'encoder.int8.onnx'),
        decoder: join(dir, 'decoder.int8.onnx'),
        joiner: join(dir, 'joiner.int8.onnx'),
      },
      tokens: join(dir, 'tokens.txt'),
      numThreads: 8,
      provider: 'cpu',
      modelType: 'nemo_transducer',
    },
  })
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n')

  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    let req: { id: number; wav: string }
    try { req = JSON.parse(line) } catch { return }
    try {
      const wave = sherpa.readWave(req.wav)
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
      recognizer.decode(stream)
      const text = recognizer.getResult(stream).text.trim()
      process.stdout.write(JSON.stringify({ id: req.id, text }) + '\n')
    } catch (e) {
      process.stdout.write(JSON.stringify({ id: req.id, error: String((e as Error)?.message ?? e) }) + '\n')
    }
  })
}
