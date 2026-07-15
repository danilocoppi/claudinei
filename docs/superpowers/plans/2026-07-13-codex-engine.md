# SP-B — Adapter do Codex (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar uma engine `'codex'` (turn-based sobre `codex exec --json`) que slota na abstração `Engine`/`EngineSession` do SP-A, coexistindo com o Claude por terminal.

**Architecture:** Um `server/src/engine/codex/` (args puros, parser v2→AgentEvent, CodexSession turn-based como EventEmitter, codexEngine). O Codex roda 1 processo por turno (`codex exec` no 1º, `codex exec resume <threadId>` nos seguintes; prompt via stdin), com eventos normalizados para o shape do Claude que o frontend já renderiza. Os call-sites de terminal e histórico passam a resolver a engine da sessão. Cada engine lê o próprio binário de env.

**Tech Stack:** Node child_process (spawn), EventEmitter, better-sqlite3, TypeScript ESM estrito (imports `.js`), vitest. Codex CLI 0.144.3.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-codex-engine-design.md` (com spikes empíricos).
- **Registry aberto (SP-A):** adicionar Codex = `registerEngine(codexEngine)`; nada de `switch(engine)`; `EngineId` string.
- **Full-access sempre:** todo turno Codex usa `--dangerously-bypass-approvals-and-sandbox`. Sem seletor de sandbox (`capabilities().permissions = []`).
- **Turn-based:** `codex exec --json ... -` (1º turno) / `codex exec resume <threadId> --json ... -` (seguintes); prompt via **stdin** (fecha stdin após escrever). `threadId` (de `thread.started`) persiste em `claude_session_id`.
- **Normalização v2→AgentEvent** (shape de `server/src/claude/events.ts`): thread.started→init(sessionId), agent_message→assistant text, command_execution→assistant tool_use + user tool_result (is_error por exit_code≠0), reasoning→assistant thinking, turn.completed→result, turn.failed→result erro, desconhecido→raw.
- **Comportamento do Claude intocado:** a suíte do Claude permanece verde e inalterada; o rewiring de terminal/history mantém o Claude idêntico (o claudeEngine delega às mesmas funções). Só se ADICIONAM testes (fora os arquivos que mudam de assinatura de opts, adaptados mecanicamente).
- **Effort do Codex:** níveis `minimal|low|medium|high` via `-c model_reasoning_effort="<nível>"`. Model via `-m`.
- **SP-B é backend.** Não toca em `web/`. Nomes de API/WS estáveis (rename é SP-C).
- ESM/TS strict, imports `.js`. Commits com trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Testes: `cd server && npm test`; um arquivo: `cd server && npx vitest run test/<arquivo>`.

## File Structure

- `server/src/engine/codex/codex-args.ts` (novo) — argv puro (buildExecArgs/buildResumeArgs).
- `server/src/engine/codex/codex-parser.ts` (novo) — classifyCodexLine + createCodexTurnParser.
- `server/src/engine/codex/codex-session.ts` (novo) — CodexSession (EngineSession turn-based).
- `server/src/engine/codex/codex-engine.ts` (novo) — codexEngine (Engine).
- `server/src/engine/codex/rollout.ts` (novo) — parse do rollout `~/.codex/sessions/*.jsonl` para readHistory/latestConversationId.
- `server/src/engine/index.ts` (modificar) — registra codexEngine.
- `server/src/config.ts` (modificar) — `codexBin`.
- `server/src/claude/claude-engine.ts`? Não — o claudeEngine está em `server/src/engine/claude-engine.ts`; ajustar para ler o bin de env (remover injeção de bin pelo manager).
- `server/src/claude/manager.ts` (modificar) — para de injetar `bin`; `openInTerminal` via `terminalCommand`.
- `server/src/terminal/manager.ts` (modificar) — `OpenOpts` com `file`/`args`.
- `server/src/routes/sessions.ts` (modificar) — `GET /history` via engine.
- `server/src/index.ts` (modificar) — passar `codexBin` ao manager (ou nada, se engines lêem env).
- Test: `server/test/fake-codex.mjs` (novo, análogo ao fake-claude) + `server/test/codex-*.test.ts`.

---

### Task 1: De-risk empírico (spike controlado do Codex real)

**Objetivo:** confirmar 3 incógnitas na máquina (Codex logado) ANTES de construir, e produzir fixtures reais. NÃO escreve código de produção — só um doc de findings + fixtures capturados.

**Files:**
- Create: `server/test/fixtures/codex/turn-simple.jsonl` (linhas v2 de um turno simples)
- Create: `server/test/fixtures/codex/turn-command.jsonl` (turno com command_execution)
- Create: `.superpowers/sdd/codex-derisk.md` (findings)

- [ ] **Step 1: Confirmar injeção de MCP via `-c`**

Num dir temporário git, rodar um `codex exec --json` full-access que declare o hermes
como MCP server via overrides `-c` e peça para listar as tools MCP disponíveis:

```bash
DIR=$(mktemp -d); cd "$DIR"; git init -q
# hermes stub mínimo: um MCP server que expõe uma tool "ping"
# (usar o hermes real do repo NÃO é necessário aqui — basta provar que -c sobe um MCP)
timeout 120 codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  -c 'mcp_servers.demo.command="/bin/echo"' \
  -c 'mcp_servers.demo.args=["hi"]' \
  "List your available MCP servers/tools and reply with their names." | tee mcp-test.jsonl
```

Registrar em `codex-derisk.md`: a forma EXATA de `-c` que o Codex aceita para
command/args/env de um MCP server (sintaxe TOML no valor), e se o server aparece.
Se a forma correta divergir da suposta no spec (`-c mcp_servers.hermes.command=...`),
anotar a forma real — ela vira a base do `buildExecArgs` (Task 3).

- [ ] **Step 2: Confirmar interrupt deixa o thread resumível**

```bash
cd "$DIR"
# turno longo; capturar thread_id; matar o processo no meio; resume e ver contexto
(timeout 8 codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  "Count slowly from 1 to 50, one number per line, pausing between each." > long.jsonl 2>&1 &) ; sleep 6; pkill -f "codex exec" || true
TID=$(python3 -c "import json;print([json.loads(l)['thread_id'] for l in open('long.jsonl') if l.strip() and json.loads(l).get('type')=='thread.started'][0])")
codex exec resume "$TID" --json --dangerously-bypass-approvals-and-sandbox "What number did you reach?" | tee after-kill.jsonl
```

Registrar: o `resume` após kill funciona e mantém o contexto? (esperado sim). Anotar.

- [ ] **Step 3: Fixar a lista de models de `capabilities()`**

```bash
codex --help 2>&1 | grep -i model | head
python3 -c "import json;d=json.load(open('$HOME/.codex/models_cache.json'));print(list(d)[:20] if isinstance(d,dict) else d)" 2>/dev/null | head
cat ~/.codex/config.toml | grep -i model
```

Registrar em `codex-derisk.md` a lista canônica de models a expor (ex.:
`['', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4']`) — vira `capabilities().models` (Task 6).

- [ ] **Step 4: Capturar fixtures reais**

Rodar dois turnos e salvar as linhas v2 como fixtures (o parser da Task 4 testa contra elas):

```bash
mkdir -p /home/coppi/Projects/Termaster/server/test/fixtures/codex
cd "$DIR"
codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  "Reply with exactly: PONG" > /home/coppi/Projects/Termaster/server/test/fixtures/codex/turn-simple.jsonl
TID=$(python3 -c "import json;print([json.loads(l)['thread_id'] for l in open('/home/coppi/Projects/Termaster/server/test/fixtures/codex/turn-simple.jsonl') if l.strip() and json.loads(l).get('type')=='thread.started'][0])")
codex exec resume "$TID" --json --dangerously-bypass-approvals-and-sandbox \
  "Run: echo hi > f.txt  then reply done" > /home/coppi/Projects/Termaster/server/test/fixtures/codex/turn-command.jsonl
```

- [ ] **Step 5: Commit dos findings + fixtures**

```bash
cd /home/coppi/Projects/Termaster
git add server/test/fixtures/codex .superpowers/sdd/codex-derisk.md 2>/dev/null || git add server/test/fixtures/codex
git commit -m "spike(codex): de-risk MCP via -c, interrupt-resumível, lista de models + fixtures reais

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Se `.superpowers/` for gitignored, commitar só os fixtures e deixar o `codex-derisk.md`
como artefato local — mencionar no relatório.)

**Status esperado ao fim:** DONE com o `codex-derisk.md` respondendo os 3 pontos e os 2
fixtures no repo. Se algo divergir materialmente do spec (ex.: `-c` de MCP não funciona),
reportar BLOCKED com o achado para reavaliar o design.

---

### Task 2: `config.codexBin` + engines lêem o próprio bin de env

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/src/engine/claude-engine.ts` (bin de env, não de opts)
- Modify: `server/src/claude/manager.ts` (para de injetar `bin`)
- Test: `server/test/config.test.ts` (adicionar caso de codexBin, sem alterar os existentes)

**Interfaces:**
- Consumes: `Config` de `../config.js`.
- Produces: `Config.codexBin: string` (env `CLAUDINEI_CODEX_BIN` ?? `'codex'`); `claudeEngine.createSession` passa a resolver o bin de `process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude'` (via `opts.bin` se presente, senão env); o manager deixa de passar `bin: deps.claudeBin` no `makeSession`.

- [ ] **Step 1: Escrever o teste que falha**

Em `server/test/config.test.ts`, adicionar (sem tocar nos casos existentes):

```typescript
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('codexBin', () => {
  it('default codex', () => {
    expect(loadConfig({}).codexBin).toBe('codex')
  })
  it('respeita CLAUDINEI_CODEX_BIN', () => {
    expect(loadConfig({ CLAUDINEI_CODEX_BIN: '/opt/codex' } as never).codexBin).toBe('/opt/codex')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/config.test.ts`
Expected: FAIL — `codexBin` não existe em `Config`.

- [ ] **Step 3: Implementar**

`server/src/config.ts`: adicionar ao `interface Config` a linha `codexBin: string` (junto de `claudeBin`), e no objeto retornado por `loadConfig`:

```typescript
    codexBin: env.CLAUDINEI_CODEX_BIN ?? 'codex',
```

`server/src/engine/claude-engine.ts`: o `createSession` passa a usar
`opts.bin ?? process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude'` como `claudeBin`, e o
`terminalCommand` usa `opts.bin ?? process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude'`:

```typescript
  createSession(opts: EngineSessionOptions): EngineSession {
    return new ClaudeSession({
      // ...campos como hoje...
      claudeBin: opts.bin ?? process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude',
      // ...
    })
  },
  // terminalCommand:
  terminalCommand(opts) {
    return { file: opts.bin ?? process.env.CLAUDINEI_CLAUDE_BIN ?? 'claude', args: ['--resume', opts.resumeSessionId, '--dangerously-skip-permissions'] }
  },
```

`server/src/claude/manager.ts`: no `makeSession`, remover a injeção de `bin`:

```typescript
  const makeSession = (engineId: EngineId, opts: EngineSessionOptions): EngineSession =>
    deps.sessionFactory ? deps.sessionFactory(opts) : getEngine(engineId).createSession(opts)
```

(o `deps.claudeBin` continua existindo para o `openInTerminal`/launcher por ora — a
Task 7 troca isso por `terminalCommand`.)

- [ ] **Step 4: Rodar e ver passar (+ regressão)**

Run: `cd server && npx vitest run test/config.test.ts test/claude-engine.test.ts test/session.test.ts && npm test`
Expected: PASS. Suíte inteira verde: os testes de session/claude-engine não dependem do bin real (usam fake via extraArgsOverride/sessionFactory).

- [ ] **Step 5: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/config.ts server/src/engine/claude-engine.ts server/src/claude/manager.ts server/test/config.test.ts
git commit -m "feat(engine): config.codexBin + engines resolvem o próprio bin de env (manager para de injetar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `codex-args.ts` (argv puro)

**Files:**
- Create: `server/src/engine/codex/codex-args.ts`
- Test: `server/test/codex-args.test.ts`

**Interfaces:**
- Produces:
  - `buildExecArgs(opts: { model?: string; effort?: string; hermes?: HermesOptions }): string[]`
  - `buildResumeArgs(threadId: string, opts: { model?: string; effort?: string; hermes?: HermesOptions }): string[]`
  - `CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']` (allowlist; effort fora dela é ignorado).
  - Ambos terminam com `'-'` (prompt via stdin). Flags fixas: `--json`, `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`. `exec` no 1º; `exec resume <threadId>` no resume. `-m <model>` se model truthy; `-c model_reasoning_effort="<e>"` se effort ∈ allowlist. mcp: `-c mcp_servers.hermes.command="..."`, `-c mcp_servers.hermes.args=[...TOML...]`, `-c mcp_servers.hermes.env.<K>="..."` — **usar a forma exata confirmada no de-risk (Task 1)**; se o de-risk indicou outra sintaxe, seguir a real.

- [ ] **Step 1: Escrever o teste que falha**

`server/test/codex-args.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildExecArgs, buildResumeArgs } from '../src/engine/codex/codex-args.js'

describe('codex args', () => {
  it('exec: flags fixas + stdin, sem model/effort', () => {
    const a = buildExecArgs({})
    expect(a[0]).toBe('exec')
    expect(a).toContain('--json')
    expect(a).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(a).toContain('--skip-git-repo-check')
    expect(a[a.length - 1]).toBe('-')
    expect(a).not.toContain('-m')
    expect(a.join(' ')).not.toContain('model_reasoning_effort')
  })

  it('exec: model e effort viram flags', () => {
    const a = buildExecArgs({ model: 'gpt-5.6-sol', effort: 'high' })
    expect(a).toContain('-m'); expect(a).toContain('gpt-5.6-sol')
    expect(a.join(' ')).toContain('model_reasoning_effort="high"')
  })

  it('effort inválido é ignorado', () => {
    expect(buildExecArgs({ effort: 'ultracode' }).join(' ')).not.toContain('model_reasoning_effort')
  })

  it('resume: exec resume <threadId> + stdin', () => {
    const a = buildResumeArgs('THREAD123', {})
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', 'THREAD123'])
    expect(a).toContain('--json')
    expect(a[a.length - 1]).toBe('-')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/codex-args.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/engine/codex/codex-args.ts`**

```typescript
import type { HermesOptions } from '../../claude/session.js'

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']

interface TurnArgs { model?: string; effort?: string; hermes?: HermesOptions }

const FIXED = ['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']

function optionArgs(opts: TurnArgs): string[] {
  const args: string[] = []
  if (opts.model) args.push('-m', opts.model)
  if (opts.effort && CODEX_EFFORTS.includes(opts.effort)) {
    args.push('-c', `model_reasoning_effort="${opts.effort}"`)
  }
  if (opts.hermes) {
    // Forma confirmada no de-risk (Task 1): declara o hermes como MCP server via -c.
    // TOML no valor: strings entre aspas, args como array TOML.
    args.push('-c', `mcp_servers.hermes.command="${opts.hermes.command}"`)
    args.push('-c', `mcp_servers.hermes.args=[${opts.hermes.args.map((a) => `"${a}"`).join(',')}]`)
    args.push('-c', `mcp_servers.hermes.env.CLAUDINEI_API="${opts.hermes.apiUrl}"`)
    args.push('-c', `mcp_servers.hermes.env.CLAUDINEI_PROJECT_ID="${opts.hermes.projectId}"`)
    if (opts.hermes.serviceToken) {
      args.push('-c', `mcp_servers.hermes.env.CLAUDINEI_SERVICE_TOKEN="${opts.hermes.serviceToken}"`)
    }
  }
  return args
}

export function buildExecArgs(opts: TurnArgs): string[] {
  return ['exec', ...FIXED, ...optionArgs(opts), '-']
}

export function buildResumeArgs(threadId: string, opts: TurnArgs): string[] {
  return ['exec', 'resume', threadId, ...FIXED, ...optionArgs(opts), '-']
}
```

(Se o de-risk mostrou que a sintaxe de MCP/effort é outra, ajustar `optionArgs`
conforme o real e os testes de acordo.)

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && npx vitest run test/codex-args.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/codex/codex-args.ts server/test/codex-args.test.ts
git commit -m "feat(codex): build de argv turn-based (exec/resume, model/effort/mcp, stdin)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `codex-parser.ts` (v2 → AgentEvent)

**Files:**
- Create: `server/src/engine/codex/codex-parser.ts`
- Test: `server/test/codex-parser.test.ts` (usa os fixtures da Task 1)

**Interfaces:**
- Consumes: `AgentEvent`/`ContentBlock`/`ApiMessage` de `../../claude/events.js`.
- Produces:
  - `classifyCodexLine(line: string, model?: string): AgentEvent[]` — uma linha v2 pode
    virar 0, 1 ou 2 AgentEvents (command_execution vira assistant tool_use + user tool_result).
  - `createCodexTurnParser(onEvent: (e: AgentEvent) => void): (chunk: Buffer|string) => void`
    (buffer NDJSON, split por `\n`, chama classify e emite cada evento).

- [ ] **Step 1: Escrever o teste que falha**

`server/test/codex-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyCodexLine } from '../src/engine/codex/codex-parser.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/codex', name), 'utf8').split('\n').filter(Boolean)

describe('classifyCodexLine', () => {
  it('thread.started → init com sessionId', () => {
    const evs = classifyCodexLine('{"type":"thread.started","thread_id":"T1"}', 'gpt-5.6-sol')
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'init', sessionId: 'T1', model: 'gpt-5.6-sol', slashCommands: [] })
  })

  it('agent_message → assistant text', () => {
    const evs = classifyCodexLine('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"PONG"}}')
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('assistant')
    const m = (evs[0] as any).message
    expect(m.content).toEqual([{ type: 'text', text: 'PONG' }])
  })

  it('command_execution → assistant tool_use + user tool_result (is_error por exit_code)', () => {
    const ok = classifyCodexLine('{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"echo hi","aggregated_output":"hi\\n","exit_code":0,"status":"completed"}}')
    expect(ok).toHaveLength(2)
    expect(ok[0].kind).toBe('assistant')
    expect((ok[0] as any).message.content[0]).toMatchObject({ type: 'tool_use', id: 'i1', name: 'shell', input: { command: 'echo hi' } })
    expect(ok[1].kind).toBe('user')
    expect((ok[1] as any).message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'i1', is_error: false })

    const bad = classifyCodexLine('{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"false","aggregated_output":"","exit_code":1,"status":"completed"}}')
    expect((bad[1] as any).message.content[0].is_error).toBe(true)
  })

  it('turn.completed → result', () => {
    const evs = classifyCodexLine('{"type":"turn.completed","usage":{"output_tokens":6}}')
    expect(evs[0]).toMatchObject({ kind: 'result', isError: false })
  })

  it('turn.failed → result erro', () => {
    const evs = classifyCodexLine('{"type":"turn.failed","error":{"message":"boom"}}')
    expect(evs[0]).toMatchObject({ kind: 'result', isError: true })
    expect((evs[0] as any).resultText).toContain('boom')
  })

  it('item.started e linha desconhecida → nada de chat (0 eventos ou raw)', () => {
    expect(classifyCodexLine('{"type":"item.started","item":{"id":"i1","type":"command_execution"}}')).toEqual([])
    const unknown = classifyCodexLine('{"type":"something.new","x":1}')
    expect(unknown.every((e) => e.kind === 'raw')).toBe(true)
  })

  it('fixtures reais do de-risk classificam sem lançar', () => {
    for (const name of ['turn-simple.jsonl', 'turn-command.jsonl']) {
      for (const line of fixture(name)) {
        expect(() => classifyCodexLine(line)).not.toThrow()
      }
    }
    // o turno simples tem pelo menos 1 init e 1 result
    const simple = fixture('turn-simple.jsonl').flatMap((l) => classifyCodexLine(l))
    expect(simple.some((e) => e.kind === 'init')).toBe(true)
    expect(simple.some((e) => e.kind === 'result')).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/codex-parser.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/engine/codex/codex-parser.ts`**

```typescript
import type { AgentEvent, ApiMessage, ContentBlock } from '../../claude/events.js'

const assistant = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content } as ApiMessage, raw })
const user = (content: ContentBlock[], raw: unknown): AgentEvent =>
  ({ kind: 'user', message: { role: 'user', content } as ApiMessage, raw })

/** Um item.completed do Codex → 0..2 AgentEvents no shape do Claude. */
function classifyItem(item: any, raw: unknown): AgentEvent[] {
  switch (item?.type) {
    case 'agent_message':
      return typeof item.text === 'string' ? [assistant([{ type: 'text', text: item.text }], raw)] : []
    case 'reasoning': {
      const text = item.text ?? item.summary ?? ''
      return text ? [assistant([{ type: 'thinking', thinking: String(text) }], raw)] : []
    }
    case 'command_execution':
      return [
        assistant([{ type: 'tool_use', id: item.id, name: 'shell', input: { command: item.command } }], raw),
        user([{ type: 'tool_result', tool_use_id: item.id, content: item.aggregated_output ?? '', is_error: (item.exit_code ?? 0) !== 0 }], raw),
      ]
    case 'file_change':
    case 'mcp_tool_call':
    case 'web_search':
      // Tool genérica sem tool_result sintético (o payload é o input exibível).
      return [assistant([{ type: 'tool_use', id: item.id, name: item.type, input: item }], raw)]
    default:
      return [{ kind: 'raw', raw }]
  }
}

export function classifyCodexLine(line: string, model?: string): AgentEvent[] {
  const s = line.trim()
  if (!s) return []
  let o: any
  try { o = JSON.parse(s) } catch { return [{ kind: 'parse_error', line: s }] }
  switch (o.type) {
    case 'thread.started':
      return [{ kind: 'init', sessionId: o.thread_id, model: model ?? '', slashCommands: [], raw: o }]
    case 'item.completed':
      return classifyItem(o.item, o)
    case 'turn.completed':
      return [{ kind: 'result', subtype: 'success', isError: false, resultText: '', costUsd: 0, raw: o }]
    case 'turn.failed':
      return [{ kind: 'result', subtype: 'error', isError: true, resultText: o.error?.message ?? 'turn failed', costUsd: 0, raw: o }]
    case 'turn.started':
    case 'item.started':
    case 'item.updated':
      return []  // sem efeito no chat (partials ficam para depois)
    default:
      return [{ kind: 'raw', raw: o }]
  }
}

export function createCodexTurnParser(onEvent: (e: AgentEvent) => void, model?: string) {
  let buf = ''
  return (chunk: Buffer | string): void => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) for (const e of classifyCodexLine(line, model)) onEvent(e)
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd server && npx vitest run test/codex-parser.test.ts`
Expected: PASS.

- [ ] **Step 5: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/codex/codex-parser.ts server/test/codex-parser.test.ts
git commit -m "feat(codex): parser v2 → AgentEvent (thread/turn/item normalizados p/ shape Claude)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `codex-session.ts` (EngineSession turn-based) + fake-codex

**Files:**
- Create: `server/src/engine/codex/codex-session.ts`
- Create: `server/test/fake-codex.mjs`
- Test: `server/test/codex-session.test.ts`

**Interfaces:**
- Consumes: `EngineSession`/`EngineSessionOptions` de `../types.js`; `SessionStatus` de `../../claude/session.js`; `buildExecArgs`/`buildResumeArgs`; `createCodexTurnParser`.
- Produces: `class CodexSession extends EventEmitter implements EngineSession` com opção `binOverride?`/`extraArgsOverride?` (para o fake). Ciclo: start() não spawna; send() spawna turno; interrupt()/stop() matam o processo. Emite `'status'` e `'event'` como o ClaudeSession.

- [ ] **Step 1: Criar o fake-codex `server/test/fake-codex.mjs`**

Script que emite as linhas v2 no stdout e sai (lê o prompt do stdin, ecoa como agent_message):

```javascript
#!/usr/bin/env node
// Fake do `codex exec`/`exec resume` para testes: emite o protocolo v2 e sai.
// Uso: node fake-codex.mjs <exec|resume> [threadId] ... -   (prompt via stdin)
import { stdin } from 'node:process'
const args = process.argv.slice(2)
const isResume = args.includes('resume')
const threadId = isResume ? (args[args.indexOf('resume') + 1] || 'THREAD-FAKE') : 'THREAD-FAKE'
let prompt = ''
stdin.setEncoding('utf8')
stdin.on('data', (d) => { prompt += d })
stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  if (!isResume) out({ type: 'thread.started', thread_id: threadId })
  out({ type: 'turn.started' })
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: `echo:${prompt.trim()}` } })
  out({ type: 'turn.completed', usage: { output_tokens: 1 } })
  process.exit(0)
})
```

- [ ] **Step 2: Escrever o teste que falha**

`server/test/codex-session.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { CodexSession } from '../src/engine/codex/codex-session.js'
import type { AgentEvent } from '../src/engine/types.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-codex.mjs')

const mk = () => new CodexSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE] })
const waitFor = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now(); const i = setInterval(() => { if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) } }, 10)
})

describe('CodexSession (turn-based)', () => {
  it('start() não spawna; status idle', () => {
    const s = mk(); s.start()
    expect(s.status).toBe('idle')
  })

  it('send() roda um turno: init(sessionId) + assistant + result; volta a needs_attention', async () => {
    const s = mk(); s.start()
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('hello')
    expect(s.status).toBe('working')
    await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('THREAD-FAKE')
    expect(events.some((e) => e.kind === 'init')).toBe(true)
    expect(events.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('echo:hello'))).toBe(true)
    expect(events.some((e) => e.kind === 'result')).toBe(true)
  })

  it('2º send usa resume (não re-emite init) e mantém o thread', async () => {
    const s = mk(); s.start()
    s.send('one'); await waitFor(() => s.status === 'needs_attention')
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('two'); await waitFor(() => s.status === 'needs_attention')
    expect(events.some((e) => e.kind === 'init')).toBe(false) // resume não re-inicia
    expect(s.sessionId).toBe('THREAD-FAKE')
  })

  it('stop() encerra e recusa novas mensagens', async () => {
    const s = mk(); s.start(); await s.stop()
    expect(s.status).toBe('stopped')
    expect(() => s.send('x')).toThrow()
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd server && npx vitest run test/codex-session.test.ts`
Expected: FAIL — `CodexSession` não existe.

- [ ] **Step 4: Implementar `server/src/engine/codex/codex-session.ts`**

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { EngineSession, EngineSessionOptions } from '../types.js'
import type { SessionStatus } from '../../claude/session.js'
import { buildExecArgs, buildResumeArgs } from './codex-args.js'
import { createCodexTurnParser } from './codex-parser.js'

/** Sessão Codex turn-based: 1 processo `codex exec`/`exec resume` por turno. */
export class CodexSession extends EventEmitter implements EngineSession {
  status: SessionStatus = 'starting'
  sessionId?: string
  private proc?: ChildProcessWithoutNullStreams
  private stopping = false
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

  start(): void {
    // Turn-based: nada spawna aqui. Só marca a sessão pronta.
    this.setStatus('idle')
  }

  send(text: string): void {
    if (this.status === 'stopped' || this.status === 'dead') throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    if (this.status === 'working') throw new Error('turno em andamento')
    const bin = this.opts.binOverride ?? this.opts.bin ?? process.env.CLAUDINEI_CODEX_BIN ?? 'codex'
    const turnOpts = { model: this.model, effort: this.effort, hermes: this.opts.hermes }
    const baseArgs = this.sessionId ? buildResumeArgs(this.sessionId, turnOpts) : buildExecArgs(turnOpts)
    const args = this.opts.extraArgsOverride ? [...this.opts.extraArgsOverride, ...baseArgs] : baseArgs
    this.proc = spawn(bin, args, { cwd: this.opts.projectPath, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PKG_EXECPATH: '' } })
    this.setStatus('working')
    let sawResult = false
    const feed = createCodexTurnParser((evt) => {
      if (evt.kind === 'init') { this.sessionId = evt.sessionId; this.emit('event', evt); return }
      if (evt.kind === 'result') sawResult = true
      this.emit('event', evt)
    }, this.model)
    this.proc.stdout.on('data', feed)
    this.proc.stderr.on('data', (d) => {
      const s = d.toString(); this.stderrTail.push(s); if (this.stderrTail.length > 20) this.stderrTail.shift(); this.emit('stderr', s)
    })
    this.proc.stdin.write(text); this.proc.stdin.end()
    this.proc.on('close', (code) => {
      this.proc = undefined
      if (this.stopping) { this.setStatus('stopped'); return }
      if (code !== 0 && !sawResult) { this.setStatus('dead'); this.emit('exit', code); return }
      this.setStatus(sawResult ? 'needs_attention' : 'idle')
      this.emit('exit', code)
    })
    this.proc.on('error', () => this.setStatus('dead'))
  }

  markRead(): void { if (this.status === 'needs_attention') this.setStatus('idle') }

  interrupt(): Promise<void> {
    if (this.status === 'working' && this.proc) {
      const p = this.proc
      p.kill('SIGTERM')
      setTimeout(() => { try { p.kill('SIGKILL') } catch { /* já morreu */ } }, 3000)
    }
    return Promise.resolve()
  }

  setModel(model: string): Promise<void> { this.model = model || undefined; return Promise.resolve() }
  setPermissionMode(_mode: string): Promise<void> { return Promise.resolve() } // Codex: full-access fixo

  async stop(): Promise<void> {
    this.stopping = true
    if (this.proc) {
      const p = this.proc
      p.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* */ } resolve() }, 5000)
        p.once('close', () => { clearTimeout(t); resolve() })
      })
    } else {
      this.setStatus('stopped')
    }
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === 'dead' || this.status === 'stopped') return
    if (s !== this.status) { this.status = s; this.emit('status', s) }
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd server && npx vitest run test/codex-session.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 6: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/codex/codex-session.ts server/test/fake-codex.mjs server/test/codex-session.test.ts
git commit -m "feat(codex): CodexSession turn-based (EngineSession) + fake-codex de teste

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `codexEngine` + rollout (history) + registro

**Files:**
- Create: `server/src/engine/codex/rollout.ts`
- Create: `server/src/engine/codex/codex-engine.ts`
- Modify: `server/src/engine/index.ts` (registra codexEngine)
- Test: `server/test/codex-engine.test.ts`

**Interfaces:**
- Consumes: `Engine`/`EngineSession`/`EngineCapabilities` de `../types.js`; `CodexSession`; `classifyCodexLine` (rollout).
- Produces: `codexEngine: Engine` (id `'codex'`); `parseRollout(file): AgentEvent[]`, `findRollout(sessionsRoot, threadId): string | null`, `latestThreadForCwd(sessionsRoot, cwd): string | null` em `rollout.ts`. `capabilities()` com a lista de models do de-risk. `engine/index.ts` registra codexEngine.

- [ ] **Step 1: Escrever o teste que falha**

`server/test/codex-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { codexEngine } from '../src/engine/codex/codex-engine.js'
import { getEngine, hasEngine } from '../src/engine/index.js'
import { CodexSession } from '../src/engine/codex/codex-session.js'

describe('codexEngine', () => {
  it('registrado com id codex', () => {
    expect(hasEngine('codex')).toBe(true)
    expect(getEngine('codex')).toBe(codexEngine)
  })

  it('createSession → CodexSession sem spawnar', () => {
    const s = codexEngine.createSession({ projectPath: '/tmp' })
    expect(s).toBeInstanceOf(CodexSession)
    expect(s.status).toBe('starting')
  })

  it('terminalCommand → codex resume <id> --dangerously-bypass-approvals-and-sandbox', () => {
    expect(codexEngine.terminalCommand({ resumeSessionId: 'T1', projectPath: '/tmp', bin: 'codex' }))
      .toEqual({ file: 'codex', args: ['resume', 'T1', '--dangerously-bypass-approvals-and-sandbox'] })
  })

  it('capabilities: efforts do codex, sem permissions, slash curated', () => {
    const c = codexEngine.capabilities()
    expect(c.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(c.permissions).toEqual([])
    expect(c.slashSource).toBe('curated')
    expect(c.models.length).toBeGreaterThan(0)
  })

  it('readHistory sem rollout → []', () => {
    expect(codexEngine.readHistory('/nao/existe', 'THREAD-NADA')).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/codex-engine.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar `server/src/engine/codex/rollout.ts`**

```typescript
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { classifyCodexLine } from './codex-parser.js'
import type { AgentEvent } from '../types.js'

export function sessionsRoot(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(homedir(), '.codex', 'sessions')
}

/** Varre a árvore YYYY/MM/DD e devolve os caminhos de rollout .jsonl (mais recentes primeiro). */
function allRollouts(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(p)
      } catch { /* sumiu no meio */ }
    }
  }
  walk(root)
  return out.sort((a, b) => (statSync(b).mtimeMs - statSync(a).mtimeMs))
}

export function findRollout(root: string, threadId: string): string | null {
  return allRollouts(root).find((p) => p.includes(threadId)) ?? null
}

/** Normaliza um rollout do Codex (response_item da Responses API) para AgentEvent[]. */
export function parseRollout(file: string): AgentEvent[] {
  if (!existsSync(file)) return []
  const events: AgentEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue
    let o: any; try { o = JSON.parse(s) } catch { continue }
    if (o.type !== 'response_item') continue
    const p = o.payload
    if (p?.type === 'message') {
      const role = p.role === 'assistant' ? 'assistant' : 'user'
      const text = (Array.isArray(p.content) ? p.content : []).map((c: any) => c.text ?? '').join('')
      if (text) events.push({ kind: role === 'assistant' ? 'assistant' : 'user', message: { role, content: [{ type: 'text', text }] } as never, raw: o })
    } else if (p?.type === 'reasoning') {
      const text = p.summary?.map?.((s: any) => s.text ?? '').join('') ?? p.text ?? ''
      if (text) events.push({ kind: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } as never, raw: o })
    }
    // function_call/output do rollout: omitidos do preview (evita ruído; o ao vivo já mostra tools)
  }
  return events
}

export function latestThreadForCwd(root: string, cwd: string): string | null {
  for (const file of allRollouts(root)) {
    try {
      const first = readFileSync(file, 'utf8').split('\n', 1)[0]
      const o = JSON.parse(first)
      if (o?.type === 'session_meta' && o.payload?.cwd === cwd) return o.payload.id ?? null
    } catch { /* ignora */ }
  }
  return null
}
```

- [ ] **Step 4: Implementar `server/src/engine/codex/codex-engine.ts`**

```typescript
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from '../types.js'
import { CodexSession } from './codex-session.js'
import { sessionsRoot, findRollout, parseRollout, latestThreadForCwd } from './rollout.js'

const CAPABILITIES: EngineCapabilities = {
  // Lista canônica fixada no de-risk (Task 1). '' = padrão do config do usuário.
  models: ['', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  efforts: ['low', 'medium', 'high', 'xhigh'],
  permissions: [], // full-access fixo; sem seletor
  slashSource: 'curated',
}

export const codexEngine: Engine = {
  id: 'codex',
  createSession(opts: EngineSessionOptions): EngineSession {
    return new CodexSession(opts)
  },
  readHistory(_projectPath: string, threadId: string): AgentEvent[] {
    const file = findRollout(sessionsRoot(), threadId)
    return file ? parseRollout(file) : []
  },
  latestConversationId(projectPath: string): string | null {
    return latestThreadForCwd(sessionsRoot(), projectPath)
  },
  terminalCommand(opts: { resumeSessionId: string; projectPath: string; bin?: string }) {
    return { file: opts.bin ?? process.env.CLAUDINEI_CODEX_BIN ?? 'codex', args: ['resume', opts.resumeSessionId, '--dangerously-bypass-approvals-and-sandbox'] }
  },
  capabilities(): EngineCapabilities { return CAPABILITIES },
}
```

- [ ] **Step 5: Registrar em `server/src/engine/index.ts`**

Adicionar após o registro do claudeEngine:

```typescript
import { codexEngine } from './codex/codex-engine.js'
// ...
if (!hasEngine(codexEngine.id)) registerEngine(codexEngine)
```

- [ ] **Step 6: Rodar e ver passar (+ regressão)**

Run: `cd server && npx vitest run test/codex-engine.test.ts test/engine-registry.test.ts test/engine-routes.test.ts && npm test`
Expected: PASS. Agora `engine-routes.test.ts`: o teste "engine=codex → 400 unknown_engine" **muda de comportamento** — com o codex registrado, vira 201. **Este é o único teste que precisa ser atualizado** (era um placeholder que o próprio plano do SP-A anotou: "vira 201 quando o SP-B registrar a engine"). Atualizar esse caso para esperar 201 e `engine: 'codex'` (usando o fake via sessionFactory para não spawnar codex real). Documentar a mudança no relatório.

- [ ] **Step 7: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/codex/rollout.ts server/src/engine/codex/codex-engine.ts server/src/engine/index.ts server/test/codex-engine.test.ts server/test/engine-routes.test.ts
git commit -m "feat(codex): codexEngine (Engine) + rollout history + registro; codex vira engine válida

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Rewiring do terminal (openInTerminal via engine.terminalCommand)

**Files:**
- Modify: `server/src/terminal/manager.ts` (`OpenOpts` → `file`/`args`)
- Modify: `server/src/claude/manager.ts` (`openInTerminal` + `TerminalLauncherOpts`)
- Modify: `server/src/index.ts` (wiring do `terminalLauncher`)
- Test: `server/test/terminal-manager.test.ts` (adaptar construção de OpenOpts), `server/test/terminal-routes.test.ts` / `terminal-e2e.test.ts` (adaptar fake launcher se assertar opts)

**Interfaces:**
- Consumes: `getEngine(engine).terminalCommand(...)`.
- Produces: `OpenOpts = { cwd: string; file: string; args: string[]; onExit: () => void }`; `TerminalLauncherOpts = { localId: string; cwd: string; file: string; args: string[]; onExit: () => void }`.

- [ ] **Step 1: Adaptar `server/src/terminal/manager.ts`**

`OpenOpts` passa a ser `{ cwd, file, args, onExit }`; `open()` usa `file`/`args` direto:

```typescript
export interface OpenOpts { cwd: string; file: string; args: string[]; onExit: () => void }
// ...em open():
      const proc = deps.ptyFactory(opts.file, opts.args, { cwd: opts.cwd, cols: 80, rows: 24 })
```

(remover o bloco `const args = ['--resume', ...]`).

- [ ] **Step 2: Adaptar `server/src/claude/manager.ts` `openInTerminal` + `TerminalLauncherOpts`**

`TerminalLauncherOpts` vira `{ localId, cwd, file, args, onExit }`. No `openInTerminal`,
resolver a engine da linha e montar file/args:

```typescript
      const engineId = (row.engine ?? DEFAULT_ENGINE_ID) as EngineId
      const { file, args } = getEngine(engineId).terminalCommand({
        resumeSessionId: row.claude_session_id, projectPath: project.path,
      })
      // ...persist in_terminal, broadcast...
      token = deps.terminalLauncher({ localId, cwd: project.path, file, args, onExit: () => { /* como hoje */ } })
```

(remover `skipPermissions`/`claudeBin` do fluxo; `deps.claudeBin` pode sair do `Deps` se
ninguém mais usa — checar com tsc.)

- [ ] **Step 3: Adaptar `server/src/index.ts`**

```typescript
    terminalLauncher: (opts) => terminalManager.open(opts.localId, {
      cwd: opts.cwd, file: opts.file, args: opts.args, onExit: opts.onExit,
    }),
```

- [ ] **Step 4: Adaptar os testes de terminal (só a construção de opts, sem enfraquecer asserções)**

Nos testes que constroem `OpenOpts`/inspecionam `TerminalLauncherOpts`, trocar
`{ claudeBin, resumeSessionId, skipPermissions }` por `{ file, args }`. As asserções de
comportamento (PTY abre, token, fanout, exit) permanecem. Ex. em `terminal-manager.test.ts`:
`manager.open('id', { cwd, file: 'echo', args: ['x'], onExit })`.

- [ ] **Step 5: Rodar e ver passar**

Run: `cd server && npx vitest run test/terminal-manager.test.ts test/terminal-routes.test.ts test/terminal-e2e.test.ts && npm test`
Expected: PASS. O comportamento do "Open in terminal" do Claude é idêntico (claudeEngine.terminalCommand devolve os mesmos args de antes).

- [ ] **Step 6: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/terminal/manager.ts server/src/claude/manager.ts server/src/index.ts server/test/terminal-manager.test.ts server/test/terminal-routes.test.ts server/test/terminal-e2e.test.ts
git commit -m "refactor(engine): Open in terminal via engine.terminalCommand (Claude idêntico; Codex resume)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Rewiring do histórico (GET /history via engine.readHistory) + integração

**Files:**
- Modify: `server/src/routes/sessions.ts` (GET /history via engine)
- Test: `server/test/engine-integration.test.ts` (novo — 1 Claude + 1 Codex coexistem)

**Interfaces:**
- Consumes: `getEngine(session.engine).readHistory(...)` / `.latestConversationId(...)`.
- Produces: nenhum símbolo novo.

- [ ] **Step 1: Adaptar `GET /api/sessions/:localId/history`**

Substituir as chamadas diretas a `readTranscript`/`latestTranscriptId` por resolução via
engine da sessão (mantendo o comportamento de preview do `--continue`):

```typescript
    const engine = getEngine((info.engine) as string)
    if (!info.claudeSessionId) {
      const row = deps.db.prepare('SELECT continue_latest FROM sessions WHERE local_id=?').get(localId) as any
      if (!row?.continue_latest) return []
      const prev = engine.latestConversationId(project.path)
      return prev ? engine.readHistory(project.path, prev).slice(-HISTORY_EVENT_LIMIT) : []
    }
    return engine.readHistory(project.path, info.claudeSessionId).slice(-HISTORY_EVENT_LIMIT)
```

(o `info` já vem do manager com `engine`; `HISTORY_EVENT_LIMIT` inalterado. O
`claudeEngine.readHistory` delega ao `readTranscript` — comportamento do Claude idêntico.)

- [ ] **Step 2: Escrever o teste de integração**

`server/test/engine-integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createProjectsService } from '../src/projects.js'
import '../src/engine/index.js' // registra claude + codex
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { CodexSession } from '../src/engine/codex/codex-session.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs')
const FAKE_CODEX = join(__dirname, 'fake-codex.mjs')

// Factory que escolhe o fake conforme a engine desejada — simula os dois adapters.
const factory = (opts: any) =>
  opts.__engine === 'codex'
    ? new CodexSession({ ...opts, binOverride: process.execPath, extraArgsOverride: [FAKE_CODEX] })
    : new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE_CLAUDE] } as SessionOptions)

let db: Db, project: { id: number; name: string; path: string }
beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'ei-')) })
})

describe('1 Claude + 1 Codex no mesmo terminal', () => {
  it('start claude e codex coexistem; SessionInfo.engine correto', () => {
    // sessionFactory recebe as opts SEM saber a engine; para o teste, marcamos via closure
    let nextEngine = 'claude'
    const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: (o) => factory({ ...o, __engine: nextEngine }) })
    nextEngine = 'claude'; const c = manager.start(project as any, { engine: 'claude' })
    nextEngine = 'codex'; const x = manager.start(project as any, { engine: 'codex' })
    expect(c.engine).toBe('claude'); expect(x.engine).toBe('codex')
    const list = manager.list()
    expect(list.filter((s) => s.projectId === project.id).map((s) => s.engine).sort()).toEqual(['claude', 'codex'])
    // 2ª claude no mesmo projeto rejeitada
    nextEngine = 'claude'
    expect(() => manager.start(project as any, { engine: 'claude' })).toThrow(/já possui sessão ativa/)
  })
})
```

- [ ] **Step 3: Rodar e ver passar (+ regressão total)**

Run: `cd server && npx vitest run test/engine-integration.test.ts test/routes-sessions.test.ts && npm test && npx tsc --noEmit`
Expected: PASS. Suíte inteira verde; Claude intocado.

- [ ] **Step 4: Commit**

```bash
cd /home/coppi/Projects/Termaster
git add server/src/routes/sessions.ts server/test/engine-integration.test.ts
git commit -m "feat(codex): GET /history via engine.readHistory + teste de integração (1 Claude + 1 Codex)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verificação final + smoke real (fora das tasks)

```bash
cd /home/coppi/Projects/Termaster/server && npm test && npx tsc --noEmit
```
Esperado: suíte verde (Claude intocado + novos de codex), tsc limpo.

**Smoke real (controlador, Codex logado):** subir o app, criar um terminal Codex num
projeto real, mandar uma mensagem (turno roda, chat popula), 2º turno (resume mantém
contexto), interrupt no meio de um turno, e 1 Claude + 1 Codex no mesmo projeto ao vivo.

## Self-Review (checklist do autor)

- **Cobertura do spec:** de-risk ✅ (T1); codex-args ✅ (T3); parser v2→AgentEvent ✅ (T4);
  CodexSession turn-based ✅ (T5); codexEngine + rollout/history + registro ✅ (T6);
  capabilities/terminalCommand ✅ (T6); bin por engine ✅ (T2); rewiring terminal ✅ (T7);
  rewiring history ✅ (T8); integração 1 Claude + 1 Codex ✅ (T8).
- **Sem placeholders:** todo passo com código; a única incerteza (sintaxe exata do `-c`
  para MCP) é resolvida pelo de-risk (T1) antes da T3.
- **Consistência de tipos:** `EngineSession`/`EngineSessionOptions`/`AgentEvent`/`Engine`
  do SP-A reusados; `buildExecArgs`/`buildResumeArgs`/`classifyCodexLine`/`CodexSession`/
  `codexEngine` encadeados T3→T6.
