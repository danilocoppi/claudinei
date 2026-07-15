# Microfone com transcrição local (Whisper) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um botão de microfone no campo de mensagem do chat que grava a voz e a transcreve 100% localmente (Whisper via transformers.js), mostrando o texto ao vivo no campo de digitar (pseudo-streaming), para o usuário revisar e enviar.

**Architecture:** Whisper roda no navegador via `@huggingface/transformers` (ONNX, WebGPU se disponível, WASM como fallback). A lib e o modelo carregam sob demanda (dynamic `import()`) só no 1º uso do microfone. A captura de áudio usa Web Audio (PCM 16kHz mono); a cada ~1,5s o buffer acumulado é re-transcrito e o texto atualiza o campo. Camadas isoladas: `speech/transcriber.ts` (motor Whisper), `speech/recorder.ts` (captura), `speech/insert.ts` (mesclagem de texto), `MicButton.tsx` (UI/orquestração), integração no `ChatInput.tsx`.

**Tech Stack:** React 18 + TypeScript strict, Vite 6, react-i18next, `@huggingface/transformers` v3, Web Audio API, Vitest + @testing-library/react.

## Global Constraints

- **Idioma (código e i18n):** português com acentuação correta; nunca trocar acentos por ASCII. Textos de UI vêm do i18n nas 3 línguas (en, es, pt-BR).
- **Commit trailer** (toda mensagem de commit termina com):
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Imports no web omitem extensão** (`from '../store'`), como no restante de `web/src`. NÃO usar sufixo `.js`.
- **transformers.js só via dynamic `import('@huggingface/transformers')`** dentro de `loadTranscriber` — nunca import no topo de módulo (não pode inflar o bundle inicial nem entrar em testes jsdom).
- **Modelo tunável:** `MODEL_ID = 'onnx-community/whisper-base'` numa constante exportada em `speech/transcriber.ts`.
- **Idiomas do Whisper** passados como nome em minúsculas: `'portuguese' | 'english' | 'spanish'`.
- **TDD:** cada task escreve o teste primeiro, vê falhar, implementa, vê passar, commita.
- **Testes web rodam com** `npm test` em `web/` (Vitest). Server intocado nesta feature.

---

### Task 1: Motor de transcrição (`speech/transcriber.ts`)

Camada que carrega o Whisper sob demanda e transcreve PCM. Helpers puros (`whisperLang`, `pickDevice`) são testáveis sem tocar na lib; `loadTranscriber`/`transcribe` fazem o dynamic import e não entram nos testes unitários.

**Files:**
- Modify: `web/package.json` (adicionar dependência `@huggingface/transformers`)
- Create: `web/src/speech/transcriber.ts`
- Test: `web/src/test/transcriber.test.ts`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces:
  - `type Transcriber = (pcm: Float32Array, lang: string) => Promise<string>`
  - `const MODEL_ID: string`
  - `function whisperLang(locale: string): 'portuguese' | 'english' | 'spanish'`
  - `function pickDevice(): Promise<'webgpu' | 'wasm'>`
  - `function loadTranscriber(onProgress?: (p: number) => void): Promise<Transcriber>`

- [ ] **Step 1: Adicionar a dependência**

Run (em `web/`):
```bash
npm install @huggingface/transformers@^3
```
Expected: `package.json` passa a listar `"@huggingface/transformers"` em `dependencies`; instala sem erro.

- [ ] **Step 2: Escrever o teste (falha)**

Create `web/src/test/transcriber.test.ts`:
```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { whisperLang, pickDevice, MODEL_ID } from '../speech/transcriber'

describe('whisperLang', () => {
  it('mapeia locale do app para o nome de idioma do Whisper', () => {
    expect(whisperLang('pt-BR')).toBe('portuguese')
    expect(whisperLang('en')).toBe('english')
    expect(whisperLang('es')).toBe('spanish')
  })
  it('locale desconhecido cai em português (default do app)', () => {
    expect(whisperLang('fr')).toBe('portuguese')
    expect(whisperLang('')).toBe('portuguese')
  })
})

describe('pickDevice', () => {
  const original = (globalThis.navigator as any).gpu
  afterEach(() => { (globalThis.navigator as any).gpu = original })

  it('sem navigator.gpu → wasm', async () => {
    ;(globalThis.navigator as any).gpu = undefined
    expect(await pickDevice()).toBe('wasm')
  })
  it('com adapter WebGPU → webgpu', async () => {
    ;(globalThis.navigator as any).gpu = { requestAdapter: vi.fn().mockResolvedValue({}) }
    expect(await pickDevice()).toBe('webgpu')
  })
  it('gpu presente mas sem adapter → wasm', async () => {
    ;(globalThis.navigator as any).gpu = { requestAdapter: vi.fn().mockResolvedValue(null) }
    expect(await pickDevice()).toBe('wasm')
  })
  it('requestAdapter lança → wasm', async () => {
    ;(globalThis.navigator as any).gpu = { requestAdapter: vi.fn().mockRejectedValue(new Error('x')) }
    expect(await pickDevice()).toBe('wasm')
  })
})

describe('MODEL_ID', () => {
  it('aponta para whisper-base', () => {
    expect(MODEL_ID).toBe('onnx-community/whisper-base')
  })
})
```

- [ ] **Step 3: Rodar o teste (deve falhar)**

Run (em `web/`): `npm test -- transcriber`
Expected: FAIL — módulo `../speech/transcriber` não existe.

- [ ] **Step 4: Implementar**

Create `web/src/speech/transcriber.ts`:
```ts
/** Motor de transcrição Whisper 100% local (transformers.js). Carrega sob demanda. */

export type Transcriber = (pcm: Float32Array, lang: string) => Promise<string>

/** Modelo ONNX multilíngue. Trocar aqui para tiny/small se precisar de mais velocidade/precisão. */
export const MODEL_ID = 'onnx-community/whisper-base'

/** Mapeia o locale do app para o nome de idioma que o Whisper espera. Default: português. */
export function whisperLang(locale: string): 'portuguese' | 'english' | 'spanish' {
  if (locale.startsWith('es')) return 'spanish'
  if (locale.startsWith('en')) return 'english'
  return 'portuguese'
}

/** Escolhe WebGPU se houver adapter; senão WASM (CPU). Nunca lança. */
export async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu
    if (gpu?.requestAdapter && (await gpu.requestAdapter())) return 'webgpu'
  } catch {
    /* sem WebGPU utilizável — cai para WASM */
  }
  return 'wasm'
}

let cached: Promise<Transcriber> | null = null

/** Carrega a lib + o modelo (1x, memoizado) e devolve a função de transcrição. */
export function loadTranscriber(onProgress?: (p: number) => void): Promise<Transcriber> {
  if (!cached) cached = build(onProgress)
  return cached
}

async function build(onProgress?: (p: number) => void): Promise<Transcriber> {
  const { pipeline } = await import('@huggingface/transformers')
  const device = await pickDevice()
  const asr = await pipeline('automatic-speech-recognition', MODEL_ID, {
    device,
    progress_callback: onProgress
      ? (p: { status?: string; progress?: number }) => {
          if (p.status === 'progress' && typeof p.progress === 'number') onProgress(p.progress)
        }
      : undefined,
  })
  return async (pcm: Float32Array, lang: string) => {
    const out = await asr(pcm, { language: lang, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 })
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
    return (text ?? '').trim()
  }
}
```

- [ ] **Step 5: Rodar o teste (deve passar)**

Run (em `web/`): `npm test -- transcriber`
Expected: PASS (todos os casos). Rode também `npx tsc --noEmit` e confirme sem erros.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/speech/transcriber.ts web/src/test/transcriber.test.ts
git commit -m "feat(mic): motor de transcrição Whisper local (transformers.js)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Captura de áudio (`speech/recorder.ts`)

Captura o microfone como PCM 16kHz mono e entrega o buffer acumulado a cada intervalo. `micSupported` e `concatFloat32` são puros/testáveis; `startMicCapture` é camada fina sobre Web Audio (smoke manual).

**Files:**
- Create: `web/src/speech/recorder.ts`
- Test: `web/src/test/recorder.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `function micSupported(): boolean`
  - `function concatFloat32(chunks: Float32Array[]): Float32Array`
  - `interface MicHandle { stop: () => Float32Array }`
  - `function startMicCapture(onBuffer: (pcm: Float32Array) => void, intervalMs?: number): Promise<MicHandle>`

- [ ] **Step 1: Escrever o teste (falha)**

Create `web/src/test/recorder.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { micSupported, concatFloat32 } from '../speech/recorder'

describe('concatFloat32', () => {
  it('junta vários chunks preservando a ordem', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })
  it('lista vazia → Float32Array vazio', () => {
    expect(concatFloat32([]).length).toBe(0)
  })
})

describe('micSupported', () => {
  const original = navigator.mediaDevices
  afterEach(() => { Object.defineProperty(navigator, 'mediaDevices', { value: original, configurable: true }) })

  it('true quando há getUserMedia', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => {} }, configurable: true })
    expect(micSupported()).toBe(true)
  })
  it('false quando não há mediaDevices', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    expect(micSupported()).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar o teste (deve falhar)**

Run (em `web/`): `npm test -- recorder`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

Create `web/src/speech/recorder.ts`:
```ts
/** Captura do microfone como PCM 16kHz mono para o Whisper. */

export interface MicHandle {
  /** Encerra a captura e devolve o buffer final acumulado. Idempotente. */
  stop: () => Float32Array
}

/** Há suporte a captura de microfone neste navegador? */
export function micSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

/** Concatena chunks Float32 num único buffer, preservando a ordem. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Float32Array(len)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * Começa a capturar o microfone. A cada `intervalMs`, chama `onBuffer` com o
 * buffer PCM acumulado (16kHz mono). Retorna um handle cujo `stop()` encerra
 * tudo e devolve o buffer final. Camada fina sobre Web Audio — smoke manual.
 */
export async function startMicCapture(
  onBuffer: (pcm: Float32Array) => void,
  intervalMs = 1500,
): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ac = new Ctx({ sampleRate: 16000 })
  const source = ac.createMediaStreamSource(stream)
  const processor = ac.createScriptProcessor(4096, 1, 1)
  const mute = ac.createGain()
  mute.gain.value = 0 // evita eco: processa sem tocar o som de volta
  const chunks: Float32Array[] = []
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  processor.connect(mute)
  mute.connect(ac.destination)
  const timer = setInterval(() => onBuffer(concatFloat32(chunks)), intervalMs)

  let stopped = false
  return {
    stop() {
      if (!stopped) {
        stopped = true
        clearInterval(timer)
        processor.disconnect()
        source.disconnect()
        mute.disconnect()
        stream.getTracks().forEach((t) => t.stop())
        void ac.close()
      }
      return concatFloat32(chunks)
    },
  }
}
```

- [ ] **Step 4: Rodar o teste (deve passar)**

Run (em `web/`): `npm test -- recorder`
Expected: PASS. Rode `npx tsc --noEmit` e confirme sem erros.

- [ ] **Step 5: Commit**

```bash
git add web/src/speech/recorder.ts web/src/test/recorder.test.ts
git commit -m "feat(mic): captura de áudio do microfone (PCM 16kHz)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Textos i18n do microfone (`mic.*`)

Adiciona o bloco `mic` nas 3 línguas e um teste garantindo paridade.

**Files:**
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/es.ts`, `web/src/i18n/pt-BR.ts`
- Test: `web/src/test/i18n.test.tsx` (adicionar um `it`)

**Interfaces:**
- Consumes: nada.
- Produces: chaves `mic.start`, `mic.stop`, `mic.loading`, `mic.transcribing`, `mic.errPermission`, `mic.errModel` nas 3 línguas.

- [ ] **Step 1: Escrever o teste (falha)**

Add ao final do `describe('i18n', …)` em `web/src/test/i18n.test.tsx` (antes do `})` que fecha o describe):
```tsx
  it('tem as chaves do microfone nas 3 línguas', async () => {
    for (const lng of ['en', 'es', 'pt-BR'] as const) {
      await i18n.changeLanguage(lng)
      for (const k of ['mic.start', 'mic.stop', 'mic.loading', 'mic.transcribing', 'mic.errPermission', 'mic.errModel']) {
        expect(i18n.t(k), `${k} em ${lng}`).not.toBe(k) // resolveu (não devolveu a própria chave)
      }
    }
    await i18n.changeLanguage('pt-BR')
  })
```

- [ ] **Step 2: Rodar o teste (deve falhar)**

Run (em `web/`): `npm test -- i18n`
Expected: FAIL — chaves `mic.*` não resolvem (retornam a própria chave).

- [ ] **Step 3: Implementar — adicionar o bloco `mic`**

Em `web/src/i18n/en.ts`, adicionar como um novo membro do objeto raiz (ex.: logo após o bloco `chat: { … },`):
```ts
  mic: {
    start: 'Record audio',
    stop: 'Stop recording',
    loading: 'Loading transcription model…',
    transcribing: 'transcribing…',
    errPermission: 'Allow the microphone to record.',
    errModel: 'Could not load the transcription model.',
  },
```

Em `web/src/i18n/es.ts`:
```ts
  mic: {
    start: 'Grabar audio',
    stop: 'Detener grabación',
    loading: 'Cargando modelo de transcripción…',
    transcribing: 'transcribiendo…',
    errPermission: 'Permite el micrófono para grabar.',
    errModel: 'No se pudo cargar el modelo de transcripción.',
  },
```

Em `web/src/i18n/pt-BR.ts`:
```ts
  mic: {
    start: 'Gravar áudio',
    stop: 'Parar gravação',
    loading: 'Carregando modelo de transcrição…',
    transcribing: 'transcrevendo…',
    errPermission: 'Permita o microfone para gravar.',
    errModel: 'Não foi possível carregar o modelo de transcrição.',
  },
```

- [ ] **Step 4: Rodar o teste (deve passar)**

Run (em `web/`): `npm test -- i18n`
Expected: PASS. Rode `npx tsc --noEmit` (os três objetos de idioma devem ter a mesma forma, senão o TS acusa).

- [ ] **Step 5: Commit**

```bash
git add web/src/i18n/en.ts web/src/i18n/es.ts web/src/i18n/pt-BR.ts web/src/test/i18n.test.tsx
git commit -m "feat(mic): textos i18n do microfone (en/es/pt-BR)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Botão do microfone (`MicButton.tsx`)

Componente que orquestra: carrega o transcriber, inicia a captura, transcreve ao vivo (sem transcrições concorrentes), mostra timer, e trata erros. Dependências injetáveis para teste.

**Files:**
- Create: `web/src/components/MicButton.tsx`
- Modify: `web/src/styles.css` (classes `.mic-btn` e `.mic-btn--rec`)
- Test: `web/src/test/mic-button.test.tsx`

**Interfaces:**
- Consumes: `loadTranscriber`, `type Transcriber` de `../speech/transcriber`; `startMicCapture`, `micSupported`, `type MicHandle` de `../speech/recorder`.
- Produces:
  - `interface MicDeps { loadTranscriber: (onProgress?: (p: number) => void) => Promise<Transcriber>; startMicCapture: (onBuffer: (pcm: Float32Array) => void, intervalMs?: number) => Promise<MicHandle> }`
  - `function MicButton(props: { lang: string; disabled?: boolean; onText: (t: string) => void; onDone: () => void; onError: (msg: string) => void; deps?: MicDeps }): JSX.Element | null`

- [ ] **Step 1: Escrever o teste (falha)**

Create `web/src/test/mic-button.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { MicButton, type MicDeps } from '../components/MicButton'

// jsdom não tem mediaDevices: fornecemos um stub para micSupported() dar true.
beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

/** deps que capturam o onBuffer para dirigirmos a "transcrição ao vivo" no teste. */
function makeDeps(transcript = 'olá mundo') {
  let captured: ((pcm: Float32Array) => void) | null = null
  const stop = vi.fn(() => new Float32Array([1, 2, 3]))
  const deps: MicDeps = {
    loadTranscriber: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(transcript)),
    startMicCapture: vi.fn(async (onBuffer) => { captured = onBuffer; return { stop } }),
  }
  return { deps, stop, feed: (pcm: Float32Array) => captured!(pcm) }
}

describe('MicButton', () => {
  it('não renderiza quando o microfone não é suportado', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    const { container } = render(<MicButton lang="portuguese" onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={makeDeps().deps} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('clicar inicia a gravação e um buffer transcreve ao vivo (onText)', async () => {
    const onText = vi.fn()
    const { deps, feed } = makeDeps('texto transcrito')
    render(<MicButton lang="portuguese" onText={onText} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(deps.startMicCapture).toHaveBeenCalled())
    // botão passou a mostrar o estado gravando (⏺)
    expect(screen.getByRole('button').textContent).toContain('⏺')
    await feed(new Float32Array([0.1, 0.2]))
    await waitFor(() => expect(onText).toHaveBeenCalledWith('texto transcrito'))
  })

  it('clicar de novo para a gravação, faz a transcrição final e chama onDone', async () => {
    const onText = vi.fn()
    const onDone = vi.fn()
    const { deps, stop } = makeDeps('final')
    render(<MicButton lang="portuguese" onText={onText} onDone={onDone} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(stop).toHaveBeenCalled()
    expect(onText).toHaveBeenCalledWith('final')
  })

  it('permissão negada → onError com a mensagem de permissão e volta a idle', async () => {
    const onError = vi.fn()
    const deps: MicDeps = {
      loadTranscriber: vi.fn().mockResolvedValue(vi.fn()),
      startMicCapture: vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
    }
    render(<MicButton lang="portuguese" onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Permita o microfone para gravar.'))
    expect(screen.getByRole('button').textContent).toContain('🎤')
  })
})
```

(O teste roda com i18n em pt-BR, o default dos testes — ver `web/src/test` setup — então `t('mic.errPermission')` resolve para o texto pt-BR.)

- [ ] **Step 2: Rodar o teste (deve falhar)**

Run (em `web/`): `npm test -- mic-button`
Expected: FAIL — componente não existe.

- [ ] **Step 3: Implementar**

Create `web/src/components/MicButton.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { loadTranscriber as defaultLoad, type Transcriber } from '../speech/transcriber'
import { startMicCapture as defaultCapture, micSupported, type MicHandle } from '../speech/recorder'

export interface MicDeps {
  loadTranscriber: (onProgress?: (p: number) => void) => Promise<Transcriber>
  startMicCapture: (onBuffer: (pcm: Float32Array) => void, intervalMs?: number) => Promise<MicHandle>
}

const realDeps: MicDeps = { loadTranscriber: defaultLoad, startMicCapture: defaultCapture }

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Botão de microfone: grava → transcreve ao vivo (pseudo-streaming) → preenche
 * o campo via `onText`. Só edita texto; o envio segue as regras do ChatInput.
 */
export function MicButton({
  lang,
  disabled,
  onText,
  onDone,
  onError,
  deps = realDeps,
}: {
  lang: string
  disabled?: boolean
  onText: (t: string) => void
  onDone: () => void
  onError: (msg: string) => void
  deps?: MicDeps
}): JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'loading' | 'recording'>('idle')
  const [secs, setSecs] = useState(0)
  const handleRef = useRef<MicHandle | null>(null)
  const transRef = useRef<Transcriber | null>(null)
  const busyRef = useRef(false) // impede transcrições concorrentes sobre o mesmo buffer

  useEffect(() => {
    if (state !== 'recording') return
    setSecs(0)
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [state])

  if (!micSupported()) return null

  const startRecording = async () => {
    try {
      setState('loading')
      if (!transRef.current) transRef.current = await deps.loadTranscriber()
      const transcribe = transRef.current
      const onBuffer = async (pcm: Float32Array) => {
        if (busyRef.current || pcm.length === 0) return
        busyRef.current = true
        try {
          onText(await transcribe(pcm, lang))
        } catch {
          /* transcrição parcial falhou; ignora e tenta no próximo buffer */
        } finally {
          busyRef.current = false
        }
      }
      handleRef.current = await deps.startMicCapture(onBuffer)
      setState('recording')
    } catch (err) {
      setState('idle')
      const name = (err as { name?: string })?.name
      onError(name === 'NotAllowedError' || name === 'SecurityError' ? t('mic.errPermission') : t('mic.errModel'))
    }
  }

  const stopRecording = async () => {
    const handle = handleRef.current
    handleRef.current = null
    setState('idle')
    if (!handle) return
    const pcm = handle.stop()
    if (transRef.current && pcm.length > 0) {
      try {
        onText(await transRef.current(pcm, lang))
      } catch {
        /* mantém o texto parcial já exibido */
      }
    }
    onDone()
  }

  const onClick = () => {
    if (state === 'recording') void stopRecording()
    else if (state === 'idle') void startRecording()
  }

  const label = state === 'recording' ? t('mic.stop') : state === 'loading' ? t('mic.loading') : t('mic.start')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || state === 'loading'}
      className={state === 'recording' ? 'mic-btn mic-btn--rec' : 'mic-btn'}
      onClick={onClick}
    >
      {state === 'loading' ? '…' : state === 'recording' ? `⏺ ${fmt(secs)}` : '🎤'}
    </button>
  )
}
```

- [ ] **Step 4: Estilo do botão**

Add ao final de `web/src/styles.css` (reaproveita o keyframe `pulse` já existente):
```css
.mic-btn {
  background: transparent;
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  padding: 0 10px;
  font-size: 16px;
  cursor: pointer;
  color: var(--text-dim);
}
.mic-btn--rec {
  color: var(--err);
  border-color: var(--err);
  animation: pulse 1s infinite;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Rodar o teste (deve passar)**

Run (em `web/`): `npm test -- mic-button`
Expected: PASS (4/4). Rode `npx tsc --noEmit` — sem erros.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/MicButton.tsx web/src/styles.css web/src/test/mic-button.test.tsx
git commit -m "feat(mic): botão do microfone com transcrição ao vivo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Integração no `ChatInput.tsx`

Coloca o `MicButton` ao lado dos controles; o texto transcrito entra no campo na posição do cursor via helper puro `mergeTranscript`; erros do microfone aparecem na linha de aviso.

**Files:**
- Create: `web/src/speech/insert.ts`
- Modify: `web/src/components/ChatInput.tsx`
- Test: `web/src/test/insert.test.ts` (helper puro) e `web/src/test/mic-chatinput.test.tsx` (integração)

**Interfaces:**
- Consumes: `MicButton` de `./MicButton`; `whisperLang` de `../speech/transcriber`; `micSupported`+`startMicCapture` (mockados no teste de integração).
- Produces: `function mergeTranscript(before: string, after: string, tx: string): string`

- [ ] **Step 1: Escrever o teste do helper (falha)**

Create `web/src/test/insert.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mergeTranscript } from '../speech/insert'

describe('mergeTranscript', () => {
  it('insere entre before e after com espaço quando before não termina em espaço', () => {
    expect(mergeTranscript('olá', ' fim', 'mundo')).toBe('olá mundo fim')
  })
  it('não duplica espaço quando before já termina em espaço', () => {
    expect(mergeTranscript('olá ', '', 'mundo')).toBe('olá mundo')
  })
  it('before vazio → sem espaço à esquerda', () => {
    expect(mergeTranscript('', '', 'mundo')).toBe('mundo')
  })
  it('before terminando em quebra de linha → sem espaço extra', () => {
    expect(mergeTranscript('linha\n', '', 'mundo')).toBe('linha\nmundo')
  })
})
```

- [ ] **Step 2: Rodar (deve falhar)**

Run (em `web/`): `npm test -- insert`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o helper**

Create `web/src/speech/insert.ts`:
```ts
/** Mescla o texto transcrito entre `before` e `after`, cuidando do espaçamento. */
export function mergeTranscript(before: string, after: string, tx: string): string {
  const sep = before && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
  return before + sep + tx + after
}
```

- [ ] **Step 4: Rodar (deve passar)**

Run (em `web/`): `npm test -- insert`
Expected: PASS (4/4).

- [ ] **Step 5: Escrever o teste de integração (falha)**

Create `web/src/test/mic-chatinput.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

// Mocka as camadas de fala para o MicButton real rodar sem tocar transformers/Web Audio.
let captured: ((pcm: Float32Array) => void) | null = null
vi.mock('../speech/recorder', () => ({
  micSupported: () => true,
  startMicCapture: vi.fn(async (onBuffer: (pcm: Float32Array) => void) => {
    captured = onBuffer
    return { stop: () => new Float32Array([1]) }
  }),
}))
vi.mock('../speech/transcriber', async (orig) => ({
  ...(await orig<typeof import('../speech/transcriber')>()),
  loadTranscriber: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue('ditado')),
}))

import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

beforeEach(() => {
  captured = null
  useStore.setState({ chat: {}, sessions: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => cleanup())

const renderInput = () =>
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)

describe('microfone no ChatInput', () => {
  it('transcrição entra no campo na posição do cursor', async () => {
    renderInput()
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'nota:' } })
    textarea.setSelectionRange(5, 5)
    fireEvent.click(screen.getByLabelText('Gravar áudio'))
    await waitFor(() => expect(captured).not.toBeNull())
    await captured!(new Float32Array([0.1]))
    await waitFor(() => expect(textarea.value).toBe('nota: ditado'))
  })
})
```

- [ ] **Step 6: Rodar (deve falhar)**

Run (em `web/`): `npm test -- mic-chatinput`
Expected: FAIL — `ChatInput` ainda não renderiza o `MicButton` nem insere o texto.

- [ ] **Step 7: Integrar no `ChatInput.tsx`**

Modificações em `web/src/components/ChatInput.tsx`:

1. Imports (adicionar):
```tsx
import { MicButton } from './MicButton'
import { mergeTranscript } from '../speech/insert'
import { whisperLang } from '../speech/transcriber'
```

2. Trocar `const { t } = useTranslation()` por:
```tsx
  const { t, i18n } = useTranslation()
```

3. Adicionar estado do microfone junto aos demais `useState`/`useRef` (perto de `uploadError`):
```tsx
  const [micError, setMicError] = useState<string | null>(null)
  const micBase = useRef<{ before: string; after: string } | null>(null)
```

4. Adicionar os handlers (perto de `pickSlash`):
```tsx
  // Ao 1º trecho transcrito da gravação, fixa a base (texto+cursor); os trechos
  // seguintes substituem a mesma região, crescendo ao vivo. endMic zera para a
  // próxima gravação.
  const applyTranscript = (tx: string) => {
    if (!micBase.current) {
      const pos = areaRef.current?.selectionStart ?? text.length
      micBase.current = { before: text.slice(0, pos), after: text.slice(pos) }
    }
    const { before, after } = micBase.current
    setText(mergeTranscript(before, after, tx))
    setMicError(null)
  }
  const endMic = () => { micBase.current = null }
```

5. No JSX, adicionar o `MicButton` imediatamente antes de `{session && <SessionControls … />}`:
```tsx
        <MicButton
          lang={whisperLang(i18n.language)}
          disabled={disabled}
          onText={applyTranscript}
          onDone={endMic}
          onError={setMicError}
        />
```

6. Trocar o bloco de aviso final para incluir o erro do microfone:
```tsx
      {(uploadError || micError) && (
        <div style={{ color: 'var(--err)', fontSize: 12, marginTop: 6 }}>⚠ {uploadError ?? micError}</div>
      )}
```

- [ ] **Step 8: Rodar os testes de integração (devem passar)**

Run (em `web/`): `npm test -- mic-chatinput`
Expected: PASS. Rode também `npm test -- chatinput-upload chatinput-slash` para garantir que a integração não quebrou o campo existente.

- [ ] **Step 9: Suíte completa + tsc + build**

Run (em `web/`):
```bash
npm test
npx tsc --noEmit
npm run build
```
Expected: todos os testes passam; tsc sem erros; build sai com exit 0.

- [ ] **Step 10: Commit**

```bash
git add web/src/speech/insert.ts web/src/components/ChatInput.tsx web/src/test/insert.test.ts web/src/test/mic-chatinput.test.tsx
git commit -m "feat(mic): integra o microfone no campo de mensagem do chat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Smoke manual (após todas as tasks)

O motor Whisper real (WASM/WebGPU) e a captura de áudio não entram nos testes unitários. Validar no navegador real (Chrome do usuário):

1. `npm run dev` no web + backend rodando.
2. Abrir um chat, clicar 🎤 → aceitar a permissão do microfone.
3. 1ª vez: aparece "…"/carregando enquanto baixa o modelo (~145MB, 1x).
4. Falar uma frase em português → ver o texto aparecer/crescer no campo em ~1-2s.
5. Clicar de novo para parar → texto final fica no campo, editável.
6. Revisar e enviar com Enter → mensagem sai normalmente.
7. Conferir no DevTools → Network que não há upload do áudio para fora (só download do modelo do HF CDN na 1ª vez).

Se a transcrição por CPU (WASM) engasgar demais, trocar `MODEL_ID` para `'onnx-community/whisper-tiny'` em `web/src/speech/transcriber.ts`.

## Self-Review (autor do plano)

- **Cobertura do spec:** arquitetura navegador/transformers.js (Task 1), pseudo-streaming a cada 1,5s (Task 2 `intervalMs=1500` + Task 4 loop), modelo base tunável (Task 1 `MODEL_ID`), carregamento sob demanda via dynamic import (Task 1), idioma pelo locale (Task 5 `whisperLang(i18n.language)`), preencher-e-confirmar (Task 5 `mergeTranscript`, envio inalterado), erros permissão/modelo/sem-suporte (Task 4 + Task 5 aviso), i18n 3 línguas (Task 3), WebGPU→WASM fallback (Task 1 `pickDevice`). ✔ Todos cobertos.
- **Placeholders:** nenhum — todo passo traz código/comando/expected reais. ✔
- **Consistência de tipos:** `Transcriber`, `MicHandle`, `MicDeps`, `whisperLang`, `pickDevice`, `MODEL_ID`, `mergeTranscript`, `startMicCapture(onBuffer, intervalMs?)`, `loadTranscriber(onProgress?)` usados igualzinho entre Tasks 1/2/4/5. ✔
