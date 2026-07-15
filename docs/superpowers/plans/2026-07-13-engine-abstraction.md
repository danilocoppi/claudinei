# SP-A — Abstração de engine (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduzir uma abstração de engine plugável no backend (registry aberto + interface `Engine`/`EngineSession`), com o Claude atrás dela, sem mudar nenhum comportamento observável.

**Architecture:** Um `server/src/engine/` novo com as interfaces + um registry por id-string. O `ClaudeSession` de hoje passa a `implements EngineSession`; um `claudeEngine` fino implementa `Engine` delegando ao código Claude existente. O manager cria sessões via `getEngine(id).createSession(...)` em vez de `new ClaudeSession`, ganha uma coluna `engine` em `sessions` e uma trava de sessão escopada por `(projeto, engine)`. As rotas aceitam `engine?` na criação, validado pelo registry.

**Tech Stack:** Fastify 5, better-sqlite3, TypeScript ESM estrito (imports relativos com `.js`), vitest, EventEmitter do Node.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-engine-abstraction-design.md`.
- **Refactor sem mudança de comportamento.** A barra de sucesso: a suíte atual
  permanece verde e **inalterada** (server 338 passed | 1 skipped). Nenhum teste de
  comportamento existente é modificado — se algum precisar mudar, o refactor vazou
  comportamento. Só se ADICIONAM testes novos.
- **Registry aberto:** `engine` é `string` validada pelo registry, nunca union fechado.
  Proibido `switch (engine)`; toda resolução por `getEngine(id)`. `DEFAULT_ENGINE_ID = 'claude'`.
- **Trava de concorrência:** no máximo uma sessão viva por `(projeto, engine)`. Com só
  o `claude` registrado, é idêntico ao comportamento de hoje (uma por projeto).
- **SP-A é 100% backend.** Não toca em `web/`. Não renomeia `claudeSessionId` no fio/WS
  (isso é SP-C). Não faz rewiring dos call-sites de `terminal/manager.ts` nem da rota
  `GET /history` (isso é SP-B) — mas a engine já define e testa `terminalCommand`/
  `readHistory`/`latestConversationId`.
- **`EngineSession` é um EventEmitter** (o manager assina `.on('status'|'event')` pós-
  construção e chama `.start()`, exatamente como hoje) — refina o esboço do spec, que
  citava callbacks; mesma semântica, churn mínimo.
- ESM/TS strict, imports com `.js`. Commits com trailer
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Rodar testes: `cd server && npm test`; um arquivo: `cd server && npx vitest run test/<arquivo>`.

## File Structure

- `server/src/engine/types.ts` (novo) — `EngineId`, `AgentEvent` (alias de `ClaudeEvent`),
  `EngineSession`, `EngineCapabilities`, `EngineSessionOptions`, `Engine`. Só tipos.
- `server/src/engine/registry.ts` (novo) — Map + `registerEngine`/`getEngine`/`hasEngine`/
  `listEngines` + `DEFAULT_ENGINE_ID`. Sem side-effects.
- `server/src/engine/claude-engine.ts` (novo) — `claudeEngine: Engine` delegando a
  `claude/session.ts` e `history.ts`.
- `server/src/engine/index.ts` (novo) — registra `claudeEngine` (idempotente) e re-exporta
  o registry. É o módulo que o manager importa (garante a engine registrada onde o manager roda).
- `server/src/claude/session.ts` (modificar) — `ClaudeSession implements EngineSession`;
  `setPermissionMode(mode: string)` (alarga o param de `PermissionMode`→`string`).
- `server/src/claude/manager.ts` (modificar) — cria sessão via registry; `engine` no
  `live`, no `SessionInfo`, e persistido; trava `(projeto, engine)`.
- `server/src/db.ts` (modificar) — coluna `engine`.
- `server/src/routes/sessions.ts` (modificar) — `POST /sessions` aceita `engine?` validado.
- `server/src/index.ts` (modificar) — importa `./engine/index.js` no boot do servidor.

---

### Task 1: `engine/types.ts` + `engine/registry.ts`

**Files:**
- Create: `server/src/engine/types.ts`
- Create: `server/src/engine/registry.ts`
- Test: `server/test/engine-registry.test.ts`

**Interfaces:**
- Consumes: `ClaudeEvent` de `../claude/events.js`; `SessionStatus`/`PermissionMode` de `../claude/session.js`; `HermesOptions` de `../claude/session.js`.
- Produces:
  - `type EngineId = string`
  - `type AgentEvent = ClaudeEvent`
  - `interface EngineSession extends EventEmitter` com: `status: SessionStatus`, `sessionId?: string`, `readonly lastStderr: string`, `start(): void`, `send(text: string): void`, `markRead(): void`, `interrupt(): Promise<void>`, `setModel(model: string): Promise<void>`, `setPermissionMode(mode: string): Promise<void>`, `stop(): Promise<void>`.
  - `interface EngineSessionOptions` = campos de sessão genéricos (ver código).
  - `interface EngineCapabilities { models: string[]; efforts: string[]; permissions: string[]; slashSource: 'protocol' | 'curated' | 'none' }`.
  - `interface Engine { id: EngineId; createSession(opts: EngineSessionOptions): EngineSession; readHistory(projectPath: string, engineSessionId: string): AgentEvent[]; latestConversationId(projectPath: string): string | null; terminalCommand(opts: { resumeSessionId: string; projectPath: string; bin?: string }): { file: string; args: string[] }; capabilities(): EngineCapabilities }`.
  - `registerEngine(e: Engine): void` (lança `engine_already_registered` em id duplicado); `getEngine(id: EngineId): Engine` (lança `unknown_engine`); `hasEngine(id: EngineId): boolean`; `listEngines(): Engine[]`; `const DEFAULT_ENGINE_ID = 'claude'`.

- [ ] **Step 1: Escrever o teste que falha**

`server/test/engine-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { registerEngine, getEngine, hasEngine, listEngines, DEFAULT_ENGINE_ID, __resetRegistry } from '../src/engine/registry.js'
import type { Engine } from '../src/engine/types.js'

const stubEngine = (id: string): Engine => ({
  id,
  createSession: () => { throw new Error('not used in this test') },
  readHistory: () => [],
  latestConversationId: () => null,
  terminalCommand: () => ({ file: 'x', args: [] }),
  capabilities: () => ({ models: [], efforts: [], permissions: [], slashSource: 'none' }),
})

describe('engine registry', () => {
  beforeEach(() => __resetRegistry())

  it('register/get/has/list', () => {
    expect(hasEngine('a')).toBe(false)
    const a = stubEngine('a')
    registerEngine(a)
    expect(hasEngine('a')).toBe(true)
    expect(getEngine('a')).toBe(a)
    expect(listEngines().map((e) => e.id)).toEqual(['a'])
  })

  it('id duplicado lança', () => {
    registerEngine(stubEngine('a'))
    expect(() => registerEngine(stubEngine('a'))).toThrow('engine_already_registered')
  })

  it('id desconhecido lança', () => {
    expect(() => getEngine('nope')).toThrow('unknown_engine')
  })

  it('DEFAULT_ENGINE_ID é claude', () => {
    expect(DEFAULT_ENGINE_ID).toBe('claude')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/engine-registry.test.ts`
Expected: FAIL — módulos `engine/registry.js`/`engine/types.js` não existem.

- [ ] **Step 3: Implementar `server/src/engine/types.ts`**

```typescript
import type { EventEmitter } from 'node:events'
import type { ClaudeEvent } from '../claude/events.js'
import type { SessionStatus, HermesOptions } from '../claude/session.js'

/** Id de engine — aberto; a validade é "está registrado no registry?", nunca um union fechado. */
export type EngineId = string

/** Evento normalizado de agente. Hoje idêntico ao shape do Claude; o Codex normaliza para cá (SP-B). */
export type AgentEvent = ClaudeEvent

/** Opções genéricas para criar uma sessão de qualquer engine. */
export interface EngineSessionOptions {
  projectPath: string
  resumeSessionId?: string
  continueLatest?: boolean
  model?: string
  effort?: string
  permissionMode?: string
  hermes?: HermesOptions
  /** Binário da engine (Claude: config.claudeBin). Ausente → default da engine. */
  bin?: string
  /** Somente testes: substitui TODOS os args do processo (aponta para o fake). */
  extraArgsOverride?: string[]
}

/** Uma sessão viva. EventEmitter: o manager assina 'status' e 'event' e chama start(). */
export interface EngineSession extends EventEmitter {
  status: SessionStatus
  sessionId?: string
  readonly lastStderr: string
  start(): void
  send(text: string): void
  markRead(): void
  interrupt(): Promise<void>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  stop(): Promise<void>
}

export interface EngineCapabilities {
  models: string[]
  efforts: string[]
  permissions: string[]
  slashSource: 'protocol' | 'curated' | 'none'
}

/** Uma engine (registrada uma vez). */
export interface Engine {
  id: EngineId
  createSession(opts: EngineSessionOptions): EngineSession
  readHistory(projectPath: string, engineSessionId: string): AgentEvent[]
  latestConversationId(projectPath: string): string | null
  terminalCommand(opts: { resumeSessionId: string; projectPath: string; bin?: string }): { file: string; args: string[] }
  capabilities(): EngineCapabilities
}
```

- [ ] **Step 4: Implementar `server/src/engine/registry.ts`**

```typescript
import type { Engine, EngineId } from './types.js'

export const DEFAULT_ENGINE_ID: EngineId = 'claude'

const engines = new Map<EngineId, Engine>()

export function registerEngine(engine: Engine): void {
  if (engines.has(engine.id)) throw new Error(`engine_already_registered: ${engine.id}`)
  engines.set(engine.id, engine)
}

export function getEngine(id: EngineId): Engine {
  const e = engines.get(id)
  if (!e) throw new Error(`unknown_engine: ${id}`)
  return e
}

export function hasEngine(id: EngineId): boolean {
  return engines.has(id)
}

export function listEngines(): Engine[] {
  return [...engines.values()]
}

/** Somente testes: limpa o registry entre casos. */
export function __resetRegistry(): void {
  engines.clear()
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd server && npx vitest run test/engine-registry.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 6: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/engine/types.ts server/src/engine/registry.ts server/test/engine-registry.test.ts
git commit -m "feat(engine): interface Engine/EngineSession + registry aberto

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `claudeEngine` + bootstrap + `ClaudeSession implements EngineSession`

**Files:**
- Modify: `server/src/claude/session.ts` (declara `implements EngineSession`; `setPermissionMode(mode: string)`)
- Create: `server/src/engine/claude-engine.ts`
- Create: `server/src/engine/index.ts`
- Test: `server/test/claude-engine.test.ts`

**Interfaces:**
- Consumes: `Engine`/`EngineSession`/`EngineSessionOptions`/`EngineCapabilities` (Task 1); `ClaudeSession` de `../claude/session.js`; `latestTranscriptId`/`readTranscript` de `../history.js`.
- Produces: `claudeEngine: Engine` (id `'claude'`); `server/src/engine/index.ts` re-exporta `getEngine`/`hasEngine`/`listEngines`/`registerEngine`/`DEFAULT_ENGINE_ID` e registra o `claudeEngine` no load (guardado por `hasEngine`). `capabilities()` do claude: `models: ['', 'fable', 'opus', 'sonnet', 'haiku']`, `efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']`, `permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan']`, `slashSource: 'protocol'`.

- [ ] **Step 1: `ClaudeSession implements EngineSession` + alargar `setPermissionMode`**

Em `server/src/claude/session.ts`:
- Adicionar import: `import type { EngineSession } from '../engine/types.js'`.
- Trocar a assinatura da classe: `export class ClaudeSession extends EventEmitter implements EngineSession {`.
- Trocar a assinatura de `setPermissionMode` de `(mode: PermissionMode)` para `(mode: string)`:

```typescript
  setPermissionMode(mode: string): Promise<void> { return this.sendControl('set_permission_mode', { mode }) }
```

(o corpo é idêntico — só o tipo do parâmetro alarga; a chamada interna no `init`,
`this.setPermissionMode(desired)` com `desired: PermissionMode`, continua válida pois
`PermissionMode` é subtipo de `string`.)

- [ ] **Step 2: Escrever o teste que falha**

`server/test/claude-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { getEngine, hasEngine } from '../src/engine/index.js'

describe('claudeEngine', () => {
  it('é registrado pelo bootstrap com id claude', () => {
    expect(hasEngine('claude')).toBe(true)
    expect(getEngine('claude')).toBe(claudeEngine)
  })

  it('createSession devolve um EngineSession (surface completa) sem spawnar', () => {
    const s = claudeEngine.createSession({ projectPath: '/tmp' })
    for (const m of ['start', 'send', 'markRead', 'interrupt', 'setModel', 'setPermissionMode', 'stop']) {
      expect(typeof (s as any)[m]).toBe('function')
    }
    expect(s.status).toBe('starting')
    expect(typeof s.lastStderr).toBe('string')
    expect(typeof (s as any).on).toBe('function') // EventEmitter
  })

  it('terminalCommand devolve claude --resume <id> --dangerously-skip-permissions', () => {
    expect(claudeEngine.terminalCommand({ resumeSessionId: 'abc', projectPath: '/tmp', bin: 'claude' }))
      .toEqual({ file: 'claude', args: ['--resume', 'abc', '--dangerously-skip-permissions'] })
  })

  it('capabilities traz as listas do Claude', () => {
    const c = claudeEngine.capabilities()
    expect(c.models).toContain('fable')
    expect(c.efforts).toContain('ultracode')
    expect(c.permissions).toContain('bypassPermissions')
    expect(c.slashSource).toBe('protocol')
  })

  it('latestConversationId inexistente devolve null', () => {
    expect(claudeEngine.latestConversationId('/nao/existe/xyz')).toBeNull()
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd server && npx vitest run test/claude-engine.test.ts`
Expected: FAIL — `engine/claude-engine.js`/`engine/index.js` não existem.

- [ ] **Step 4: Implementar `server/src/engine/claude-engine.ts`**

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeSession } from '../claude/session.js'
import { latestTranscriptId, readTranscript } from '../history.js'
import type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, AgentEvent } from './types.js'

// Diretório de config do Claude (mesma regra do config.ts) — a engine resolve
// sozinha, para readHistory/latestConversationId não dependerem do manager.
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

const CAPABILITIES: EngineCapabilities = {
  models: ['', 'fable', 'opus', 'sonnet', 'haiku'],
  efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'],
  slashSource: 'protocol',
}

export const claudeEngine: Engine = {
  id: 'claude',

  createSession(opts: EngineSessionOptions): EngineSession {
    // Mapeia as opções genéricas para as SessionOptions do ClaudeSession.
    return new ClaudeSession({
      projectPath: opts.projectPath,
      resumeSessionId: opts.resumeSessionId,
      continueLatest: opts.continueLatest,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode as never, // PermissionMode; validado a montante
      hermes: opts.hermes,
      claudeBin: opts.bin,
      extraArgsOverride: opts.extraArgsOverride,
    })
  },

  readHistory(projectPath: string, engineSessionId: string): AgentEvent[] {
    return readTranscript(claudeConfigDir(), projectPath, engineSessionId)
  },

  latestConversationId(projectPath: string): string | null {
    return latestTranscriptId(claudeConfigDir(), projectPath)
  },

  terminalCommand(opts: { resumeSessionId: string; projectPath: string; bin?: string }) {
    return {
      file: opts.bin ?? 'claude',
      args: ['--resume', opts.resumeSessionId, '--dangerously-skip-permissions'],
    }
  },

  capabilities(): EngineCapabilities {
    return CAPABILITIES
  },
}
```

- [ ] **Step 5: Implementar `server/src/engine/index.ts` (bootstrap + re-export)**

```typescript
// Ponto único de import do registry pelos consumidores (manager, rotas): importar
// este módulo registra as engines embutidas como side-effect, garantindo o registry
// populado onde quer que o manager rode. Adicionar uma engine futura = mais uma linha.
import { registerEngine, hasEngine } from './registry.js'
import { claudeEngine } from './claude-engine.js'

if (!hasEngine(claudeEngine.id)) registerEngine(claudeEngine)

export { getEngine, hasEngine, listEngines, registerEngine, DEFAULT_ENGINE_ID } from './registry.js'
export type { Engine, EngineSession, EngineSessionOptions, EngineCapabilities, EngineId, AgentEvent } from './types.js'
```

- [ ] **Step 6: Rodar e ver passar (+ regressão da session)**

Run: `cd server && npx vitest run test/claude-engine.test.ts test/session.test.ts test/session-control.test.ts`
Expected: PASS (novos + os de session inalterados e verdes).

- [ ] **Step 7: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/claude/session.ts server/src/engine/claude-engine.ts server/src/engine/index.ts server/test/claude-engine.test.ts
git commit -m "feat(engine): claudeEngine implementa Engine + bootstrap do registry; ClaudeSession implements EngineSession

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: manager cria sessão via registry + coluna `engine` + trava `(projeto, engine)`

**Files:**
- Modify: `server/src/db.ts` (coluna `engine`)
- Modify: `server/src/claude/manager.ts`
- Test: `server/test/engine-manager.test.ts` (novo)

**Interfaces:**
- Consumes: `getEngine`/`DEFAULT_ENGINE_ID`/`EngineId`/`EngineSession` de `../engine/index.js`.
- Produces: `SessionInfo` ganha `engine: EngineId`; `manager.start(project, opts?)` aceita `opts.engine?: string`; a trava de start/revive é escopada por `(project_id, engine)`. O dep `sessionFactory?` passa a ter tipo `(opts: EngineSessionOptions) => EngineSession` (o `new ClaudeSession(...)` dos testes continua compatível).

- [ ] **Step 1: Migração da coluna em `server/src/db.ts`**

Acrescentar, junto aos outros `ALTER TABLE sessions` idempotentes (após a linha do `effort`):

```typescript
  try { db.exec(`ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'`) } catch { /* já existe */ }
```

- [ ] **Step 2: Escrever o teste que falha**

`server/test/engine-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { registerEngine, __resetRegistry } from '../src/engine/registry.js'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createProjectsService } from '../src/projects.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

// Engine fake: createSession devolve um ClaudeSession apontando para o fake-claude,
// para exercitar a trava por (projeto, engine) com DUAS engines distintas.
const fakeEngine = (id: string) => ({
  id,
  createSession: (opts: any) => new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] } as SessionOptions),
  readHistory: () => [],
  latestConversationId: () => null,
  terminalCommand: () => ({ file: 'x', args: [] }),
  capabilities: () => ({ models: [], efforts: [], permissions: [], slashSource: 'none' as const }),
})

let db: Db
let project: { id: number; name: string; path: string }

beforeEach(() => {
  __resetRegistry()
  registerEngine(claudeEngine)   // 'claude'
  registerEngine(fakeEngine('engA'))
  registerEngine(fakeEngine('engB'))
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  project = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'eng-')) })
})

describe('manager + engine', () => {
  it('SessionInfo carrega engine (default claude); start persiste a engine', () => {
    const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: (o) => new ClaudeSession({ ...o, claudeBin: process.execPath, extraArgsOverride: [FAKE] }) })
    const info = manager.start(project as any)
    expect(info.engine).toBe('claude')
    const row = db.prepare('SELECT engine FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.engine).toBe('claude')
  })

  it('trava por (projeto, engine): permite engA + engB no mesmo projeto, rejeita 2ª da MESMA engine', () => {
    // sem sessionFactory → o manager resolve via registry (getEngine(engine).createSession)
    const manager = createSessionManager({ db, broadcast: () => {} })
    const a = manager.start(project as any, { engine: 'engA' })
    expect(a.engine).toBe('engA')
    // outra engine no MESMO projeto: permitido
    const b = manager.start(project as any, { engine: 'engB' })
    expect(b.engine).toBe('engB')
    // 2ª da MESMA engine: rejeitada
    expect(() => manager.start(project as any, { engine: 'engA' })).toThrow(/já possui sessão ativa/)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd server && npx vitest run test/engine-manager.test.ts`
Expected: FAIL — `SessionInfo` sem `engine`; `start` ignora `opts.engine`; sem coluna/registry wiring.

- [ ] **Step 4: Editar `server/src/claude/manager.ts`**

4a. Imports (topo): trocar/adicionar —

```typescript
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import type { Project } from '../projects.js'
import { ClaudeSession, type SessionOptions, type SessionStatus, type PermissionMode } from './session.js'
import type { ClaudeEvent } from './events.js'
import { getEngine, DEFAULT_ENGINE_ID, type EngineId, type EngineSession, type EngineSessionOptions } from '../engine/index.js'
```

4b. `SessionInfo` ganha `engine`:

```typescript
export interface SessionInfo {
  localId: string
  projectId: number
  engine: EngineId
  status: SessionStatus
  claudeSessionId: string | null
  updatedAt: string
  model: string | null
  permissionMode: PermissionMode
  effort: string | null
}
```

4c. `Deps.sessionFactory` e o `live` viram `EngineSession`; o `factory` vira `makeSession(engineId, opts)`:

```typescript
interface Deps {
  db: Db
  claudeBin?: string
  sessionFactory?: (opts: EngineSessionOptions) => EngineSession
  broadcast: (msg: object) => void
  terminalLauncher?: (opts: TerminalLauncherOpts) => string
  hermes?: { command: string; args: string[]; apiUrl: string; serviceToken?: string }
  onSlashCommands?: (cmds: string[]) => void
  keepSessionsPerProject?: number
  onSessionAvailable?: (projectId: number) => void
}
```

```typescript
  const live = new Map<string, { session: EngineSession; projectId: number; engine: EngineId }>()
  // Resolve a sessão pela engine (registry) — ou, em teste, pelo override sessionFactory.
  const makeSession = (engineId: EngineId, opts: EngineSessionOptions): EngineSession =>
    deps.sessionFactory ? deps.sessionFactory(opts) : getEngine(engineId).createSession({ ...opts, bin: deps.claudeBin })
```

4d. `wire` recebe e guarda o `engine`; a assinatura muda para incluí-lo:

```typescript
  const wire = (localId: string, projectId: number, engine: EngineId, session: EngineSession) => {
    live.set(localId, { session, projectId, engine })
    // ...corpo idêntico ao atual (session.on('status'...), session.on('event'...),
    //    session.start(), os dois broadcasts)...
  }
```

(o corpo de `wire` não muda em mais nada — só o `live.set` passa a incluir `engine`.)

4e. `infoOf` lê `engine`:

```typescript
    return {
      localId,
      projectId: row.project_id,
      engine: (row.engine ?? DEFAULT_ENGINE_ID) as EngineId,
      status: (liveEntry?.session.status ?? row.status) as SessionStatus,
      claudeSessionId: liveEntry?.session.sessionId ?? row.claude_session_id,
      updatedAt: row.updated_at,
      model: row.model ?? null,
      permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
      effort: row.effort ?? null,
    }
```

4f. `start` aceita `engine?` e escopa a trava por `(projeto, engine)`:

```typescript
    start(project: Project, opts?: { continueLatest?: boolean; permissionMode?: PermissionMode; model?: string; engine?: string }): SessionInfo {
      const engine = (opts?.engine ?? DEFAULT_ENGINE_ID) as EngineId
      for (const [id, entry] of live) {
        if (entry.projectId === project.id && entry.engine === engine && ACTIVE.has(entry.session.status)) {
          throw new Error(`projeto ${project.name} já possui sessão ativa (${id})`)
        }
      }
      const inTerm = deps.db.prepare(
        `SELECT 1 FROM sessions WHERE project_id=? AND engine=? AND status='in_terminal' LIMIT 1`,
      ).get(project.id, engine)
      if (inTerm) throw new Error(`projeto ${project.name} tem uma sessão aberta no terminal`)
      const permissionMode = opts?.permissionMode ?? 'bypassPermissions'
      const model = opts?.model || undefined
      const localId = randomUUID()
      deps.db.prepare(
        `INSERT INTO sessions (local_id, project_id, engine, status, permission_mode, model, continue_latest) VALUES (?, ?, ?, 'starting', ?, ?, ?)`,
      ).run(localId, project.id, engine, permissionMode, model ?? null, opts?.continueLatest ? 1 : 0)
      wire(localId, project.id, engine, makeSession(engine, {
        projectPath: project.path,
        continueLatest: opts?.continueLatest,
        permissionMode,
        model,
        hermes: deps.hermes ? { ...deps.hermes, projectId: project.id } : undefined,
      }))
      return infoOf(localId)!
    },
```

4g. `revive` usa a engine PERSISTIDA (`row.engine`) e escopa a trava por `(projeto, engine)`:

```typescript
    revive(localId: string): SessionInfo {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new Error(`sessão ${localId} não existe`)
      const engine = (row.engine ?? DEFAULT_ENGINE_ID) as EngineId
      const cur = live.get(localId)
      const effective = cur?.session.status ?? (row.status as SessionStatus)
      if (ACTIVE.has(effective)) throw new Error(`sessão ${localId} ainda está ativa`)
      if (effective === 'in_terminal') throw new Error(`sessão ${localId} está aberta no terminal`)
      for (const [id, entry] of live) {
        if (entry.projectId === row.project_id && entry.engine === engine && ACTIVE.has(entry.session.status)) {
          throw new Error(`projeto já possui sessão ativa (${id})`)
        }
      }
      const project = deps.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as any
      if (!project) throw new Error(`projeto da sessão não existe mais`)
      wire(localId, row.project_id, engine, makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: row.claude_session_id ?? undefined,
        continueLatest: row.claude_session_id ? undefined : row.continue_latest !== 0,
        permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
        hermes: deps.hermes ? { ...deps.hermes, projectId: row.project_id } : undefined,
      }))
      return infoOf(localId)!
    },
```

4h. As demais referências a `ClaudeSession`/`ClaudeEvent` no arquivo (tipos em
`askAgent`/`dispatchTask`: `{ session: ClaudeSession; projectId: number }` e
`(evt: ClaudeEvent)`) — **trocar o tipo `ClaudeSession` por `EngineSession`** nessas
duas funções (`let target: { session: EngineSession; projectId: number } | undefined`).
`ClaudeEvent` pode permanecer (é `= AgentEvent`, idêntico). O import de `ClaudeSession`
como valor deixa de ser necessário no manager — remover se o `tsc` acusar não-uso
(o `sessionFactory` dos testes constrói o `ClaudeSession`, mas isso é no arquivo de
teste, não no manager).

- [ ] **Step 5: Rodar e ver passar (+ regressão ampla)**

Run: `cd server && npx vitest run test/engine-manager.test.ts test/manager.test.ts test/session-control.test.ts test/db.test.ts && npm test`
Expected: PASS. A suíte inteira (338|1) permanece verde: os testes existentes passam
`sessionFactory`, então `makeSession` usa o fake e ignora o registry; o `SessionInfo`
agora tem `engine: 'claude'`, campo aditivo que não quebra asserções existentes.

- [ ] **Step 6: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/db.ts server/src/claude/manager.ts server/test/engine-manager.test.ts
git commit -m "feat(engine): manager cria sessão via registry, coluna engine, trava (projeto, engine)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: rota `POST /sessions` aceita `engine?` validado + bootstrap no `index.ts`

**Files:**
- Modify: `server/src/routes/sessions.ts`
- Modify: `server/src/index.ts` (import do bootstrap)
- Test: `server/test/engine-routes.test.ts` (novo)

**Interfaces:**
- Consumes: `hasEngine`/`DEFAULT_ENGINE_ID` de `../engine/index.js`; `manager.start(project, { engine })` (Task 3).
- Produces: `POST /api/projects/:id/sessions` aceita `engine?` no body; valida com `hasEngine` (400 `unknown_engine` se ausente do registry); default `DEFAULT_ENGINE_ID`. `GET /api/sessions` e `SessionInfo` serializado já expõem `engine` (vem do manager). `revive` **não** aceita engine (usa a persistida).

- [ ] **Step 1: Escrever o teste que falha**

`server/test/engine-routes.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createProjectsService } from '../src/projects.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) => new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let project: { id: number }

beforeEach(async () => {
  db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: fakeFactory })
  app = await buildApp({ config: loadConfig({}), db, manager })
  project = createProjectsService(db).create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'r-')) })
})

describe('engine na rota de sessão', () => {
  it('start sem engine → default claude; resposta traz engine', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: {} })
    expect(res.statusCode).toBe(201)
    expect(res.json().engine).toBe('claude')
  })

  it('start com engine=claude → 201', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: { engine: 'claude' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().engine).toBe('claude')
  })

  it('start com engine não registrado → 400 unknown_engine', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: { engine: 'codex' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown_engine')
  })
})
```

(Obs.: `codex` ainda não está registrado no SP-A, então `400 unknown_engine` é o
comportamento correto — vira 201 quando o SP-B registrar a engine.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/engine-routes.test.ts`
Expected: FAIL — `engine` não é lido/validado na rota (o `codex` passaria ou o campo `engine` viria ausente).

- [ ] **Step 3: Editar `server/src/routes/sessions.ts`**

Import (topo): `import { hasEngine, DEFAULT_ENGINE_ID } from '../engine/index.js'`.

No handler `POST /api/projects/:id/sessions`, após obter `project` e o `body`, validar a engine antes do `start`:

```typescript
    const body = (req.body ?? {}) as { continueConversation?: boolean; permissionMode?: string; model?: string; engine?: string }
    const engine = body?.engine ?? DEFAULT_ENGINE_ID
    if (!hasEngine(engine)) return reply.code(400).send({ error: 'unknown_engine' })
    const model = body?.model && (MODEL_ALLOWLIST.has(body.model) || FULL_MODEL_RE.test(body.model))
      ? body.model
      : undefined
    const permissionMode = body?.permissionMode && PERMISSION_MODES.has(body.permissionMode)
      ? (body.permissionMode as PermissionMode)
      : 'bypassPermissions'
    try {
      return reply.code(201).send(deps.manager.start(project, {
        continueLatest: body?.continueConversation ?? true,
        permissionMode,
        model,
        engine,
      }))
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message })
    }
```

- [ ] **Step 4: Bootstrap no `server/src/index.ts`**

No branch do modo servidor, junto dos outros `await import(...)` dinâmicos (antes de
`createSessionManager`), adicionar a importação do bootstrap do registry para garantir
o `claudeEngine` registrado no processo servidor:

```typescript
  await import('./engine/index.js')
```

(colocar logo antes de `const { createSessionManager } = await import('./claude/manager.js')`).

- [ ] **Step 5: Rodar e ver passar (+ regressão total)**

Run: `cd server && npx vitest run test/engine-routes.test.ts test/routes-sessions.test.ts && npm test`
Expected: PASS. Suíte inteira verde (338|1 + os novos): `routes-sessions.test.ts` não
passa `engine`, então cai no default `claude` — comportamento idêntico.

- [ ] **Step 6: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/routes/sessions.ts server/src/index.ts server/test/engine-routes.test.ts
git commit -m "feat(engine): POST /sessions aceita engine? validado pelo registry; bootstrap no index

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verificação final (fora das tasks)

```bash
cd /home/coppi/Projects/Termaster/server && npm test && npx tsc --noEmit
```

Esperado: **server 341+ passed | 1 skipped** (338 originais inalterados + novos de
engine), `tsc` limpo. Nenhum arquivo de teste pré-existente modificado. `web/` intocado.

## Self-Review (checklist do autor)

- **Cobertura do spec:** registry aberto ✅ (Task 1); interface Engine/EngineSession/
  AgentEvent/capabilities ✅ (Task 1-2); claudeEngine delegando ✅ (Task 2);
  terminalCommand/readHistory/latestConversationId definidos e testados ✅ (Task 2);
  coluna engine ✅ (Task 3); manager via getEngine ✅ (Task 3); trava (projeto, engine)
  ✅ (Task 3); rota engine? validada ✅ (Task 4); bootstrap ✅ (Task 4). Rewiring de
  terminal/history call-sites: explicitamente fora (SP-B) ✅.
- **Sem placeholders:** todos os passos com código completo.
- **Consistência de tipos:** `EngineSession`/`Engine`/`EngineSessionOptions`/`EngineId`/
  `DEFAULT_ENGINE_ID`/`getEngine`/`hasEngine` usados igual entre Task 1→4;
  `SessionInfo.engine` adicionado na Task 3 e lido na rota/`infoOf`.
