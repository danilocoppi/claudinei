# OpenCode como 3ª engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Registrar uma engine `'opencode'` (turn-based sobre `opencode run --format json`) que slota na abstração Engine/EngineSession, coexistindo com Claude e Codex.

**Architecture:** Um `server/src/engine/opencode/` que espelha o `codex/` (turn-based): 1 processo `opencode run` por turno (`-s <sessionId>` nos seguintes; prompt como argv posicional; `--auto` full-access), eventos `{type,part}` do `--format json` normalizados para o shape `AgentEvent`. Registro = 1 linha; zero mudança em manager/rotas/DB; o frontend se auto-descreve via `GET /api/engines`.

**Tech Stack:** Node child_process, EventEmitter, better-sqlite3, TS ESM estrito (imports `.js`), vitest. opencode 1.17.20.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-opencode-engine-design.md` (de-risk CONCLUÍDO; schema confirmado; fixtures em `server/test/fixtures/opencode/`).
- **Registry aberto:** adicionar = `registerEngine(openCodeEngine)`; nada de `switch(engine)`; `EngineId` string.
- **Full-access:** todo turno usa `--auto`. `capabilities().permissions = []`.
- **Turn-based:** `opencode run --format json --auto [--title <t>] [-s <id>] [-m <model>] [--variant <effort>] -- <prompt>`. `sessionID` (de qualquer evento) persiste em `claude_session_id` (coluna de storage, id de conversa da engine).
- **Eventos → AgentEvent** (shape de `server/src/claude/events.ts`): `text`→assistant text; `tool_use`(part.type "tool")→assistant tool_use(`id:callID,name:tool,input:state.input`) + user tool_result(`tool_use_id:callID,content:state.output,is_error:state.metadata.exit!==0`); `step_finish`→tokens; `error`→result erro; `step_start`/desconhecido→raw/ignora. **Sem evento de fim de turno** → o `result` é sintetizado no `close` do processo (resultText = último texto, tokens = último step_finish).
- **Effort** via `--variant`: `['minimal','low','medium','high','max']`. **Model** via `-m`. `--title <prompt-truncado>` no 1º turno (evita o model de título pago).
- **Claude e Codex intocados.** Suíte atual (server 415|1, web 284) verde. `web/` só ganha i18n dos slash curados do OpenCode.
- ESM/TS strict, imports `.js`. Commits com trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Testes: `cd server && npm test`; um arquivo: `cd server && npx vitest run test/<arquivo>`.

## File Structure

- `server/src/engine/opencode/opencode-args.ts` (novo) — argv puro.
- `server/src/engine/opencode/opencode-parser.ts` (novo) — classify + turn parser (init/result/tokens).
- `server/src/engine/opencode/opencode-session.ts` (novo) — OpenCodeSession (turn-based).
- `server/src/engine/opencode/opencode-engine.ts` (novo) — openCodeEngine (Engine) + models cacheados + history via export.
- `server/src/engine/index.ts` (modificar) — registra openCodeEngine.
- `server/src/config.ts` (modificar) — `opencodeBin`.
- `server/test/fake-opencode.mjs` (novo) + `server/test/opencode-*.test.ts`.
- `web/src/i18n/{en,pt-BR,es}.ts` (modificar) — descrições dos slash curados do OpenCode.

---

### Task 1: `config.opencodeBin`

**Files:**
- Modify: `server/src/config.ts`
- Test: `server/test/config.test.ts`

**Interfaces:** Produces `Config.opencodeBin: string` (env `CLAUDINEI_OPENCODE_BIN` ?? `'opencode'`).

- [ ] **Step 1: Teste que falha** — em `server/test/config.test.ts`, adicionar:

```typescript
describe('opencodeBin', () => {
  it('default opencode', () => { expect(loadConfig({}).opencodeBin).toBe('opencode') })
  it('respeita CLAUDINEI_OPENCODE_BIN', () => {
    expect(loadConfig({ CLAUDINEI_OPENCODE_BIN: '/opt/oc' } as never).opencodeBin).toBe('/opt/oc')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar** — `cd server && npx vitest run test/config.test.ts` → FAIL.
- [ ] **Step 3: Implementar** — em `interface Config` adicionar `opencodeBin: string`; no retorno de `loadConfig`: `opencodeBin: env.CLAUDINEI_OPENCODE_BIN ?? 'opencode',` (junto de `codexBin`).
- [ ] **Step 4: Passar** — `npx vitest run test/config.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat(opencode): config.opencodeBin

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `opencode-args.ts`

**Files:**
- Create: `server/src/engine/opencode/opencode-args.ts`
- Test: `server/test/opencode-args.test.ts`

**Interfaces:** Produces `buildRunArgs(opts)` / `buildResumeArgs(sessionId, opts)` (opts: `{ model?, effort?, prompt: string, title?: string }`); `OPENCODE_EFFORTS = ['minimal','low','medium','high','max']`.

- [ ] **Step 1: Teste que falha** — `server/test/opencode-args.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildRunArgs, buildResumeArgs } from '../src/engine/opencode/opencode-args.js'

describe('opencode args', () => {
  it('run: flags fixas + prompt posicional após --', () => {
    const a = buildRunArgs({ prompt: 'oi' })
    expect(a.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto'])
    expect(a[a.length - 2]).toBe('--')
    expect(a[a.length - 1]).toBe('oi')
    expect(a).not.toContain('-m')
    expect(a).not.toContain('--variant')
  })
  it('run: model, variant e title', () => {
    const a = buildRunArgs({ prompt: 'oi', model: 'opencode/claude-sonnet-5', effort: 'high', title: 'T' })
    expect(a).toContain('-m'); expect(a).toContain('opencode/claude-sonnet-5')
    expect(a).toContain('--variant'); expect(a).toContain('high')
    expect(a).toContain('--title'); expect(a).toContain('T')
  })
  it('effort inválido é ignorado', () => {
    expect(buildRunArgs({ prompt: 'x', effort: 'ultra' }).join(' ')).not.toContain('--variant')
  })
  it('resume: run -s <id> ... -- prompt (sem --title)', () => {
    const a = buildResumeArgs('ses_1', { prompt: 'de novo' })
    expect(a.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto'])
    expect(a).toContain('-s'); expect(a).toContain('ses_1')
    expect(a).not.toContain('--title')
    expect(a[a.length - 1]).toBe('de novo')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run test/opencode-args.test.ts` → FAIL.
- [ ] **Step 3: Implementar `server/src/engine/opencode/opencode-args.ts`**

```typescript
export const OPENCODE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max']

interface TurnArgs { model?: string; effort?: string; prompt: string; title?: string }

const FIXED = ['run', '--format', 'json', '--auto']

function optionArgs(opts: TurnArgs): string[] {
  const args: string[] = []
  if (opts.model) args.push('-m', opts.model)
  if (opts.effort && OPENCODE_EFFORTS.includes(opts.effort)) args.push('--variant', opts.effort)
  return args
}

// Prompt vai como ÚLTIMO argv (posicional message), após '--' para não ser lido
// como flag. spawn não usa shell → sem escaping.
export function buildRunArgs(opts: TurnArgs): string[] {
  const title = opts.title ? ['--title', opts.title] : []
  return [...FIXED, ...title, ...optionArgs(opts), '--', opts.prompt]
}

export function buildResumeArgs(sessionId: string, opts: TurnArgs): string[] {
  return [...FIXED, '-s', sessionId, ...optionArgs(opts), '--', opts.prompt]
}
```

- [ ] **Step 4: Passar** — `npx vitest run test/opencode-args.test.ts` → PASS (4).
- [ ] **Step 5: Commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/opencode/opencode-args.ts server/test/opencode-args.test.ts
git commit -m "feat(opencode): build de argv turn-based (run/resume, model/variant/title, prompt posicional)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `opencode-parser.ts`

**Files:**
- Create: `server/src/engine/opencode/opencode-parser.ts`
- Test: `server/test/opencode-parser.test.ts` (usa fixtures `server/test/fixtures/opencode/`)

**Interfaces:**
- Consumes: `AgentEvent`/`ApiMessage`/`ContentBlock` de `../../claude/events.js`.
- Produces: `classifyOpenCodeLine(line: string): AgentEvent[]` (por-linha: text→assistant; tool_use→assistant+user; step_start/step_finish/error/desconhecido→[]); `createOpenCodeTurnParser(onEvent, model?)` → `{ feed(chunk), finish(): AgentEvent }` — stateful: emite `init` no 1º sessionID; emite os eventos de chat; acumula `lastText` e `lastTokens` (de step_finish) e `errorMsg` (de error); `finish()` devolve o `result` a emitir no close do turno.

- [ ] **Step 1: Teste que falha** — `server/test/opencode-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyOpenCodeLine, createOpenCodeTurnParser } from '../src/engine/opencode/opencode-parser.js'
import type { AgentEvent } from '../src/engine/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures/opencode', n), 'utf8').split('\n').filter(Boolean)

describe('classifyOpenCodeLine', () => {
  it('text → assistant text', () => {
    const evs = classifyOpenCodeLine('{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"PONG"}}')
    expect(evs[0].kind).toBe('assistant')
    expect((evs[0] as any).message.content).toEqual([{ type: 'text', text: 'PONG' }])
  })
  it('tool_use → assistant tool_use + user tool_result (is_error por exit)', () => {
    const ok = classifyOpenCodeLine('{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi","metadata":{"exit":0}}}}')
    expect(ok).toHaveLength(2)
    expect((ok[0] as any).message.content[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'echo hi' } })
    expect((ok[1] as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: false })
    const bad = classifyOpenCodeLine('{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"c2","state":{"status":"error","input":{},"output":"boom","metadata":{"exit":1}}}}')
    expect((bad[1] as any).message.content[0].is_error).toBe(true)
  })
  it('step_start/step_finish → sem eventos de chat', () => {
    expect(classifyOpenCodeLine('{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}')).toEqual([])
    expect(classifyOpenCodeLine('{"type":"step_finish","sessionID":"ses_1","tokens":{"total":8,"input":5,"output":3,"reasoning":0}}')).toEqual([])
  })
  it('JSON inválido → parse_error', () => {
    expect(classifyOpenCodeLine('{nope')[0].kind).toBe('parse_error')
  })
})

describe('createOpenCodeTurnParser', () => {
  it('emite init no 1º sessionID; finish() traz resultText do último text + tokens', () => {
    const events: AgentEvent[] = []
    const p = createOpenCodeTurnParser((e) => events.push(e), 'opencode/deepseek-v4-flash-free')
    for (const line of fixture('turn-simple.jsonl')) p.feed(line + '\n')
    const init = events.find((e) => e.kind === 'init') as any
    expect(init).toBeTruthy()
    expect(init.sessionId).toMatch(/^ses_/)
    const result = p.finish() as any
    expect(result.kind).toBe('result')
    expect(result.resultText).toBe('PONG')
    expect(result.tokens).toMatchObject({ total: 8048 })
  })
  it('fixture com tool classifica sem lançar e o result não é erro', () => {
    const events: AgentEvent[] = []
    const p = createOpenCodeTurnParser((e) => events.push(e))
    for (const line of fixture('turn-tool.jsonl')) p.feed(line + '\n')
    expect(events.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('tool_use'))).toBe(true)
    expect((p.finish() as any).isError).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run test/opencode-parser.test.ts` → FAIL.
- [ ] **Step 3: Implementar `server/src/engine/opencode/opencode-parser.ts`**

```typescript
import type { AgentEvent, ApiMessage, ContentBlock } from '../../claude/events.js'

const assistant = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content } as ApiMessage, raw })
const user = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content } as ApiMessage, raw })

/** Um evento v (linha) do `opencode run --json` → 0..2 AgentEvents de chat. */
export function classifyOpenCodeLine(line: string): AgentEvent[] {
  const s = line.trim()
  if (!s) return []
  let o: any
  try { o = JSON.parse(s) } catch { return [{ kind: 'parse_error', line: s }] }
  switch (o.type) {
    case 'text':
      return typeof o.part?.text === 'string' ? [assistant([{ type: 'text', text: o.part.text }], o)] : []
    case 'reasoning':
      return o.part?.text ? [assistant([{ type: 'thinking', thinking: String(o.part.text) }], o)] : []
    case 'tool_use': {
      const p = o.part ?? {}
      const st = p.state ?? {}
      return [
        assistant([{ type: 'tool_use', id: p.callID, name: p.tool, input: st.input ?? {} }], o),
        user([{ type: 'tool_result', tool_use_id: p.callID, content: st.output ?? '', is_error: (st.metadata?.exit ?? 0) !== 0 || st.status === 'error' }], o),
      ]
    }
    case 'step_start':
    case 'step_finish':
    case 'error':
      return []  // tratados pelo turn parser (tokens/sessionId/erro), não viram chat
    default:
      return [{ kind: 'raw', raw: o }]
  }
}

interface Tokens { input: number; cachedInput: number; output: number; reasoning: number; total: number }

/** Stateful por turno: emite init (1º sessionID) + eventos de chat; acumula texto/tokens/erro; finish() = o result do turno. */
export function createOpenCodeTurnParser(onEvent: (e: AgentEvent) => void, model?: string) {
  let buf = ''
  let sessionId: string | undefined
  let lastText = ''
  let tokens: Tokens | undefined
  let errorMsg: string | undefined

  const handleLine = (line: string): void => {
    const s = line.trim()
    if (!s) return
    let o: any
    try { o = JSON.parse(s) } catch { onEvent({ kind: 'parse_error', line: s }); return }
    // 1º sessionID → init
    if (!sessionId && typeof o.sessionID === 'string') {
      sessionId = o.sessionID
      onEvent({ kind: 'init', sessionId, model: model ?? '', slashCommands: [], raw: o })
    }
    if (o.type === 'step_finish' && o.tokens) {
      const t = o.tokens
      tokens = { input: t.input ?? 0, cachedInput: t.cache?.read ?? 0, output: t.output ?? 0, reasoning: t.reasoning ?? 0, total: t.total ?? 0 }
    }
    if (o.type === 'error') { errorMsg = o.error?.data?.message ?? o.error?.message ?? 'opencode error' }
    if (o.type === 'text' && typeof o.part?.text === 'string') lastText = o.part.text
    for (const e of classifyOpenCodeLine(line)) onEvent(e)
  }

  return {
    feed(chunk: Buffer | string): void {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    },
    /** Chamado no close do processo (fim do turno). */
    finish(): AgentEvent {
      if (buf.trim()) { handleLine(buf); buf = '' }
      return errorMsg
        ? { kind: 'result', subtype: 'error', isError: true, resultText: errorMsg, costUsd: 0, tokens, raw: {} }
        : { kind: 'result', subtype: 'success', isError: false, resultText: lastText, costUsd: 0, tokens, raw: {} }
    },
  }
}
```

(Obs.: `result` já suporta `tokens?` — adicionado no engine_usage. Confira em
`server/src/claude/events.ts` que o variant `result` tem `tokens?`; ele foi adicionado
na feature de usage do Codex.)

- [ ] **Step 4: Passar** — `npx vitest run test/opencode-parser.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/opencode/opencode-parser.ts server/test/opencode-parser.test.ts
git commit -m "feat(opencode): parser {type,part} → AgentEvent (init/text/tool/result + tokens)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `opencode-session.ts` + fake-opencode

**Files:**
- Create: `server/src/engine/opencode/opencode-session.ts`
- Create: `server/test/fake-opencode.mjs`
- Test: `server/test/opencode-session.test.ts`

**Interfaces:** Produces `class OpenCodeSession extends EventEmitter implements EngineSession`. Turn-based; espelha `CodexSession`. Diferença: o `result` é emitido no `close` via `parser.finish()`.

- [ ] **Step 1: fake-opencode `server/test/fake-opencode.mjs`** (emite o protocolo e sai; suporta hang):

```javascript
#!/usr/bin/env node
// Fake do `opencode run` para testes: emite o protocolo v e sai. Lê o prompt do
// último argv (após '--'); no resume o session id é o valor após '-s'.
import process from 'node:process'
const args = process.argv.slice(2)
const isResume = args.includes('-s')
const sid = isResume ? args[args.indexOf('-s') + 1] : 'ses_FAKE'
const dashdash = args.lastIndexOf('--')
const prompt = dashdash >= 0 ? args.slice(dashdash + 1).join(' ') : ''
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
if (process.env.OPENCODE_FAKE_HANG === '1') {
  out({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } })
  setInterval(() => {}, 1000) // trava até ser morto
} else {
  out({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } })
  out({ type: 'text', sessionID: sid, part: { type: 'text', text: `echo:${prompt}` } })
  out({ type: 'step_finish', sessionID: sid, tokens: { total: 5, input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
  process.exit(0)
}
```

- [ ] **Step 2: Teste que falha** — `server/test/opencode-session.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { OpenCodeSession } from '../src/engine/opencode/opencode-session.js'
import type { AgentEvent } from '../src/engine/types.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-opencode.mjs')
const mk = () => new OpenCodeSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE] })
const waitFor = (c: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now(); const i = setInterval(() => { if (c()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) } }, 10)
})

describe('OpenCodeSession (turn-based)', () => {
  it('start() não spawna; idle', () => { const s = mk(); s.start(); expect(s.status).toBe('idle') })

  it('send() roda um turno: init(sessionId)+assistant+result; needs_attention', async () => {
    const s = mk(); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('hello'); expect(s.status).toBe('working')
    await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('ses_FAKE')
    expect(evs.some((e) => e.kind === 'init')).toBe(true)
    expect(evs.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('echo:hello'))).toBe(true)
    const result = evs.find((e) => e.kind === 'result') as any
    expect(result?.tokens?.total).toBe(5)
  })

  it('2º send usa -s <id> (resume) e mantém a sessão', async () => {
    const s = mk(); s.start()
    s.send('one'); await waitFor(() => s.status === 'needs_attention')
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('two'); await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('ses_FAKE')
  })

  it('interrupt() cancela o turno sem matar a sessão (idle, sessionId preservado)', async () => {
    const s = new OpenCodeSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE] })
    process.env.OPENCODE_FAKE_HANG = '1'
    try {
      s.start(); s.send('go'); await waitFor(() => s.status === 'working' && !!s.sessionId)
      await s.interrupt(); await waitFor(() => s.status === 'idle')
      expect(s.sessionId).toBe('ses_FAKE')
      s.send('again') // não lança
    } finally { delete process.env.OPENCODE_FAKE_HANG }
  })

  it('stop() encerra e recusa novas mensagens', async () => {
    const s = mk(); s.start(); await s.stop()
    expect(s.status).toBe('stopped'); expect(() => s.send('x')).toThrow()
  })
})
```

- [ ] **Step 3: Rodar e ver falhar** — `npx vitest run test/opencode-session.test.ts` → FAIL.
- [ ] **Step 4: Implementar `server/src/engine/opencode/opencode-session.ts`**

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { EngineSession, EngineSessionOptions } from '../types.js'
import type { SessionStatus } from '../../claude/session.js'
import { buildRunArgs, buildResumeArgs } from './opencode-args.js'
import { createOpenCodeTurnParser } from './opencode-parser.js'

/** Sessão OpenCode turn-based: 1 processo `opencode run`/`run -s` por turno. */
export class OpenCodeSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  private proc?: ChildProcessWithoutNullStreams
  private stopping = false
  private interrupting = false
  private stderrTail: string[] = []
  private model?: string
  private effort?: string

  get lastStderr(): string { return this.stderrTail.join('').trim() }

  constructor(private opts: EngineSessionOptions & { binOverride?: string }) {
    super()
    this.model = opts.model
    this.effort = opts.effort
    if (opts.resumeSessionId) this.sessionId = opts.resumeSessionId
  }

  start(): void { this.setStatus('idle') } // turn-based: nada spawna aqui

  send(text: string): void {
    if (this.status === 'stopped' || this.status === 'dead') throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    if (this.status === 'working') throw new Error('turno em andamento')
    const bin = this.opts.binOverride ?? this.opts.bin ?? process.env.CLAUDINEI_OPENCODE_BIN ?? 'opencode'
    const turnOpts = { model: this.model, effort: this.effort, prompt: text }
    const base = this.sessionId
      ? buildResumeArgs(this.sessionId, turnOpts)
      : buildRunArgs({ ...turnOpts, title: text.slice(0, 40) })
    const args = this.opts.extraArgsOverride ? [...this.opts.extraArgsOverride, ...base] : base
    this.proc = spawn(bin, args, { cwd: this.opts.projectPath, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PKG_EXECPATH: '' } })
    this.setStatus('working')
    let sawResult = false
    const parser = createOpenCodeTurnParser((evt) => {
      if (evt.kind === 'init') { this.sessionId = evt.sessionId; this.emit('event', evt); return }
      this.emit('event', evt)
    }, this.model)
    this.proc.stdout.on('data', (d) => parser.feed(d))
    this.proc.stderr.on('data', (d) => { const s = d.toString(); this.stderrTail.push(s); if (this.stderrTail.length > 20) this.stderrTail.shift(); this.emit('stderr', s) })
    this.proc.on('close', (code) => {
      this.proc = undefined
      // Fim do turno: sintetiza o result (resultText/tokens acumulados).
      const result = parser.finish()
      this.emit('event', result)
      sawResult = !result.isError
      if (this.stopping) { this.setStatus('stopped'); return }
      if (this.interrupting) { this.interrupting = false; this.setStatus('idle'); return }
      if (code !== 0 && !sawResult) { this.setStatus('dead'); this.emit('exit', code); return }
      this.setStatus('needs_attention')
      this.emit('exit', code)
    })
    this.proc.on('error', () => this.setStatus('dead'))
  }

  markRead(): void { if (this.status === 'needs_attention') this.setStatus('idle') }

  interrupt(): Promise<void> {
    if (this.status === 'working' && this.proc) {
      this.interrupting = true
      const p = this.proc
      p.kill('SIGTERM')
      const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } }, 3000)
      p.once('close', () => clearTimeout(t))
    }
    return Promise.resolve()
  }

  setModel(model: string): Promise<void> { this.model = model || undefined; return Promise.resolve() }
  setEffort(effort: string): Promise<void> { this.effort = effort || undefined; return Promise.resolve() }
  setPermissionMode(_m: string): Promise<void> { return Promise.resolve() } // full-access fixo

  async stop(): Promise<void> {
    this.stopping = true
    if (this.proc) {
      const p = this.proc; p.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* */ } resolve() }, 5000)
        p.once('close', () => { clearTimeout(t); resolve() })
      })
    } else { this.setStatus('stopped') }
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === 'dead' || this.status === 'stopped') return
    if (s !== this.status) { this.status = s; this.emit('status', s) }
  }
}
```

- [ ] **Step 5: Passar** — `npx vitest run test/opencode-session.test.ts` VÁRIAS vezes (loop 3x) p/ estabilidade → PASS (5).
- [ ] **Step 6: Commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/opencode/opencode-session.ts server/test/fake-opencode.mjs server/test/opencode-session.test.ts
git commit -m "feat(opencode): OpenCodeSession turn-based (EngineSession) + fake-opencode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `opencode-engine.ts` + models cacheados + history + registro

**Files:**
- Create: `server/src/engine/opencode/opencode-engine.ts`
- Modify: `server/src/engine/index.ts`
- Test: `server/test/opencode-engine.test.ts`, ajuste em `server/test/engine-routes.test.ts`

**Interfaces:** Produces `openCodeEngine: Engine` (id `'opencode'`). `capabilities().models` vem de `opencode models` (cacheado 5 min; `[]` se falhar). `readHistory`/`latestConversationId` via `opencode export`/`opencode session list`.

- [ ] **Step 1: Teste que falha** — `server/test/opencode-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { openCodeEngine } from '../src/engine/opencode/opencode-engine.js'
import { getEngine, hasEngine } from '../src/engine/index.js'
import { OpenCodeSession } from '../src/engine/opencode/opencode-session.js'

describe('openCodeEngine', () => {
  it('registrado com id opencode', () => {
    expect(hasEngine('opencode')).toBe(true)
    expect(getEngine('opencode')).toBe(openCodeEngine)
  })
  it('createSession → OpenCodeSession sem spawnar', () => {
    const s = openCodeEngine.createSession({ projectPath: '/tmp' })
    expect(s).toBeInstanceOf(OpenCodeSession)
    expect(s.status).toBe('starting')
  })
  it('terminalCommand: com id → opencode --session <id> --auto; sem id → opencode --auto', () => {
    expect(openCodeEngine.terminalCommand({ resumeSessionId: 'ses_1', projectPath: '/tmp', bin: 'opencode' }))
      .toEqual({ file: 'opencode', args: ['--session', 'ses_1', '--auto'] })
    expect(openCodeEngine.terminalCommand({ projectPath: '/tmp', bin: 'opencode' }))
      .toEqual({ file: 'opencode', args: ['--auto'] })
  })
  it('capabilities: efforts=variants, sem permissions, slash curated, label/icon, models é array', () => {
    const c = openCodeEngine.capabilities()
    expect(c.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'max'])
    expect(c.permissions).toEqual([])
    expect(c.slashSource).toBe('curated')
    expect(c.label).toBe('OpenCode')
    expect(c.icon).toBeTruthy()
    expect(Array.isArray(c.models)).toBe(true)
  })
  it('readHistory sem sessão → []', () => {
    expect(openCodeEngine.readHistory('/nao/existe', 'ses_nada')).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run test/opencode-engine.test.ts` → FAIL.
- [ ] **Step 3: Implementar `server/src/engine/opencode/opencode-engine.ts`**

```typescript
import { execFileSync } from 'node:child_process'
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from '../types.js'
import type { ApiMessage, ContentBlock } from '../../claude/events.js'
import { OpenCodeSession } from './opencode-session.js'

const OPENCODE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max']
const SLASH = ['new', 'sessions', 'models', 'share', 'compact', 'undo', 'redo', 'init']

function bin(): string { return process.env.CLAUDINEI_OPENCODE_BIN ?? 'opencode' }

// Models são dinâmicos (dependem dos providers do usuário). Cacheados 5 min para
// não spawnar `opencode models` a cada GET /api/engines. Falha → [] (não quebra).
let modelsCache: { at: number; models: string[] } | null = null
function listModels(): string[] {
  if (modelsCache && Date.now() - modelsCache.at < 300_000) return modelsCache.models
  let models: string[] = []
  try {
    const out = execFileSync(bin(), ['models'], { timeout: 5000, encoding: 'utf8' })
    models = ['', ...out.split('\n').map((l) => l.trim()).filter(Boolean)]
  } catch { models = modelsCache?.models ?? [] }
  modelsCache = { at: Date.now(), models }
  return models
}

/** Normaliza um `opencode export <id>` ({info, messages}) para AgentEvent[]. */
function parseExport(json: string): AgentEvent[] {
  let d: any
  try { d = JSON.parse(json) } catch { return [] }
  const events: AgentEvent[] = []
  for (const m of Array.isArray(d.messages) ? d.messages : []) {
    const role = m.info?.role ?? m.role
    const parts = Array.isArray(m.parts) ? m.parts : []
    for (const p of parts) {
      if (p.type === 'text' && p.text) {
        events.push({ kind: role === 'assistant' ? 'assistant' : 'user', message: { role: role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: p.text }] } as ApiMessage, raw: p })
      } else if (p.type === 'tool' && p.state) {
        events.push({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: p.callID, name: p.tool, input: p.state.input ?? {} } as ContentBlock] } as ApiMessage, raw: p })
      }
    }
  }
  return events
}

export const openCodeEngine: Engine = {
  id: 'opencode',
  createSession(opts: EngineSessionOptions): EngineSession { return new OpenCodeSession(opts) },
  readHistory(_projectPath: string, sessionId: string): AgentEvent[] {
    try { return parseExport(execFileSync(bin(), ['export', sessionId], { timeout: 8000, encoding: 'utf8' })) }
    catch { return [] }
  },
  latestConversationId(projectPath: string): string | null {
    // `opencode session list` (texto) — casa o directory via export da sessão. Se
    // não der para resolver com segurança, devolve null (sem preview do --continue).
    try {
      const list = execFileSync(bin(), ['session', 'list'], { timeout: 8000, encoding: 'utf8' })
      const ids = list.split('\n').map((l) => (l.match(/ses_[A-Za-z0-9]+/) ?? [])[0]).filter(Boolean) as string[]
      for (const id of ids) {
        try {
          const info = JSON.parse(execFileSync(bin(), ['export', id], { timeout: 6000, encoding: 'utf8' })).info
          if (info?.directory === projectPath) return id
        } catch { /* ignora */ }
      }
    } catch { /* ignora */ }
    return null
  },
  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }) {
    const file = opts.bin ?? bin()
    return opts.resumeSessionId
      ? { file, args: ['--session', opts.resumeSessionId, '--auto'] }
      : { file, args: ['--auto'] }
  },
  capabilities(): EngineCapabilities {
    return {
      models: listModels(),
      efforts: OPENCODE_EFFORTS,
      permissions: [],
      slashSource: 'curated',
      label: 'OpenCode',
      icon: '◇',
      slashCommands: SLASH,
    }
  },
}
```

- [ ] **Step 4: Registrar em `server/src/engine/index.ts`** — após o registro do codexEngine:

```typescript
import { openCodeEngine } from './opencode/opencode-engine.js'
// ...
if (!hasEngine(openCodeEngine.id)) registerEngine(openCodeEngine)
```

- [ ] **Step 5: Ajustar `server/test/engine-routes.test.ts`** — o caso `engine: 'foobar'` → 400 permanece; se houver um caso que assumia só claude/codex registrados, incluir opencode. (Sem mudança se o teste só cobre foobar→400 e codex→201.)

- [ ] **Step 6: Passar (+ regressão)** — `npx vitest run test/opencode-engine.test.ts test/engine-registry.test.ts test/engine-routes.test.ts && npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/opencode/opencode-engine.ts server/src/engine/index.ts server/test/opencode-engine.test.ts server/test/engine-routes.test.ts
git commit -m "feat(opencode): openCodeEngine (models dinâmicos, history via export) + registro

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: frontend i18n dos slash + integração 3 engines

**Files:**
- Modify: `web/src/i18n/en.ts`, `pt-BR.ts`, `es.ts` (descrições dos slash do OpenCode)
- Test: `server/test/engine-integration.test.ts` (adicionar opencode ao teste de coexistência)

**Interfaces:** nenhum símbolo novo. As descrições i18n dos slash `new/sessions/models/share/compact/undo/redo/init` no bloco `slash`.

- [ ] **Step 1: i18n** — em `web/src/i18n/en.ts` bloco `slash`, adicionar as chaves que faltam (algumas já existem de claude/codex: `compact`, `init`, `undo`, `model`... reusar; adicionar `new`, `sessions`, `share`, `redo`, `models`). Ex. (en):

```typescript
    new: 'start a new session', sessions: 'list sessions', share: 'share the session',
    redo: 'redo the last undone edit', models: 'list available models',
```

pt-BR: `new: 'inicia uma nova sessão', sessions: 'lista as sessões', share: 'compartilha a sessão', redo: 'refaz a última edição desfeita', models: 'lista os modelos disponíveis',`
es: `new: 'inicia una nueva sesión', sessions: 'lista las sesiones', share: 'comparte la sesión', redo: 'rehace la última edición deshecha', models: 'lista los modelos disponibles',`
(shape idêntico nos 3; só adicionar chaves ausentes — não duplicar as já existentes.)

- [ ] **Step 2: Integração** — em `server/test/engine-integration.test.ts` (que já prova 1 Claude + 1 Codex), adicionar uma sessão `opencode` no mesmo projeto e assertar que as TRÊS engines coexistem (a trava `(projeto, engine)` já vale; use um sessionFactory que devolve o fake certo por `__engine`, ou registre um 3º fake). Confirme `manager.start(project, { engine: 'opencode' }).engine === 'opencode'` e que a 2ª opencode no mesmo projeto é rejeitada.

- [ ] **Step 3: Passar** — `cd web && npm test && npx tsc --noEmit && npm run build` e `cd server && npm test && npx tsc --noEmit` → tudo verde.

- [ ] **Step 4: Commit**

```bash
cd /home/coppi/Projects/Termaster
git add web/src/i18n server/test/engine-integration.test.ts
git commit -m "feat(opencode): i18n dos slash curados + integração (Claude + Codex + OpenCode coexistem)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verificação final + smoke real (fora das tasks)

```bash
cd /home/coppi/Projects/Termaster/server && npm test && npx tsc --noEmit
cd ../web && npm test && npx tsc --noEmit && npm run build
```
Esperado: server verde (Claude/Codex intocados + novos de opencode), web verde, build ok.

**Smoke real (controlador, provider autenticado):** criar um terminal OpenCode num
projeto real → mensagem (turno roda, chat popula) → 2º turno (resume) → interrupt →
Open in terminal (`opencode --session <id> --auto`) → usage aparece no card (tokens do
step_finish via engine_usage_daily) → 1 Claude + 1 Codex + 1 OpenCode lado a lado.

## Self-Review (checklist do autor)

- **Cobertura do spec:** config.opencodeBin ✅ (T1); args ✅ (T2); parser {type,part}→AgentEvent
  + init/result/tokens ✅ (T3); OpenCodeSession turn-based + interrupt-preserva ✅ (T4);
  openCodeEngine + models dinâmicos + history via export + terminalCommand + registro ✅ (T5);
  i18n slash + integração 3 engines ✅ (T6). Usage: os tokens do result alimentam o
  `onEngineUsage` existente → engine_usage_daily (sem task nova).
- **Sem placeholders:** todo passo com código; o schema vem dos fixtures reais do de-risk.
- **Consistência de tipos:** `EngineSession`/`Engine`/`EngineSessionOptions`/`AgentEvent`
  reusados; `buildRunArgs`/`buildResumeArgs`/`createOpenCodeTurnParser`/`OpenCodeSession`/
  `openCodeEngine` encadeados T2→T5. `result.tokens` já existe (feature de usage).
- **MCP/hermes:** follow-up (não incluído) — a engine funciona sem ele; documentado no spec.
