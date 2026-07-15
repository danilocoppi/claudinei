# STT no servidor com Parakeet v3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar a transcrição do microfone (Whisper no navegador) por transcrição no backend com NVIDIA Parakeet v3 via sherpa-onnx: gravar → parar → POST WAV → texto completo no campo.

**Architecture:** O backend ganha um serviço de fala (`server/src/speech/`) que roda o sherpa-onnx num **processo filho** Node (spawnado com `LD_LIBRARY_PATH` apontando para um libstdc++ portátil + as .so do pacote — a máquina alvo é Ubuntu 20.04/glibc 2.31 e o prebuilt exige GLIBCXX_3.4.29). Um script de setup baixa modelo (~630MB) e libstdc++ 1× para `~/.termaster/speech`. A rota `POST /api/transcribe` recebe WAV cru e devolve `{text}`. No front, o MicButton deixa de transcrever ao vivo: grava PCM 16kHz, ao parar converte para WAV no navegador e envia; o Whisper/transformers.js sai do bundle web.

**Tech Stack:** Fastify 5 + sherpa-onnx-node ^1.13 (server); React 18 + TS strict (web); Vitest nos dois.

## Global Constraints

- Idioma (código/comentários/i18n): português com acentuação correta; UI via i18n nas 3 línguas (en, es, pt-BR).
- Commit trailer em toda mensagem: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Server: ESM/TS strict, imports RELATIVOS COM sufixo `.js` (padrão server). Web: imports SEM extensão (padrão web).
- Testes: `npm test` dentro de `server/` e de `web/`. TDD em toda task.
- URLs e API sherpa EXATAS do spec (validadas em spike na máquina alvo):
  - modelo: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`
  - libstdc++: `https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-ng-12.2.0-h46fd767_19.tar.bz2`
- ATENÇÃO sandbox: `sherpa-onnx-node` NÃO CARREGA neste ambiente de dev (GLIBCXX). O worker real (`worker.mjs`) NUNCA é importado nos testes — todo teste usa o fake worker. O smoke real é do controlador/usuário.
- `config.speechDir`: `env.CLAUDINEI_SPEECH ?? join(homedir(), '.termaster', 'speech')`.

---

### Task 1: Serviço de fala no servidor (paths + worker + transcriber com processo filho)

**Files:**
- Modify: `server/package.json` (dep `sherpa-onnx-node`, script `setup:speech`)
- Modify: `server/src/config.ts` (campo `speechDir`)
- Create: `server/src/speech/paths.ts`
- Create: `server/src/speech/worker.mjs`
- Create: `server/src/speech/transcriber.ts`
- Create: `server/scripts/setup-speech.mjs`
- Create: `server/test/fake-speech-worker.mjs`
- Test: `server/test/speech.test.ts`

**Interfaces:**
- Consumes: `loadConfig` de `../src/config.js` (padrão existente).
- Produces:
  - `speechPaths(speechDir: string): { modelDir, encoder, decoder, joiner, tokens, stdcxxLib }`
  - `speechInstalled(speechDir: string): boolean`
  - `createSpeechService(opts: { speechDir: string; serverDir: string; workerPath?: string; nodeBin?: string; timeoutMs?: number }): SpeechService`
  - `interface SpeechService { installed(): boolean; transcribe(wavPath: string): Promise<string>; stop(): Promise<void> }`

- [ ] **Step 1: Dep + script npm**

Em `server/`: `npm install sherpa-onnx-node` (instala com sucesso; o binário só falha ao CARREGAR neste ambiente, o que não afeta os testes). Em `server/package.json`, adicionar em `scripts`:
```json
    "setup:speech": "node scripts/setup-speech.mjs"
```

- [ ] **Step 2: `speechDir` no config**

Em `server/src/config.ts`, adicionar ao `interface Config`:
```ts
  /** Pasta do modelo de fala (Parakeet/sherpa) e do libstdc++ portátil. */
  speechDir: string
```
e ao objeto retornado por `loadConfig`:
```ts
    speechDir: env.CLAUDINEI_SPEECH ?? join(homedir(), '.termaster', 'speech'),
```

- [ ] **Step 3: Teste falhando (paths + transcriber)**

Create `server/test/speech.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { speechPaths, speechInstalled } from '../src/speech/paths.js'
import { createSpeechService, type SpeechService } from '../src/speech/transcriber.js'

const __dirname = dirname(fileURLToPath(new URL('.', import.meta.url)))
const FAKE_WORKER = join(__dirname, 'test', 'fake-speech-worker.mjs')

/** Cria uma árvore speechDir completa (arquivos vazios) num tmp. */
function makeInstalled(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speech-'))
  const p = speechPaths(dir)
  mkdirSync(p.modelDir, { recursive: true })
  mkdirSync(dirname(p.stdcxxLib), { recursive: true })
  for (const f of [p.encoder, p.decoder, p.joiner, p.tokens, p.stdcxxLib]) writeFileSync(f, '')
  return dir
}

const services: SpeechService[] = []
afterEach(async () => { for (const s of services.splice(0)) await s.stop() })

function makeService(speechDir: string, workerArgs: string[] = []) {
  const svc = createSpeechService({
    speechDir,
    serverDir: join(__dirname, '..'),
    workerPath: FAKE_WORKER,
    nodeBin: process.execPath,
    timeoutMs: 3000,
    workerArgs,
  })
  services.push(svc)
  return svc
}

describe('speechPaths/speechInstalled', () => {
  it('monta os caminhos esperados', () => {
    const p = speechPaths('/base')
    expect(p.modelDir).toBe('/base/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
    expect(p.encoder).toBe(`${p.modelDir}/encoder.int8.onnx`)
    expect(p.decoder).toBe(`${p.modelDir}/decoder.int8.onnx`)
    expect(p.joiner).toBe(`${p.modelDir}/joiner.int8.onnx`)
    expect(p.tokens).toBe(`${p.modelDir}/tokens.txt`)
    expect(p.stdcxxLib).toBe('/base/stdcxx/lib/libstdc++.so.6')
  })
  it('instalado quando todos os arquivos existem; não instalado quando falta algum', () => {
    const dir = makeInstalled()
    expect(speechInstalled(dir)).toBe(true)
    rmSync(speechPaths(dir).tokens)
    expect(speechInstalled(dir)).toBe(false)
  })
})

describe('createSpeechService (com fake worker)', () => {
  it('transcreve: spawna o worker, espera ready e devolve o texto', async () => {
    const svc = makeService(makeInstalled())
    await expect(svc.transcribe('/tmp/a.wav')).resolves.toBe('transcrito:/tmp/a.wav')
  })
  it('serializa: duas chamadas concorrentes resolvem na ordem', async () => {
    const svc = makeService(makeInstalled())
    const [a, b] = await Promise.all([svc.transcribe('/t/1.wav'), svc.transcribe('/t/2.wav')])
    expect(a).toBe('transcrito:/t/1.wav')
    expect(b).toBe('transcrito:/t/2.wav')
  })
  it('erro do worker numa requisição rejeita só ela', async () => {
    const svc = makeService(makeInstalled())
    await expect(svc.transcribe('/t/ERRO.wav')).rejects.toThrow(/falha proposital/)
    await expect(svc.transcribe('/t/ok.wav')).resolves.toBe('transcrito:/t/ok.wav')
  })
  it('morte do filho rejeita pendentes e a próxima chamada re-spawna', async () => {
    const svc = makeService(makeInstalled())
    await expect(svc.transcribe('/t/MORRE.wav')).rejects.toThrow()
    await expect(svc.transcribe('/t/depois.wav')).resolves.toBe('transcrito:/t/depois.wav')
  })
  it('installed() reflete o speechDir', () => {
    expect(makeService(makeInstalled()).installed()).toBe(true)
    expect(makeService(mkdtempSync(join(tmpdir(), 'vazio-'))).installed()).toBe(false)
  })
})
```

Nota: o teste usa `workerArgs` extra na interface — inclua `workerArgs?: string[]` nas opts (repassados ao spawn; o fake não precisa deles, mas mantém a porta aberta p/ debug).

- [ ] **Step 4: Rodar (deve falhar)** — `cd server && npm test -- speech` → FAIL (módulos não existem).

- [ ] **Step 5: Implementar `paths.ts`**

Create `server/src/speech/paths.ts`:
```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const MODEL_DIR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'

/** Caminhos dos artefatos de fala dentro do speechDir (~/.termaster/speech). */
export function speechPaths(speechDir: string) {
  const modelDir = join(speechDir, MODEL_DIR_NAME)
  return {
    modelDir,
    encoder: join(modelDir, 'encoder.int8.onnx'),
    decoder: join(modelDir, 'decoder.int8.onnx'),
    joiner: join(modelDir, 'joiner.int8.onnx'),
    tokens: join(modelDir, 'tokens.txt'),
    stdcxxLib: join(speechDir, 'stdcxx', 'lib', 'libstdc++.so.6'),
  }
}

/** Todos os artefatos necessários já foram baixados? */
export function speechInstalled(speechDir: string): boolean {
  const p = speechPaths(speechDir)
  return [p.encoder, p.decoder, p.joiner, p.tokens, p.stdcxxLib].every((f) => existsSync(f))
}
```

- [ ] **Step 6: Implementar `worker.mjs`** (roda SÓ no processo filho; nunca importado por testes)

Create `server/src/speech/worker.mjs`:
```js
// Processo filho de transcrição. Carrega o sherpa-onnx (precisa do LD_LIBRARY_PATH
// já definido no spawn) e atende requisições JSON-line: {id, wav} → {id, text|error}.
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const dir = join(process.env.SPEECH_DIR, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
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
  let req
  try { req = JSON.parse(line) } catch { return }
  try {
    const wave = sherpa.readWave(req.wav)
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
    recognizer.decode(stream)
    const text = recognizer.getResult(stream).text.trim()
    process.stdout.write(JSON.stringify({ id: req.id, text }) + '\n')
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: req.id, error: String(e?.message ?? e) }) + '\n')
  }
})
```

- [ ] **Step 7: Implementar o fake worker**

Create `server/test/fake-speech-worker.mjs`:
```js
// Worker falso para testes: mesmo protocolo do worker real, sem sherpa.
// wav contendo "ERRO" → responde erro; contendo "MORRE" → sai sem responder.
import { createInterface } from 'node:readline'

process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.wav.includes('MORRE')) process.exit(1)
  if (req.wav.includes('ERRO')) {
    process.stdout.write(JSON.stringify({ id: req.id, error: 'falha proposital' }) + '\n')
    return
  }
  process.stdout.write(JSON.stringify({ id: req.id, text: `transcrito:${req.wav}` }) + '\n')
})
```

- [ ] **Step 8: Implementar `transcriber.ts`**

Create `server/src/speech/transcriber.ts`:
```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { speechPaths, speechInstalled } from './paths.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
}

interface Pending { resolve: (t: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export function createSpeechService(opts: Opts): SpeechService {
  const workerPath = opts.workerPath ?? join(__dirname, 'worker.mjs')
  const nodeBin = opts.nodeBin ?? process.execPath
  const timeoutMs = opts.timeoutMs ?? 30_000
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
        SPEECH_DIR: opts.speechDir,
        LD_LIBRARY_PATH: [
          dirname(p.stdcxxLib),
          join(opts.serverDir, 'node_modules', 'sherpa-onnx-linux-x64'),
          process.env.LD_LIBRARY_PATH ?? '',
        ].join(':'),
      },
    })
    proc = child
    readyPromise = new Promise<void>((resolve, reject) => {
      const bootTimer = setTimeout(() => reject(new Error('worker de fala não ficou pronto (timeout)')), timeoutMs)
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
        proc = null
        readyPromise = null
        killPending('worker de fala encerrou')
        reject(new Error('worker de fala encerrou no arranque'))
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
```

- [ ] **Step 9: Implementar `setup-speech.mjs`**

Create `server/scripts/setup-speech.mjs`:
```js
// Baixa (1×) o modelo Parakeet v3 int8 e o libstdc++ portátil para ~/.termaster/speech.
// Idempotente: pula o que já existe. Requer curl e tar (validados na máquina alvo).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SPEECH_DIR = process.env.CLAUDINEI_SPEECH ?? join(homedir(), '.termaster', 'speech')
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'
const STDCXX_URL = 'https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-ng-12.2.0-h46fd767_19.tar.bz2'
const MODEL_DIR = join(SPEECH_DIR, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
const STDCXX_LIB = join(SPEECH_DIR, 'stdcxx', 'lib', 'libstdc++.so.6')

mkdirSync(SPEECH_DIR, { recursive: true })

if (existsSync(join(MODEL_DIR, 'tokens.txt'))) {
  console.log(`✓ modelo já instalado em ${MODEL_DIR}`)
} else {
  console.log('⬇ baixando o modelo Parakeet v3 int8 (~630MB — só desta vez)…')
  execSync(`curl -L --fail --progress-bar -o model.tar.bz2 "${MODEL_URL}"`, { cwd: SPEECH_DIR, stdio: 'inherit' })
  console.log('📦 extraindo…')
  execSync('tar xjf model.tar.bz2 && rm model.tar.bz2', { cwd: SPEECH_DIR, stdio: 'inherit' })
  console.log(`✓ modelo instalado em ${MODEL_DIR}`)
}

if (existsSync(STDCXX_LIB)) {
  console.log('✓ libstdc++ portátil já instalado')
} else {
  console.log('⬇ baixando libstdc++ portátil (GLIBCXX_3.4.30, p/ o runtime do sherpa)…')
  mkdirSync(join(SPEECH_DIR, 'stdcxx'), { recursive: true })
  execSync(`curl -L --fail -s -o stdcxx.tar.bz2 "${STDCXX_URL}"`, { cwd: SPEECH_DIR, stdio: 'inherit' })
  execSync('tar xjf stdcxx.tar.bz2 -C stdcxx && rm stdcxx.tar.bz2', { cwd: SPEECH_DIR, stdio: 'inherit' })
  console.log('✓ libstdc++ instalado')
}

console.log('🎤 setup de fala completo.')
```
(Sem teste unitário — script de rede/execSync; o smoke do controlador valida. A lógica de "instalado?" testável vive em `paths.ts`.)

- [ ] **Step 10: Rodar (deve passar)** — `cd server && npm test -- speech` → PASS (todos). Depois `npx tsc --noEmit` limpo e a suíte completa `npm test` verde.

- [ ] **Step 11: Commit**

```bash
git add server/package.json server/package-lock.json package-lock.json server/src/config.ts server/src/speech/ server/scripts/setup-speech.mjs server/test/speech.test.ts server/test/fake-speech-worker.mjs
git commit -m "feat(stt): serviço de fala com Parakeet v3 em processo filho (sherpa-onnx)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(Se o lockfile do workspace for único na raiz, ajuste os paths do add.)

---

### Task 2: Rota `POST /api/transcribe`

**Files:**
- Create: `server/src/routes/transcribe.ts`
- Modify: `server/src/index.ts` (registrar rota + criar o serviço + stop no shutdown)
- Test: `server/test/routes-transcribe.test.ts`

**Interfaces:**
- Consumes: `SpeechService` da Task 1 (`installed()`, `transcribe(wavPath)`).
- Produces: `registerTranscribeRoutes(app, deps: { speech: Pick<SpeechService, 'installed' | 'transcribe'>; uploadsDir: string })`.

- [ ] **Step 1: Teste falhando**

Create `server/test/routes-transcribe.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTranscribeRoutes } from '../src/routes/transcribe.js'

let app: FastifyInstance
let uploadsDir: string

function build(speech: { installed(): boolean; transcribe(p: string): Promise<string> }) {
  app = Fastify()
  uploadsDir = mkdtempSync(join(tmpdir(), 'tr-'))
  return registerTranscribeRoutes(app, { speech, uploadsDir })
}
afterEach(() => app?.close())

const WAV = Buffer.from('RIFFxxxxWAVEfmt ')

describe('POST /api/transcribe', () => {
  it('200 com o texto; o tmp é apagado', async () => {
    await build({ installed: () => true, transcribe: async () => 'olá mundo' })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ text: 'olá mundo' })
    expect(readdirSync(uploadsDir)).toHaveLength(0) // limpou o wav temporário
  })
  it('503 quando o modelo não está instalado', async () => {
    await build({ installed: () => false, transcribe: async () => '' })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toMatch(/setup:speech/)
  })
  it('500 quando o engine falha (e o tmp é apagado)', async () => {
    await build({ installed: () => true, transcribe: async () => { throw new Error('engine quebrou') } })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(500)
    expect(readdirSync(uploadsDir)).toHaveLength(0)
  })
  it('504 quando dá timeout', async () => {
    await build({ installed: () => true, transcribe: async () => { throw new Error('transcrição excedeu o tempo limite') } })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(504)
  })
  it('400 sem corpo', async () => {
    await build({ installed: () => true, transcribe: async () => 'x' })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: Buffer.alloc(0), headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Rodar (falha)** — `npm test -- routes-transcribe` → FAIL.

- [ ] **Step 3: Implementar a rota**

Create `server/src/routes/transcribe.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechService } from '../speech/transcriber.js'

export interface TranscribeDeps {
  speech: Pick<SpeechService, 'installed' | 'transcribe'>
  uploadsDir: string
}

const MAX_WAV_BYTES = 30 * 1024 * 1024 // ~15 min de PCM16 16kHz mono

export async function registerTranscribeRoutes(app: FastifyInstance, deps: TranscribeDeps): Promise<void> {
  // WAV cru no corpo — sem multipart, o navegador manda o Blob direto
  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: MAX_WAV_BYTES }, (_req, body, done) => done(null, body))

  app.post('/api/transcribe', async (req, reply) => {
    if (!deps.speech.installed()) {
      return reply.code(503).send({ error: 'modelo de transcrição não instalado — rode "npm run setup:speech" no server' })
    }
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'corpo vazio — envie o WAV como audio/wav' })
    }
    const tmp = join(deps.uploadsDir, `mic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
    try {
      await writeFile(tmp, body)
      const text = await deps.speech.transcribe(tmp)
      return { text }
    } catch (err) {
      const msg = (err as Error).message
      const code = /tempo limite/.test(msg) ? 504 : 500
      return reply.code(code).send({ error: msg })
    } finally {
      await unlink(tmp).catch(() => {})
    }
  })
}
```

- [ ] **Step 4: Registrar no index**

Em `server/src/index.ts` (seguir o padrão dos outros registers):
```ts
import { registerTranscribeRoutes } from './routes/transcribe.js'
import { createSpeechService } from './speech/transcriber.js'
```
criar o serviço junto dos outros singletons (usar `dirname` do próprio index p/ serverDir):
```ts
const speech = createSpeechService({ speechDir: config.speechDir, serverDir: join(__dirname, '..') })
```
registrar: `await registerTranscribeRoutes(app, { speech, uploadsDir: config.uploadsDir })`
e no shutdown existente (onClose/SIGINT), chamar `await speech.stop()`.
(Se o index não tiver `__dirname`, derive com `fileURLToPath` como no config.ts. `join` já deve estar importado — confira.)

- [ ] **Step 5: Rodar (passa)** — `npm test -- routes-transcribe` PASS; suíte completa + `npx tsc --noEmit` verdes.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/transcribe.ts server/src/index.ts server/test/routes-transcribe.test.ts
git commit -m "feat(stt): rota POST /api/transcribe (WAV cru → texto)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: WAV encoder no navegador + utilitários de áudio

**Files:**
- Create: `web/src/speech/wav.ts`
- Create: `web/src/speech/audio.ts` (recebe `rmsOf` e `normalizePeak`, movidos)
- Modify: `web/src/api.ts` (novo `transcribeAudio`)
- Delete: `web/src/speech/transcriber.ts` (e a dep `@huggingface/transformers`)
- Modify: `web/src/components/MicButton.tsx` e `web/src/components/ChatInput.tsx` (só os IMPORTS de rmsOf — o rework do componente é a Task 4; nesta task o build deve continuar verde)
- Test: `web/src/test/wav.test.ts`; Modify: `web/src/test/transcriber.test.ts` → vira `web/src/test/audio.test.ts` (mantém casos de normalizePeak/rmsOf; casos de whisperLang/pickDevice/MODEL_ID/serialized morrem com o módulo)

**Interfaces:**
- Produces:
  - `pcmToWav(pcm: Float32Array, sampleRate?: number): Blob` (default 16000)
  - `rmsOf(pcm: Float32Array): number` e `normalizePeak(pcm: Float32Array, target?: number): Float32Array` agora em `../speech/audio`
  - `transcribeAudio(wav: Blob): Promise<{ text: string }>` em `api.ts`

- [ ] **Step 1: Teste falhando do WAV**

Create `web/src/test/wav.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pcmToWav } from '../speech/wav'

async function bytes(b: Blob): Promise<DataView> {
  return new DataView(await b.arrayBuffer())
}

describe('pcmToWav', () => {
  it('gera header RIFF/WAVE correto para 16kHz mono PCM16', async () => {
    const blob = pcmToWav(new Float32Array([0, 0.5, -0.5, 1]))
    expect(blob.type).toBe('audio/wav')
    const v = await bytes(blob)
    const str = (off: number, len: number) => Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('')
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 4)).toBe('WAVE')
    expect(str(12, 4)).toBe('fmt ')
    expect(v.getUint32(4, true)).toBe(36 + 8) // riff size = 36 + dados (4 amostras × 2 bytes)
    expect(v.getUint16(20, true)).toBe(1)      // PCM
    expect(v.getUint16(22, true)).toBe(1)      // mono
    expect(v.getUint32(24, true)).toBe(16000)  // sample rate
    expect(v.getUint32(28, true)).toBe(32000)  // byte rate = rate × 2
    expect(v.getUint16(32, true)).toBe(2)      // block align
    expect(v.getUint16(34, true)).toBe(16)     // bits
    expect(str(36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(8)      // data size
  })
  it('converte as amostras para PCM16 little-endian com clamp', async () => {
    const v = await bytes(pcmToWav(new Float32Array([0, 0.5, -1, 2])))
    expect(v.getInt16(44, true)).toBe(0)
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 32767))
    expect(v.getInt16(48, true)).toBe(-32768)
    expect(v.getInt16(50, true)).toBe(32767) // 2 → clamp em 1
  })
})
```

- [ ] **Step 2: Rodar (falha)** — `cd web && npm test -- wav` → FAIL.

- [ ] **Step 3: Implementar `wav.ts`**

Create `web/src/speech/wav.ts`:
```ts
/** Converte PCM Float32 mono em um Blob WAV (PCM16 LE) que o servidor lê direto. */
export function pcmToWav(pcm: Float32Array, sampleRate = 16000): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)          // tamanho do fmt
  v.setUint16(20, 1, true)           // PCM
  v.setUint16(22, 1, true)           // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true)           // block align
  v.setUint16(34, 16, true)          // bits/amostra
  writeStr(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}
```

- [ ] **Step 4: Criar `audio.ts` e apagar o transcriber**

Create `web/src/speech/audio.ts` com `rmsOf` e `normalizePeak` copiados VERBATIM de `web/src/speech/transcriber.ts` (mesmos corpos e JSDoc). Depois:
- `git rm web/src/speech/transcriber.ts`
- Ajustar imports: `MicButton.tsx` importa `rmsOf` de `../speech/audio` (remover import de `loadTranscriber`/`Transcriber` — para o build seguir verde NESTA task, troque o tipo do dep `loadTranscriber` do `MicDeps` por um tipo local temporário `type Transcriber = (pcm: Float32Array, lang: string | null) => Promise<string>` declarado no próprio MicButton.tsx; a Task 4 remove tudo).
- Renomear `web/src/test/transcriber.test.ts` → `web/src/test/audio.test.ts`, mantendo APENAS os describes de `normalizePeak` e `rmsOf` (importando de `../speech/audio`); apagar os de whisperLang/pickDevice/MODEL_ID/serialized.
- `cd web && npm uninstall @huggingface/transformers`

- [ ] **Step 5: `transcribeAudio` no api.ts**

Em `web/src/api.ts`, seguir o padrão do módulo (há um helper `req`; uploads usam fetch direto). Adicionar:
```ts
/** Envia o WAV do microfone para transcrição no backend. Devolve o texto completo. */
export async function transcribeAudio(wav: Blob): Promise<{ text: string }> {
  const res = await fetch('/api/transcribe', { method: 'POST', body: wav, headers: { 'Content-Type': 'audio/wav' } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `transcrição falhou (${res.status})`)
  return data as { text: string }
}
```

- [ ] **Step 6: Rodar (passa)** — `cd web && npm test` (wav 2/2, audio verde, suíte inteira verde — os testes do MicButton continuam passando pois o componente ainda não mudou de comportamento), `npx tsc --noEmit`, `npm run build` exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A web
git commit -m "feat(stt): WAV encoder no navegador, api transcribeAudio e remoção do Whisper/transformers do bundle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Rework do MicButton (gravar → parar → servidor → campo) + i18n

**Files:**
- Modify: `web/src/components/MicButton.tsx` (rework completo)
- Modify: `web/src/components/ChatInput.tsx` (remover prop `lang`)
- Modify: `web/src/i18n/{en,es,pt-BR}.ts` (bloco `mic`: sai `loading`, entra `errTranscribe`)
- Test: `web/src/test/mic-button.test.tsx` (rework) e `web/src/test/mic-chatinput.test.tsx` (ajuste dos mocks), `web/src/test/i18n.test.tsx` (lista de chaves)

**Interfaces:**
- Consumes: `startMicCapture`/`micSupported` de `../speech/recorder`; `rmsOf`/`normalizePeak` de `../speech/audio`; `pcmToWav` de `../speech/wav`; `transcribeAudio` de `../api`.
- Produces: `MicButton(props: { disabled?: boolean; onText: (t: string) => void; onDone: () => void; onError: (msg: string) => void; onStart?: () => void; deps?: MicDeps })` com `interface MicDeps { startMicCapture: typeof startMicCapture; transcribeAudio: typeof transcribeAudio }`.

- [ ] **Step 1: i18n**

Nos 3 dicionários, no bloco `mic`: REMOVER `loading`; ADICIONAR `errTranscribe`:
- en: `errTranscribe: 'Transcription failed — is the server running with the model installed?',`
- es: `errTranscribe: 'La transcripción falló — ¿el servidor está activo con el modelo instalado?',`
- pt-BR: `errTranscribe: 'A transcrição falhou — o servidor está no ar com o modelo instalado?',`
Em `web/src/test/i18n.test.tsx`, na lista de chaves `mic.*`: trocar `'mic.loading'` por `'mic.errTranscribe'`.

- [ ] **Step 2: Testes do MicButton (rework — escrever primeiro)**

Reescrever `web/src/test/mic-button.test.tsx` (substitui o arquivo; os casos de transcrição ao vivo morrem com o pseudo-streaming):
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { MicButton, type MicDeps } from '../components/MicButton'

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

const SPEECH = new Float32Array(1000).fill(0.1) // RMS 0.1 — fala saudável

function makeDeps(text = 'olá mundo', pcm: Float32Array = SPEECH) {
  const stop = vi.fn(() => pcm)
  const deps: MicDeps = {
    startMicCapture: vi.fn(async () => ({ stop })),
    transcribeAudio: vi.fn(async () => ({ text })),
  }
  return { deps, stop }
}

describe('MicButton (transcrição no servidor)', () => {
  it('não renderiza sem suporte a microfone', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    const { container } = render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={makeDeps().deps} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('gravar → parar → envia WAV ao servidor → onText(texto) + onDone', async () => {
    const onText = vi.fn(); const onDone = vi.fn()
    const { deps, stop } = makeDeps('texto final pontuado.')
    render(<MicButton onText={onText} onDone={onDone} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    expect(deps.transcribeAudio).not.toHaveBeenCalled() // nada ao vivo
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onText).toHaveBeenCalledWith('texto final pontuado.'))
    expect(stop).toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
    const sent = (deps.transcribeAudio as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob
    expect(sent.type).toBe('audio/wav')
  })

  it('mostra o estado transcrevendo entre o parar e a resposta', async () => {
    let release!: (v: { text: string }) => void
    const deps: MicDeps = {
      startMicCapture: vi.fn(async () => ({ stop: () => SPEECH })),
      transcribeAudio: vi.fn(() => new Promise((r) => { release = r })),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('…'))
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    release({ text: 'x' })
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('🎤'))
  })

  it('sinal quase mudo → errLowSignal, sem chamar o servidor', async () => {
    const onError = vi.fn()
    const { deps } = makeDeps('x', new Float32Array(1000).fill(0.001))
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Sinal do microfone muito baixo — verifique o ganho/volume do mic.'))
    expect(deps.transcribeAudio).not.toHaveBeenCalled()
  })

  it('falha do servidor → errTranscribe e volta a idle', async () => {
    const onError = vi.fn()
    const deps: MicDeps = {
      startMicCapture: vi.fn(async () => ({ stop: () => SPEECH })),
      transcribeAudio: vi.fn(async () => { throw new Error('offline') }),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('A transcrição falhou — o servidor está no ar com o modelo instalado?'))
    expect(screen.getByRole('button').textContent).toContain('🎤')
  })

  it('permissão negada → errPermission', async () => {
    const onError = vi.fn()
    const deps: MicDeps = {
      startMicCapture: vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
      transcribeAudio: vi.fn(),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Permita o microfone para gravar.'))
  })

  it('onStart dispara quando a gravação começa', async () => {
    const onStart = vi.fn()
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} onStart={onStart} deps={makeDeps().deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
  })

  it('desmontar durante a gravação libera o microfone', async () => {
    const { deps, stop } = makeDeps()
    const { unmount } = render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(deps.startMicCapture).toHaveBeenCalled())
    unmount()
    expect(stop).toHaveBeenCalled()
  })

  it('regravação rápida: resposta atrasada da sessão anterior é descartada', async () => {
    const onText = vi.fn()
    let releaseA!: (v: { text: string }) => void
    const transcribeAudio = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { releaseA = r }))
      .mockResolvedValue({ text: 'B' })
    const deps: MicDeps = { startMicCapture: vi.fn(async () => ({ stop: () => SPEECH })), transcribeAudio }
    render(<MicButton onText={onText} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn) // grava A
    await waitFor(() => expect(deps.startMicCapture).toHaveBeenCalledTimes(1))
    fireEvent.click(btn) // para A → POST pendente
    await waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    fireEvent.click(btn) // grava B
    await waitFor(() => expect(deps.startMicCapture).toHaveBeenCalledTimes(2))
    releaseA({ text: 'A-ATRASADO' })
    await Promise.resolve(); await Promise.resolve()
    expect(onText).not.toHaveBeenCalledWith('A-ATRASADO')
  })
})
```

- [ ] **Step 3: Rodar (falha)** — `npm test -- mic-button` → FAIL (componente antigo).

- [ ] **Step 4: Reescrever o MicButton**

Substituir `web/src/components/MicButton.tsx` por:
```tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { startMicCapture as defaultCapture, micSupported, type MicHandle } from '../speech/recorder'
import { rmsOf, normalizePeak } from '../speech/audio'
import { pcmToWav } from '../speech/wav'
import { transcribeAudio as defaultTranscribe } from '../api'

export interface MicDeps {
  startMicCapture: (onBuffer: (pcm: Float32Array) => void, intervalMs?: number) => Promise<MicHandle>
  transcribeAudio: (wav: Blob) => Promise<{ text: string }>
}

const realDeps: MicDeps = { startMicCapture: defaultCapture, transcribeAudio: defaultTranscribe }

/** Abaixo deste RMS a gravação é ruído de fundo (mic mudo/ganho zerado): fala normal
 *  fica em 0.02–0.15; um mic surdo mede ~0.001. Transcrever isso só gera alucinação. */
const LOW_SIGNAL_RMS = 0.005

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Botão de microfone: grava → parar → transcreve NO SERVIDOR (Parakeet) → preenche
 * o campo via `onText` com o texto completo. Só edita texto; o envio é do ChatInput.
 */
export function MicButton({
  disabled,
  onText,
  onDone,
  onError,
  onStart,
  deps = realDeps,
}: {
  disabled?: boolean
  onText: (t: string) => void
  onDone: () => void
  onError: (msg: string) => void
  onStart?: () => void
  deps?: MicDeps
}): JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [secs, setSecs] = useState(0)
  const handleRef = useRef<MicHandle | null>(null)
  const genRef = useRef(0) // id da sessão de gravação; invalida resultados de sessões antigas

  useEffect(() => {
    if (state !== 'recording') return
    setSecs(0)
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [state])

  // Ao desmontar: invalida a sessão em voo e libera o microfone.
  useEffect(() => () => {
    genRef.current++
    handleRef.current?.stop()
    handleRef.current = null
  }, [])

  if (!micSupported()) return null

  const startRecording = async () => {
    const gen = ++genRef.current
    try {
      const handle = await deps.startMicCapture(() => {}) // sem parciais — transcrição só no parar
      if (genRef.current !== gen) {
        handle.stop() // sessão abandonada durante o start → libera o microfone
        return
      }
      handleRef.current = handle
      setState('recording')
      onStart?.()
    } catch (err) {
      if (genRef.current !== gen) return
      const name = (err as { name?: string })?.name
      onError(name === 'NotAllowedError' || name === 'SecurityError' ? t('mic.errPermission') : t('mic.errTranscribe'))
    }
  }

  const stopRecording = async () => {
    const handle = handleRef.current
    if (!handle) return
    handleRef.current = null
    const gen = genRef.current
    genRef.current++
    const pcm = handle.stop()
    if (pcm.length === 0) { setState('idle'); onDone(); return }
    if (rmsOf(pcm) < LOW_SIGNAL_RMS) {
      setState('idle')
      onError(t('mic.errLowSignal'))
      onDone()
      return
    }
    setState('transcribing')
    try {
      const { text } = await deps.transcribeAudio(pcmToWav(normalizePeak(pcm)))
      if (genRef.current === gen + 1) onText(text)
    } catch {
      if (genRef.current === gen + 1) onError(t('mic.errTranscribe'))
    } finally {
      if (genRef.current === gen + 1) {
        setState('idle')
        onDone()
      }
    }
  }

  const onClick = () => {
    if (state === 'recording') void stopRecording()
    else if (state === 'idle') void startRecording()
  }

  const label = state === 'recording' ? t('mic.stop') : state === 'transcribing' ? t('mic.transcribing') : t('mic.start')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || state === 'transcribing'}
      className={state === 'recording' ? 'input-action mic-btn--rec' : 'input-action'}
      onClick={onClick}
    >
      {state === 'transcribing' ? '…' : state === 'recording' ? `⏺ ${fmt(secs)}` : '🎤'}
    </button>
  )
}
```
Nota: no caminho de regravação rápida, quem fecha o estado `transcribing`→`idle` da sessão superada é o próprio `startRecording` da nova sessão (que seta `recording`); o `finally` gateado evita o "idle" atropelar a nova gravação. Confira com o teste de regravação rápida.
ATENÇÃO: quando a sessão foi SUPERADA (`genRef.current !== gen + 1`), o `finally` não seta estado — mas a nova sessão só nasce via clique em `idle`. Como `stopRecording` seta `transcribing` de forma síncrona antes do clique seguinte poder ocorrer, e o clique em `transcribing` é ignorado pelo `disabled`, a "regravação rápida" do teste acontece ANTES do próximo clique físico ser possível? Não: o teste clica com o POST pendente e o botão `disabled`… **Ajuste**: para permitir regravar sem esperar o POST (requisito do teste), o botão em `transcribing` NÃO deve ficar `disabled`; clique em `transcribing` inicia gravação nova (`startRecording`), que invalida a sessão pendente. Implementar `onClick`:
```tsx
  const onClick = () => {
    if (state === 'recording') void stopRecording()
    else void startRecording() // idle OU transcribing: começar nova gravação invalida a anterior
  }
```
e REMOVER `state === 'transcribing'` do `disabled` (fica só `disabled={disabled}`). O teste "mostra o estado transcrevendo" então NÃO deve asserir `disabled` — asserir apenas o conteúdo `…`. (Esta é a versão final; o snippet de teste do Step 2 já deve ser escrito assim: remova a linha do `disabled` ao escrevê-lo.)

- [ ] **Step 5: ChatInput sem `lang`**

Em `web/src/components/ChatInput.tsx`, o `<MicButton …>` perde a linha `lang={null}` (prop não existe mais). Nada mais muda.
Em `web/src/test/mic-chatinput.test.tsx`: os `vi.mock` de `../speech/transcriber` saem (módulo morto); mockar em vez disso `../api` (`transcribeAudio: vi.fn(async () => ({ text: 'ditado' }))` e demais casos) e manter o mock de `../speech/recorder`. Os DOIS testes de regressão de base (stale/duplicação) se adaptam: agora há UMA aplicação de texto por gravação (sem parciais) — o teste "posição do cursor" continua válido (parar → 'ditado' entra no cursor); o teste de duplicação vira: parar A com POST pendente → gravar B → parar B (POST resolve 'dois') → resposta atrasada de A ('um') NÃO sobrescreve nem duplica (campo contém só o resultado de B na base de B).

- [ ] **Step 6: Rodar tudo (passa)** — `cd web && npm test` verde inteiro; `npx tsc --noEmit`; `npm run build` exit 0. `cd server && npm test` verde (nada do server mudou nesta task, mas confirme).

- [ ] **Step 7: Commit**

```bash
git add -A web
git commit -m "feat(stt): MicButton grava e transcreve no servidor (Parakeet) — fim do pseudo-streaming

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Smoke (controlador, após as tasks)

1. Pré-seed local: copiar o modelo + stdcxx do spike (`$SCRATCHPAD/parakeet-spike/`) para `~/.termaster/speech/` (mesma estrutura do setup) — evita re-baixar 630MB.
2. `npm run setup:speech` no server → deve dizer "já instalado" (idempotência provada).
3. Backend no ar → `curl -X POST --data-binary @jfk.wav -H 'Content-Type: audio/wav' http://127.0.0.1:4832/api/transcribe` → JSON com a frase do JFK pontuada.
4. Browser (playwright): UI com o botão 🎤 visível, grupo coeso; gravação real de microfone fica para o usuário (máquina/mic dele).
5. Latência: 2ª chamada ao endpoint deve ser <1s (worker quente).

## Self-Review (autor do plano)

- **Cobertura do spec:** setup 1× (T1 Step 9 + npm script), processo filho com LD_LIBRARY_PATH (T1 Step 8), rota 503/500/504/tmp-cleanup (T2), WAV client-side (T3), MicButton estados idle/recording/transcribing + low-signal + genRef (T4), remoção do Whisper/transformers do web (T3), i18n errTranscribe/paridade (T4), fluxo revisar-antes-de-enviar preservado (ChatInput intocado exceto prop). ✔
- **Placeholders:** nenhum — todo step tem código/comando/expected completos. ✔
- **Consistência de tipos:** `SpeechService` (T1) = consumido em T2 via `Pick`; `MicDeps { startMicCapture, transcribeAudio }` consistente entre T4 Step 2 e Step 4; `pcmToWav`/`rmsOf`/`normalizePeak`/`transcribeAudio` batem entre T3 e T4. `workerArgs` presente nas opts (T1 teste e implementação). ✔
- **Ordem:** T3 mantém o build verde antes do rework (tipo temporário no MicButton) — verificado no Step 4 da T3. ✔
