# Termaster MVP (Fase 1) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interface web local que cria e gerencia sessões headless do Claude Code por projeto, com chat rico, dashboard de status e notificações.

**Architecture:** Backend Node/TS (Fastify + WebSocket) faz spawn de um processo `claude -p --input-format stream-json --output-format stream-json` de vida longa por sessão, parseia os eventos JSON com parser tolerante e retransmite via WebSocket para um frontend React que renderiza chat rico e dashboard. SQLite guarda o registro de projetos e sessões; o histórico vem dos JSONL nativos de `~/.claude/projects/`.

**Tech Stack:** Node 24, TypeScript strict, Fastify 5 + @fastify/websocket, better-sqlite3, Vitest, React 18 + Vite 6, zustand, react-markdown + rehype-highlight.

**Spec:** `docs/superpowers/specs/2026-07-09-termaster-design.md`

## Fatos validados empiricamente (2026-07-09, claude v2.1.206)

Estes fatos foram testados no binário real desta máquina — o plano depende deles:

1. `claude -p --input-format stream-json --output-format stream-json --verbose` cria um **processo de vida longa**: fica vivo enquanto o stdin estiver aberto, aceita múltiplos turnos na mesma sessão (contexto preservado entre turnos) e encerra com exit 0 ao fechar o stdin.
2. Formato de entrada (uma linha JSON por mensagem no stdin):
   `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
3. Eventos observados no stdout (um JSON por linha): `system/init` (traz `session_id`, `model`, `cwd`, `permissionMode`), `system/hook_started`, `system/hook_response`, `system/thinking_tokens`, `assistant` (com content blocks `thinking`, `text`, `tool_use`), `user` (com `tool_result`), `rate_limit_event`, `result/success` (traz `result`, `is_error`, `total_cost_usd`, `usage`, `num_turns`). **Existem tipos não documentados** → parser precisa ser tolerante.
4. O evento `result` marca fim de turno (pronto para o próximo input).
5. `--permission-mode bypassPermissions` existe e funciona no headless.
6. `--mcp-config` SOMA aos MCP existentes (Fase 2 usará isso para o Hermes).
7. Transcripts ficam em `~/.claude/projects/<cwd-com-não-alfanuméricos-vira-hífen>/<session_id>.jsonl`.
8. O stream NÃO ecoa de volta a mensagem de texto do usuário (sem `--replay-user-messages`) — a UI adiciona a mensagem do usuário localmente; já no transcript JSONL ela aparece.

## Global Constraints

- Node >= 24 (máquina: v24.15.0); npm workspaces; **TypeScript `strict: true`** em server e web.
- Binário `claude` >= 2.1.206 no PATH.
- Servidor escuta APENAS `127.0.0.1`, porta **4832**. Web dev server Vite na 5173 com proxy de `/api` e `/ws` para 4832.
- Sessões sempre com `--permission-mode bypassPermissions` no MVP.
- Estados de sessão no código em inglês: `starting | idle | working | needs_attention | stopped | dead`. A UI traduz para PT: `iniciando | ociosa | trabalhando | aguardando você | finalizada | morta`.
- MVP **sem** `--include-partial-messages` (streaming token a token): os eventos `assistant` já chegam incrementalmente a cada mensagem/ferramenta, o que dá feedback quase em tempo real. Streaming fino é melhoria futura.
- Testes offline usam o binário falso `server/test/fake-claude.mjs` (nunca o `claude` real). Testes com o binário real são gated por `RUN_REAL=1`.
- tmux NÃO está instalado nesta máquina — irrelevante para o MVP; instalar apenas na Fase 2 (handoff).
- Commits frequentes, mensagens convencionais (`feat:`, `test:`, `chore:`), sempre terminando com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Estrutura de arquivos (mapa completo do MVP)

```
Termaster/
├── package.json                  # workspaces: server, web
├── .gitignore
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── config.ts             # porta, paths, binário claude (com overrides por env)
│   │   ├── db.ts                 # abre SQLite + schema (projects, sessions)
│   │   ├── projects.ts           # CRUD de projetos
│   │   ├── history.ts            # leitura dos transcripts JSONL nativos
│   │   ├── claude/
│   │   │   ├── events.ts         # tipos ClaudeEvent
│   │   │   ├── parser.ts         # parser tolerante linha-a-linha
│   │   │   ├── session.ts        # ClaudeSession: spawn, send, estados
│   │   │   └── manager.ts        # SessionManager: mapa localId→sessão, revive, persistência
│   │   ├── routes/
│   │   │   ├── projects.ts       # REST /api/projects
│   │   │   ├── sessions.ts       # REST /api/sessions + /api/projects/:id/sessions
│   │   │   └── ws.ts             # hub WebSocket /ws
│   │   ├── app.ts                # monta Fastify (rotas + ws), sem listen
│   │   └── index.ts              # bootstrap: config + db + manager + listen
│   ├── scripts/
│   │   └── capture-fixtures.mjs  # regenera fixtures com o binário real
│   └── test/
│       ├── fake-claude.mjs       # binário falso que fala o protocolo
│       ├── fixtures/
│       │   └── stream-basico.jsonl
│       ├── parser.test.ts
│       ├── db.test.ts
│       ├── projects.test.ts
│       ├── history.test.ts
│       ├── session.test.ts
│       ├── manager.test.ts
│       ├── routes-projects.test.ts
│       ├── routes-sessions.test.ts
│       └── ws.test.ts
├── web/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx               # layout: Sidebar + (Dashboard | ChatView)
│       ├── styles.css            # tema escuro único do app
│       ├── types.ts              # tipos espelhados do server (Project, SessionInfo, ChatItem)
│       ├── api.ts                # cliente REST
│       ├── ws.ts                 # cliente WebSocket com reconexão
│       ├── store.ts              # zustand: projects, sessions, chat, unread
│       ├── chat/
│       │   └── applyEvent.ts     # reducer puro evento→ChatItem[] (testável)
│       ├── notifications.ts      # Notification API + som
│       └── components/
│           ├── Sidebar.tsx
│           ├── Dashboard.tsx
│           ├── ProjectCard.tsx
│           ├── NewProjectModal.tsx
│           ├── ChatView.tsx
│           ├── ChatInput.tsx
│           ├── MessageBlock.tsx  # markdown, thinking recolhível
│           ├── ToolCallCard.tsx  # tool calls recolhíveis
│           └── DiffView.tsx      # old_string/new_string em vermelho/verde
│       └── test/
│           ├── applyEvent.test.ts
│           └── store.test.ts
└── docs/superpowers/…            # spec e este plano
```

**Interfaces entre camadas (contrato global):**

- `ClaudeEvent` (server, `claude/events.ts`) — união discriminada por `kind`: `init | assistant | user | system | result | raw | parse_error`. É o MESMO shape que trafega no WebSocket dentro de `session_event`.
- WS server→client: `{type:'sessions_snapshot', sessions: SessionInfo[]}` | `{type:'session_event', localId: string, event: ClaudeEvent}` | `{type:'session_status', localId: string, status: SessionStatus, claudeSessionId?: string}`.
- WS client→server: `{type:'send_message', localId: string, text: string}` | `{type:'mark_read', localId: string}`.
- `SessionInfo`: `{ localId: string; projectId: number; status: SessionStatus; claudeSessionId: string | null; updatedAt: string }`.
- `Project`: `{ id: number; name: string; path: string; color: string; icon: string }`.

---

### Task 1: Scaffold do monorepo + Vitest funcionando

**Files:**
- Create: `package.json`, `.gitignore`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/test/smoke.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `npm test -w server` executa Vitest; workspaces prontos para as demais tasks.

- [ ] **Step 1: Criar package.json raiz e .gitignore**

`package.json`:
```json
{
  "name": "termaster",
  "private": true,
  "workspaces": ["server", "web"],
  "scripts": {
    "test": "npm run test -w server && npm run test -w web",
    "dev": "npm run dev -w server & npm run dev -w web & wait"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.db
.claude-flow/
.swarm/
```

- [ ] **Step 2: Criar server/package.json, tsconfig e vitest config**

`server/package.json`:
```json
{
  "name": "@termaster/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^12.0.0",
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^24.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "ws": "^8.18.0"
  }
}
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 15000 },
})
```

`web/package.json` (stub mínimo para o npm workspaces não falhar; a Task 13 o substitui):
```json
{
  "name": "@termaster/web",
  "private": true,
  "scripts": { "test": "echo 'web ainda sem testes'", "dev": "echo 'web ainda sem dev server'" }
}
```

- [ ] **Step 3: Escrever teste smoke**

`server/test/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('vitest roda', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 4: Instalar e rodar**

Run: `npm install` (na raiz) e depois `npm test -w server`
Expected: `1 passed`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo com workspaces e vitest"
```

---

### Task 2: Config do servidor

**Files:**
- Create: `server/src/config.ts`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Consumes: variáveis de ambiente (opcionais).
- Produces: `loadConfig(env?): Config` com `Config = { port: number; host: string; dbPath: string; claudeBin: string; claudeConfigDir: string }`.

- [ ] **Step 1: Teste que falha**

`server/test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

describe('loadConfig', () => {
  it('usa defaults quando env vazio', () => {
    const c = loadConfig({})
    expect(c.port).toBe(4832)
    expect(c.host).toBe('127.0.0.1')
    expect(c.claudeBin).toBe('claude')
    expect(c.claudeConfigDir).toBe(join(homedir(), '.claude'))
    expect(c.dbPath.endsWith('termaster.db')).toBe(true)
  })

  it('respeita overrides por env', () => {
    const c = loadConfig({
      TERMASTER_PORT: '5000',
      TERMASTER_DB: '/tmp/x.db',
      TERMASTER_CLAUDE_BIN: '/usr/local/bin/claude',
      CLAUDE_CONFIG_DIR: '/tmp/claude-cfg',
    })
    expect(c.port).toBe(5000)
    expect(c.dbPath).toBe('/tmp/x.db')
    expect(c.claudeBin).toBe('/usr/local/bin/claude')
    expect(c.claudeConfigDir).toBe('/tmp/claude-cfg')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: Implementar**

`server/src/config.ts`:
```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  port: number
  host: string
  dbPath: string
  claudeBin: string
  claudeConfigDir: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: env.TERMASTER_PORT ? Number(env.TERMASTER_PORT) : 4832,
    host: '127.0.0.1',
    dbPath: env.TERMASTER_DB ?? join(homedir(), '.termaster', 'termaster.db'),
    claudeBin: env.TERMASTER_CLAUDE_BIN ?? 'claude',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS (3 testes no total)

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/test/config.test.ts
git commit -m "feat: config do servidor com overrides por env"
```

---

### Task 3: Camada de banco (SQLite)

**Files:**
- Create: `server/src/db.ts`
- Test: `server/test/db.test.ts`

**Interfaces:**
- Consumes: `Config.dbPath` (ou `:memory:` nos testes).
- Produces: `openDb(path: string): Db` onde `Db` é o `Database` do better-sqlite3 já com schema aplicado. Tabelas: `projects(id, name, path UNIQUE, color, icon, created_at)` e `sessions(local_id PK, claude_session_id, project_id FK, status, created_at, updated_at)`.

- [ ] **Step 1: Teste que falha**

`server/test/db.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db.js'

describe('openDb', () => {
  it('cria schema com tabelas projects e sessions', () => {
    const db = openDb(':memory:')
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('projects')
    expect(names).toContain('sessions')
  })

  it('path de projeto é único', () => {
    const db = openDb(':memory:')
    const ins = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES (?, ?, ?, ?)`)
    ins.run('A', '/tmp/a', '#fff', '📁')
    expect(() => ins.run('B', '/tmp/a', '#fff', '📁')).toThrow()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulo db não existe

- [ ] **Step 3: Implementar**

`server/src/db.ts`:
```ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#7c5cff',
  icon TEXT NOT NULL DEFAULT '📁',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  local_id TEXT PRIMARY KEY,
  claude_session_id TEXT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/db.ts server/test/db.test.ts
git commit -m "feat: camada sqlite com schema de projects e sessions"
```

---

### Task 4: Serviço de projetos (CRUD)

**Files:**
- Create: `server/src/projects.ts`
- Test: `server/test/projects.test.ts`

**Interfaces:**
- Consumes: `Db` da Task 3.
- Produces:
  - `interface Project { id: number; name: string; path: string; color: string; icon: string }`
  - `createProjectsService(db: Db)` retornando `{ list(): Project[]; get(id: number): Project | undefined; create(input: { name: string; path: string; color?: string; icon?: string }): Project; update(id: number, patch: Partial<Omit<Project,'id'>>): Project; remove(id: number): void }`
  - `create` valida que `input.path` é um diretório existente (throw `Error('diretório não existe: ...')`).

- [ ] **Step 1: Teste que falha**

`server/test/projects.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db
let dir: string

beforeEach(() => {
  db = openDb(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'termaster-'))
})

describe('projects service', () => {
  it('cria e lista projeto com defaults', () => {
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'Meu Projeto', path: dir })
    expect(p.id).toBeGreaterThan(0)
    expect(p.color).toBe('#7c5cff')
    expect(p.icon).toBe('📁')
    expect(svc.list()).toHaveLength(1)
  })

  it('rejeita path inexistente', () => {
    const svc = createProjectsService(db)
    expect(() => svc.create({ name: 'X', path: '/nao/existe/xyz' })).toThrow(/diretório não existe/)
  })

  it('atualiza nome e cor', () => {
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'A', path: dir })
    const upd = svc.update(p.id, { name: 'B', color: '#ff0000' })
    expect(upd.name).toBe('B')
    expect(upd.color).toBe('#ff0000')
  })

  it('remove projeto', () => {
    const svc = createProjectsService(db)
    const p = svc.create({ name: 'A', path: dir })
    svc.remove(p.id)
    expect(svc.list()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulo projects não existe

- [ ] **Step 3: Implementar**

`server/src/projects.ts`:
```ts
import { existsSync, statSync } from 'node:fs'
import type { Db } from './db.js'

export interface Project {
  id: number
  name: string
  path: string
  color: string
  icon: string
}

export function createProjectsService(db: Db) {
  const rowToProject = (r: any): Project => ({
    id: r.id, name: r.name, path: r.path, color: r.color, icon: r.icon,
  })

  return {
    list(): Project[] {
      return db.prepare(`SELECT * FROM projects ORDER BY name`).all().map(rowToProject)
    },
    get(id: number): Project | undefined {
      const r = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id)
      return r ? rowToProject(r) : undefined
    },
    create(input: { name: string; path: string; color?: string; icon?: string }): Project {
      if (!existsSync(input.path) || !statSync(input.path).isDirectory()) {
        throw new Error(`diretório não existe: ${input.path}`)
      }
      const info = db
        .prepare(`INSERT INTO projects (name, path, color, icon) VALUES (?, ?, ?, ?)`)
        .run(input.name, input.path, input.color ?? '#7c5cff', input.icon ?? '📁')
      return this.get(Number(info.lastInsertRowid))!
    },
    update(id: number, patch: Partial<Omit<Project, 'id'>>): Project {
      const cur = this.get(id)
      if (!cur) throw new Error(`projeto ${id} não existe`)
      const next = { ...cur, ...patch }
      db.prepare(`UPDATE projects SET name=?, path=?, color=?, icon=? WHERE id=?`)
        .run(next.name, next.path, next.color, next.icon, id)
      return next
    },
    remove(id: number): void {
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    },
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/projects.ts server/test/projects.test.ts
git commit -m "feat: crud de projetos com validação de diretório"
```

### Task 5: Tipos de eventos + parser tolerante

**Files:**
- Create: `server/src/claude/events.ts`, `server/src/claude/parser.ts`, `server/test/fixtures/stream-basico.jsonl`
- Test: `server/test/parser.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type ClaudeEvent =` união discriminada:
    ```ts
    | { kind: 'init'; sessionId: string; model: string; raw: unknown }
    | { kind: 'assistant'; message: ApiMessage; raw: unknown }
    | { kind: 'user'; message: ApiMessage; raw: unknown }
    | { kind: 'system'; subtype: string; raw: unknown }
    | { kind: 'result'; subtype: string; isError: boolean; resultText: string; costUsd: number; raw: unknown }
    | { kind: 'raw'; raw: unknown }
    | { kind: 'parse_error'; line: string }
    ```
  - `classifyLine(line: string): ClaudeEvent | null` (null para linha vazia)
  - `createLineParser(onEvent): (chunk: Buffer | string) => void` — bufferiza chunks parciais e divide por `\n`.

- [ ] **Step 1: Criar fixture com linhas REAIS capturadas do binário v2.1.206**

`server/test/fixtures/stream-basico.jsonl` (linhas reais, enxugadas; `signature` do thinking truncada):
```jsonl
{"type":"system","subtype":"init","cwd":"/tmp/exemplo","session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","model":"claude-haiku-4-5-20251001","permissionMode":"bypassPermissions","claude_code_version":"2.1.206","tools":["Bash","Read","Edit"],"uuid":"u1"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":10,"estimated_tokens_delta":10,"session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","uuid":"u2"}
{"type":"assistant","message":{"id":"msg_01","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"thinking","thinking":"O usuário pediu OK.","signature":"xxx"}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","uuid":"u3"}
{"type":"assistant","message":{"id":"msg_01","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"echo oi"}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","uuid":"u4"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"oi"}]},"parent_tool_use_id":null,"session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","uuid":"u5"}
{"type":"assistant","message":{"id":"msg_01","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"OK"}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","uuid":"u6"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","uuid":"u7"}
{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"b50b8b04-08a5-4bb8-ac60-a054cd7ae390","num_turns":1,"total_cost_usd":0.0199,"stop_reason":"end_turn","usage":{"input_tokens":500,"output_tokens":10},"uuid":"u8"}
```

- [ ] **Step 2: Teste que falha**

`server/test/parser.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { classifyLine, createLineParser } from '../src/claude/parser.js'
import type { ClaudeEvent } from '../src/claude/events.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'stream-basico.jsonl'), 'utf8')

describe('classifyLine', () => {
  it('classifica init com sessionId', () => {
    const line = FIXTURE.split('\n')[0]
    const evt = classifyLine(line)
    expect(evt).toMatchObject({ kind: 'init', sessionId: 'b50b8b04-08a5-4bb8-ac60-a054cd7ae390' })
  })

  it('classifica result com custo e texto', () => {
    const line = FIXTURE.trim().split('\n').at(-1)!
    const evt = classifyLine(line)
    expect(evt).toMatchObject({ kind: 'result', isError: false, resultText: 'OK', costUsd: 0.0199 })
  })

  it('tipo desconhecido vira raw sem quebrar', () => {
    const evt = classifyLine('{"type":"algo_novo_da_versao_9","x":1}')
    expect(evt?.kind).toBe('raw')
  })

  it('linha inválida vira parse_error', () => {
    expect(classifyLine('isto não é json')?.kind).toBe('parse_error')
  })

  it('linha vazia retorna null', () => {
    expect(classifyLine('  ')).toBeNull()
  })

  it('fixture completa: nenhuma linha quebra e todas classificam', () => {
    const events = FIXTURE.trim().split('\n').map(classifyLine)
    expect(events.every((e) => e !== null)).toBe(true)
    expect(events.some((e) => e!.kind === 'parse_error')).toBe(false)
  })
})

describe('createLineParser', () => {
  it('junta chunks parciais e divide por linha', () => {
    const got: ClaudeEvent[] = []
    const feed = createLineParser((e) => got.push(e))
    const l1 = '{"type":"result","subtype":"success","is_error":false,"result":"a","total_cost_usd":0}'
    const l2 = '{"type":"assistant","message":{"role":"assistant","content":[]}}'
    feed(l1.slice(0, 10))
    feed(l1.slice(10) + '\n' + l2 + '\n')
    expect(got.map((e) => e.kind)).toEqual(['result', 'assistant'])
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulos events/parser não existem

- [ ] **Step 4: Implementar**

`server/src/claude/events.ts`:
```ts
export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

export interface ApiMessage {
  role: string
  content: ContentBlock[] | string
  id?: string
  model?: string
}

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string; raw: unknown }
  | { kind: 'assistant'; message: ApiMessage; raw: unknown }
  | { kind: 'user'; message: ApiMessage; raw: unknown }
  | { kind: 'system'; subtype: string; raw: unknown }
  | { kind: 'result'; subtype: string; isError: boolean; resultText: string; costUsd: number; raw: unknown }
  | { kind: 'raw'; raw: unknown }
  | { kind: 'parse_error'; line: string }
```

`server/src/claude/parser.ts`:
```ts
import type { ClaudeEvent } from './events.js'

export function classifyLine(line: string): ClaudeEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { kind: 'parse_error', line: trimmed }
  }
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') {
        return { kind: 'init', sessionId: obj.session_id, model: obj.model ?? '', raw: obj }
      }
      return { kind: 'system', subtype: obj.subtype ?? 'unknown', raw: obj }
    case 'assistant':
      return { kind: 'assistant', message: obj.message, raw: obj }
    case 'user':
      return { kind: 'user', message: obj.message, raw: obj }
    case 'result':
      return {
        kind: 'result',
        subtype: obj.subtype ?? 'unknown',
        isError: Boolean(obj.is_error),
        resultText: typeof obj.result === 'string' ? obj.result : '',
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
        raw: obj,
      }
    default:
      return { kind: 'raw', raw: obj }
  }
}

export function createLineParser(onEvent: (e: ClaudeEvent) => void) {
  let buffer = ''
  return (chunk: Buffer | string) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const evt = classifyLine(line)
      if (evt) onEvent(evt)
    }
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/claude server/test/parser.test.ts server/test/fixtures
git commit -m "feat: parser tolerante do protocolo stream-json com fixtures reais"
```

---

### Task 6: Script de captura de fixtures (binário real)

**Files:**
- Create: `server/scripts/capture-fixtures.mjs`
- Test: manual/gated (usa o `claude` real — custa tokens)

**Interfaces:**
- Consumes: binário `claude` no PATH.
- Produces: regenera `server/test/fixtures/stream-basico.jsonl` a partir do binário real quando o formato mudar em versões futuras. Não roda no CI/teste normal.

- [ ] **Step 1: Escrever o script**

`server/scripts/capture-fixtures.mjs`:
```js
#!/usr/bin/env node
// Regenera fixtures do protocolo stream-json usando o binário claude REAL.
// Uso: node scripts/capture-fixtures.mjs   (custa alguns centavos de API)
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = mkdtempSync(join(tmpdir(), 'termaster-fixture-'))
const proc = spawn(
  'claude',
  ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
   '--verbose', '--permission-mode', 'bypassPermissions', '--model', 'haiku'],
  { cwd },
)

let out = ''
proc.stdout.on('data', (d) => { out += d })
proc.stderr.on('data', (d) => process.stderr.write(d))

proc.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Rode `echo oi` com a ferramenta Bash e depois responda exatamente: OK' }] },
}) + '\n')
proc.stdin.end()

proc.on('exit', (code) => {
  const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'stream-basico.jsonl')
  writeFileSync(dest, out)
  console.log(`exit=${code}, ${out.trim().split('\n').length} eventos gravados em ${dest}`)
})
```

- [ ] **Step 2: Executar uma vez e validar contra o parser**

Run: `node server/scripts/capture-fixtures.mjs && npm test -w server`
Expected: script imprime contagem de eventos; teste `fixture completa` continua PASS (se falhar, o formato mudou — ajustar parser ANTES de seguir).

- [ ] **Step 3: Commit**

```bash
git add server/scripts/capture-fixtures.mjs server/test/fixtures/stream-basico.jsonl
git commit -m "chore: script de captura de fixtures do protocolo real"
```

---

### Task 7: Binário falso + ClaudeSession (spawn, send, estados)

**Files:**
- Create: `server/test/fake-claude.mjs`, `server/src/claude/session.ts`
- Test: `server/test/session.test.ts`

**Interfaces:**
- Consumes: `createLineParser`/`ClaudeEvent` da Task 5.
- Produces:
  - `type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_attention' | 'stopped' | 'dead'`
  - `class ClaudeSession extends EventEmitter`:
    - `constructor(opts: { projectPath: string; resumeSessionId?: string; claudeBin?: string; extraArgs?: string[] })`
    - `start(): void` — spawna o processo
    - `send(text: string): void` — escreve mensagem no stdin; throw se status for `stopped|dead|working`
    - `markRead(): void` — `needs_attention` → `idle`
    - `stop(): Promise<void>` — fecha stdin, espera exit (SIGKILL após 10s) → `stopped`
    - `status: SessionStatus`, `sessionId?: string`
    - Emite: `'event' (ClaudeEvent)`, `'status' (SessionStatus)`, `'exit' (code)`, `'stderr' (string)`
  - Máquina de estados: `starting` →(init)→ `idle` →(send)→ `working` →(result)→ `needs_attention` →(markRead)→ `idle`; exit inesperado em qualquer estado → `dead`; `stop()` → `stopped`.

- [ ] **Step 1: Criar o binário falso**

`server/test/fake-claude.mjs`:
```js
#!/usr/bin/env node
// Fala o protocolo stream-json do claude para testes offline.
// Comportamentos por conteúdo da mensagem:
//   contém "use-tool"  -> emite tool_use + tool_result antes do texto
//   contém "crash"     -> encerra com exit 1 sem result (simula morte)
//   qualquer outro     -> responde "eco: <texto>"
import readline from 'node:readline'

const sid = process.env.FAKE_SESSION_ID ?? 'fake-session-0001'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model', cwd: process.cwd(), tools: [] })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const text = msg?.message?.content?.[0]?.text ?? ''
  if (text.includes('crash')) process.exit(1)
  if (text.includes('use-tool')) {
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake_1', name: 'Bash', input: { command: 'echo oi' } }] } })
    out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: 'oi' }] } })
  }
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: `eco: ${text}` }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: `eco: ${text}`, session_id: sid, num_turns: 1, total_cost_usd: 0 })
})
rl.on('close', () => process.exit(0))
```

- [ ] **Step 2: Teste que falha**

`server/test/session.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ClaudeSession, type SessionStatus } from '../src/claude/session.js'
import type { ClaudeEvent } from '../src/claude/events.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

function makeSession() {
  return new ClaudeSession({ projectPath: __dirname, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
}

function waitFor(s: ClaudeSession, status: SessionStatus): Promise<void> {
  return new Promise((resolve) => {
    if (s.status === status) return resolve()
    s.on('status', (st) => { if (st === status) resolve() })
  })
}

describe('ClaudeSession', () => {
  it('fluxo completo: init→idle, send→working, result→needs_attention, markRead→idle', async () => {
    const s = makeSession()
    const statuses: SessionStatus[] = []
    const events: ClaudeEvent[] = []
    s.on('status', (st) => statuses.push(st))
    s.on('event', (e) => events.push(e))
    s.start()
    await waitFor(s, 'idle')
    expect(s.sessionId).toBe('fake-session-0001')

    s.send('olá')
    expect(s.status).toBe('working')
    await waitFor(s, 'needs_attention')
    expect(events.some((e) => e.kind === 'assistant')).toBe(true)
    expect(events.some((e) => e.kind === 'result')).toBe(true)

    s.markRead()
    expect(s.status).toBe('idle')
    await s.stop()
    expect(s.status).toBe('stopped')
  })

  it('send durante working lança erro', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('a')
    expect(() => s.send('b')).toThrow(/working/)
    await s.stop()
  })

  it('morte inesperada do processo → dead', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('crash')
    await waitFor(s, 'dead')
    expect(s.status).toBe('dead')
  })

  it('stop gracioso → stopped (não dead)', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    await s.stop()
    expect(s.status).toBe('stopped')
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulo session não existe

- [ ] **Step 4: Implementar**

`server/src/claude/session.ts`:
```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createLineParser } from './parser.js'
import type { ClaudeEvent } from './events.js'

export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_attention' | 'stopped' | 'dead'

export interface SessionOptions {
  projectPath: string
  resumeSessionId?: string
  claudeBin?: string
  extraArgs?: string[]
  /** Somente testes: substitui TODOS os args (para apontar para o fake-claude). */
  extraArgsOverride?: string[]
}

const BASE_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
]

export class ClaudeSession extends EventEmitter {
  status: SessionStatus = 'starting'
  sessionId?: string
  private proc?: ChildProcessWithoutNullStreams
  private stopping = false

  constructor(private opts: SessionOptions) {
    super()
  }

  start(): void {
    let args: string[]
    if (this.opts.extraArgsOverride) {
      args = this.opts.extraArgsOverride
    } else {
      args = [...BASE_ARGS]
      if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId)
      if (this.opts.extraArgs) args.push(...this.opts.extraArgs)
    }
    this.proc = spawn(this.opts.claudeBin ?? 'claude', args, {
      cwd: this.opts.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const feed = createLineParser((evt) => this.handleEvent(evt))
    this.proc.stdout.on('data', feed)
    this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString()))
    this.proc.on('exit', (code) => {
      this.setStatus(this.stopping ? 'stopped' : 'dead')
      this.emit('exit', code)
    })
    this.proc.on('error', () => this.setStatus('dead'))
  }

  private handleEvent(evt: ClaudeEvent): void {
    if (evt.kind === 'init') {
      this.sessionId = evt.sessionId
      if (this.status === 'starting') this.setStatus('idle')
    }
    if (evt.kind === 'result') this.setStatus('needs_attention')
    this.emit('event', evt)
  }

  send(text: string): void {
    if (!this.proc || this.status === 'stopped' || this.status === 'dead' || this.status === 'working') {
      throw new Error(`sessão não aceita mensagem no status ${this.status}`)
    }
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
    this.setStatus('working')
  }

  markRead(): void {
    if (this.status === 'needs_attention') this.setStatus('idle')
  }

  async stop(): Promise<void> {
    if (!this.proc || this.status === 'stopped' || this.status === 'dead') return
    this.stopping = true
    this.proc.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.proc?.kill('SIGKILL'); resolve() }, 10_000)
      this.proc!.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  private setStatus(s: SessionStatus): void {
    if (s !== this.status) {
      this.status = s
      this.emit('status', s)
    }
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS (todos os 4 testes de sessão)

- [ ] **Step 6: Commit**

```bash
git add server/test/fake-claude.mjs server/src/claude/session.ts server/test/session.test.ts
git commit -m "feat: ClaudeSession com máquina de estados e binário falso para testes"
```

---

### Task 8: SessionManager (ciclo de vida + persistência + revive)

**Files:**
- Create: `server/src/claude/manager.ts`
- Test: `server/test/manager.test.ts`

**Interfaces:**
- Consumes: `ClaudeSession`/`SessionStatus` (Task 7), `Db` (Task 3), `Project` (Task 4).
- Produces:
  - `interface SessionInfo { localId: string; projectId: number; status: SessionStatus; claudeSessionId: string | null; updatedAt: string }`
  - `createSessionManager(deps: { db: Db; claudeBin?: string; sessionFactory?: (opts: SessionOptions) => ClaudeSession; broadcast: (msg: object) => void })` retornando:
    - `start(project: Project): SessionInfo` — throw se o projeto já tem sessão ativa (status ≠ stopped/dead)
    - `send(localId: string, text: string): void`
    - `markRead(localId: string): void`
    - `stop(localId: string): Promise<void>`
    - `revive(localId: string): SessionInfo` — respawna com `--resume <claude_session_id>`; só permitido se status é `dead` ou `stopped`; **atualiza claude_session_id a partir do novo evento init** (resume pode gerar id novo)
    - `list(): SessionInfo[]` — ativos em memória + persistidos no banco
    - `get(localId: string): SessionInfo | undefined`
  - Broadcast emitido a cada evento (`{type:'session_event', localId, event}`) e mudança de status (`{type:'session_status', localId, status, claudeSessionId}`), que a Task 11 conecta ao WebSocket.
  - `sessionFactory` existe para os testes injetarem sessões apontando para o fake-claude.

- [ ] **Step 1: Teste que falha**

`server/test/manager.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let db: Db
let project: Project
let broadcasts: object[]

beforeEach(() => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  project = projects.create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  broadcasts = []
})

function makeManager() {
  return createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => broadcasts.push(m) })
}

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout esperando condição')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('SessionManager', () => {
  it('start cria sessão, persiste e broadcast de status flui', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    expect(info.projectId).toBe(project.id)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    expect(mgr.get(info.localId)?.claudeSessionId).toBe('fake-session-0001')
    const row = db.prepare('SELECT * FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.claude_session_id).toBe('fake-session-0001')
    expect(broadcasts.some((b: any) => b.type === 'session_status' && b.status === 'idle')).toBe(true)
    await mgr.stop(info.localId)
  })

  it('não permite 2 sessões ativas do mesmo projeto', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    expect(() => mgr.start(project)).toThrow(/já possui sessão ativa/)
    await mgr.stop(info.localId)
  })

  it('send flui e eventos são broadcast', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'olá')
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')
    expect(broadcasts.some((b: any) => b.type === 'session_event' && b.event.kind === 'result')).toBe(true)
    await mgr.stop(info.localId)
  })

  it('revive após morte respawna com resume', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, 'crash')
    await waitUntil(() => mgr.get(info.localId)?.status === 'dead')
    const revived = mgr.revive(info.localId)
    expect(revived.localId).toBe(info.localId)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    await mgr.stop(info.localId)
  })

  it('list inclui sessões persistidas de execuções anteriores', () => {
    db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status) VALUES ('old-1','sid-old',?, 'stopped')`).run(project.id)
    const mgr = makeManager()
    expect(mgr.list().find((s) => s.localId === 'old-1')?.status).toBe('stopped')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulo manager não existe

- [ ] **Step 3: Implementar**

`server/src/claude/manager.ts`:
```ts
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import type { Project } from '../projects.js'
import { ClaudeSession, type SessionOptions, type SessionStatus } from './session.js'

export interface SessionInfo {
  localId: string
  projectId: number
  status: SessionStatus
  claudeSessionId: string | null
  updatedAt: string
}

interface Deps {
  db: Db
  claudeBin?: string
  sessionFactory?: (opts: SessionOptions) => ClaudeSession
  broadcast: (msg: object) => void
}

const ACTIVE = new Set<SessionStatus>(['starting', 'idle', 'working', 'needs_attention'])

export function createSessionManager(deps: Deps) {
  const live = new Map<string, { session: ClaudeSession; projectId: number }>()
  const factory = deps.sessionFactory ?? ((opts: SessionOptions) => new ClaudeSession({ ...opts, claudeBin: deps.claudeBin }))

  const persist = (localId: string, status: SessionStatus, claudeSessionId: string | null) => {
    deps.db.prepare(
      `UPDATE sessions SET status=?, claude_session_id=COALESCE(?, claude_session_id), updated_at=datetime('now') WHERE local_id=?`,
    ).run(status, claudeSessionId, localId)
  }

  const wire = (localId: string, projectId: number, session: ClaudeSession) => {
    live.set(localId, { session, projectId })
    session.on('status', (status: SessionStatus) => {
      persist(localId, status, session.sessionId ?? null)
      deps.broadcast({ type: 'session_status', localId, status, claudeSessionId: session.sessionId ?? null })
    })
    session.on('event', (event) => deps.broadcast({ type: 'session_event', localId, event }))
    session.start()
  }

  const infoOf = (localId: string): SessionInfo | undefined => {
    const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
    if (!row) return undefined
    const liveEntry = live.get(localId)
    return {
      localId,
      projectId: row.project_id,
      status: (liveEntry?.session.status ?? row.status) as SessionStatus,
      claudeSessionId: liveEntry?.session.sessionId ?? row.claude_session_id,
      updatedAt: row.updated_at,
    }
  }

  return {
    start(project: Project): SessionInfo {
      for (const [id, entry] of live) {
        if (entry.projectId === project.id && ACTIVE.has(entry.session.status)) {
          throw new Error(`projeto ${project.name} já possui sessão ativa (${id})`)
        }
      }
      const localId = randomUUID()
      deps.db.prepare(`INSERT INTO sessions (local_id, project_id, status) VALUES (?, ?, 'starting')`).run(localId, project.id)
      wire(localId, project.id, factory({ projectPath: project.path }))
      return infoOf(localId)!
    },

    send(localId: string, text: string): void {
      const entry = live.get(localId)
      if (!entry) throw new Error(`sessão ${localId} não está ativa`)
      entry.session.send(text)
    },

    markRead(localId: string): void {
      live.get(localId)?.session.markRead()
    },

    async stop(localId: string): Promise<void> {
      await live.get(localId)?.session.stop()
    },

    revive(localId: string): SessionInfo {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new Error(`sessão ${localId} não existe`)
      const cur = live.get(localId)
      if (cur && ACTIVE.has(cur.session.status)) throw new Error(`sessão ${localId} ainda está ativa`)
      const project = deps.db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id) as any
      if (!project) throw new Error(`projeto da sessão não existe mais`)
      wire(localId, row.project_id, factory({
        projectPath: project.path,
        resumeSessionId: row.claude_session_id ?? undefined,
      }))
      return infoOf(localId)!
    },

    list(): SessionInfo[] {
      const rows = deps.db.prepare('SELECT local_id FROM sessions ORDER BY updated_at DESC').all() as any[]
      return rows.map((r) => infoOf(r.local_id)!).filter(Boolean)
    },

    get: infoOf,

    async stopAll(): Promise<void> {
      await Promise.all([...live.values()].map((e) => e.session.stop()))
    },
  }
}

export type SessionManager = ReturnType<typeof createSessionManager>
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/claude/manager.ts server/test/manager.test.ts
git commit -m "feat: SessionManager com persistência, revive e broadcast"
```

### Task 9: Leitura de histórico (transcripts JSONL nativos)

**Files:**
- Create: `server/src/history.ts`
- Test: `server/test/history.test.ts`

**Interfaces:**
- Consumes: `classifyLine` (Task 5), `Config.claudeConfigDir` (Task 2).
- Produces:
  - `encodeCwd(path: string): string` — substitui todo caractere não-alfanumérico por `-` (formato do Claude Code).
  - `transcriptPath(claudeConfigDir: string, projectPath: string, claudeSessionId: string): string`
  - `readTranscript(claudeConfigDir: string, projectPath: string, claudeSessionId: string): ClaudeEvent[]` — retorna `[]` se o arquivo não existir; ignora linhas `parse_error`.

- [ ] **Step 1: Teste que falha**

`server/test/history.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { encodeCwd, transcriptPath, readTranscript } from '../src/history.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('encodeCwd', () => {
  it('replica o formato do Claude Code', () => {
    expect(encodeCwd('/home/coppi/Projects/Termaster')).toBe('-home-coppi-Projects-Termaster')
    expect(encodeCwd('/tmp/a_b.c')).toBe('-tmp-a-b-c')
  })
})

describe('readTranscript', () => {
  it('lê e classifica linhas do JSONL, ignorando lixo', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'))
    const projPath = '/tmp/meu-proj'
    const dir = join(cfgDir, 'projects', encodeCwd(projPath))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sid-1.jsonl'), [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"oi"}]}}',
      'linha corrompida não-json',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"olá!"}]}}',
      '',
    ].join('\n'))
    const events = readTranscript(cfgDir, projPath, 'sid-1')
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant'])
  })

  it('arquivo inexistente retorna []', () => {
    expect(readTranscript('/nao/existe', '/x', 'sid')).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulo history não existe

- [ ] **Step 3: Implementar**

`server/src/history.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyLine } from './claude/parser.js'
import type { ClaudeEvent } from './claude/events.js'

export function encodeCwd(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(claudeConfigDir: string, projectPath: string, claudeSessionId: string): string {
  return join(claudeConfigDir, 'projects', encodeCwd(projectPath), `${claudeSessionId}.jsonl`)
}

export function readTranscript(claudeConfigDir: string, projectPath: string, claudeSessionId: string): ClaudeEvent[] {
  const file = transcriptPath(claudeConfigDir, projectPath, claudeSessionId)
  if (!existsSync(file)) return []
  const events: ClaudeEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const evt = classifyLine(line)
    if (evt && evt.kind !== 'parse_error') events.push(evt)
  }
  return events
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/history.ts server/test/history.test.ts
git commit -m "feat: leitura de transcripts jsonl nativos do claude code"
```

---

### Task 10: App Fastify + rotas REST de projetos

**Files:**
- Create: `server/src/app.ts`, `server/src/routes/projects.ts`
- Test: `server/test/routes-projects.test.ts`

**Interfaces:**
- Consumes: `createProjectsService` (Task 4), `SessionManager` (Task 8), `Config` (Task 2).
- Produces:
  - `buildApp(deps: { config: Config; db: Db; manager: SessionManager }): FastifyInstance` — registra tudo, NÃO chama listen (testável com `app.inject`).
  - Rotas: `GET /api/health` → `{ok:true}`; `GET /api/projects`; `POST /api/projects` (body `{name, path, color?, icon?}`, 400 em erro de validação); `PATCH /api/projects/:id`; `DELETE /api/projects/:id`.

- [ ] **Step 1: Teste que falha**

`server/test/routes-projects.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: Awaited<ReturnType<typeof buildApp>>
let dir: string

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  dir = mkdtempSync(join(tmpdir(), 'tm-'))
})

describe('rotas de projetos', () => {
  it('health responde ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('POST cria e GET lista', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    expect(post.statusCode).toBe(201)
    expect(post.json().name).toBe('P1')
    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.json()).toHaveLength(1)
  })

  it('POST com path inválido retorna 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X', path: '/nao/existe' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/diretório não existe/)
  })

  it('PATCH atualiza e DELETE remove', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    const id = post.json().id
    const patch = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { color: '#00ff00' } })
    expect(patch.json().color).toBe('#00ff00')
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del.statusCode).toBe(204)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — módulos app/routes não existem

- [ ] **Step 3: Implementar**

`server/src/routes/projects.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { createProjectsService } from '../projects.js'
import type { Db } from '../db.js'

export function registerProjectRoutes(app: FastifyInstance, db: Db) {
  const svc = createProjectsService(db)

  app.get('/api/projects', async () => svc.list())

  app.post('/api/projects', async (req, reply) => {
    const body = req.body as { name?: string; path?: string; color?: string; icon?: string }
    if (!body?.name || !body?.path) {
      return reply.code(400).send({ error: 'name e path são obrigatórios' })
    }
    try {
      return reply.code(201).send(svc.create({ name: body.name, path: body.path, color: body.color, icon: body.icon }))
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.patch('/api/projects/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    try {
      return svc.update(id, req.body as object)
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/projects/:id', async (req, reply) => {
    svc.remove(Number((req.params as { id: string }).id))
    return reply.code(204).send()
  })
}
```

`server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { Config } from './config.js'
import type { Db } from './db.js'
import type { SessionManager } from './claude/manager.js'
import { registerProjectRoutes } from './routes/projects.js'

export interface AppDeps {
  config: Config
  db: Db
  manager: SessionManager
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  app.get('/api/health', async () => ({ ok: true }))
  registerProjectRoutes(app, deps.db)

  return app
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/routes/projects.ts server/test/routes-projects.test.ts
git commit -m "feat: app fastify com rotas rest de projetos"
```

---

### Task 11: Rotas REST de sessões + histórico

**Files:**
- Create: `server/src/routes/sessions.ts`
- Modify: `server/src/app.ts` (registrar as novas rotas)
- Test: `server/test/routes-sessions.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 8), `readTranscript` (Task 9), `createProjectsService` (Task 4).
- Produces rotas:
  - `GET /api/sessions` → `SessionInfo[]`
  - `POST /api/projects/:id/sessions` → 201 `SessionInfo` (409 se já ativa, 404 se projeto não existe)
  - `POST /api/sessions/:localId/stop` → 204
  - `POST /api/sessions/:localId/revive` → `SessionInfo` (400 se ainda ativa)
  - `GET /api/sessions/:localId/history` → `ClaudeEvent[]` (do transcript JSONL; `[]` se sem claude_session_id)

- [ ] **Step 1: Teste que falha**

`server/test/routes-sessions.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let projectId: number

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(async () => {
  db = openDb(':memory:')
  const manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  const post = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) },
  })
  projectId = post.json().id
})

describe('rotas de sessões', () => {
  it('cria sessão para projeto e lista', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    expect(res.statusCode).toBe(201)
    const { localId } = res.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })
    const list = await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(list.json().some((s: any) => s.localId === localId)).toBe(true)
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('segunda sessão do mesmo projeto → 409', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    expect(res.statusCode).toBe(409)
    await app.inject({ method: 'POST', url: `/api/sessions/${r1.json().localId}/stop` })
  })

  it('projeto inexistente → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/9999/sessions' })
    expect(res.statusCode).toBe(404)
  })

  it('history sem transcript retorna []', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const { localId } = r1.json()
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${localId}/history` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — rota não registrada (404 em vez de 201)

- [ ] **Step 3: Implementar**

`server/src/routes/sessions.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { Db } from '../db.js'
import type { Config } from '../config.js'
import { createProjectsService } from '../projects.js'
import { readTranscript } from '../history.js'

export function registerSessionRoutes(app: FastifyInstance, deps: { db: Db; manager: SessionManager; config: Config }) {
  const projects = createProjectsService(deps.db)

  app.get('/api/sessions', async () => deps.manager.list())

  app.post('/api/projects/:id/sessions', async (req, reply) => {
    const project = projects.get(Number((req.params as { id: string }).id))
    if (!project) return reply.code(404).send({ error: 'projeto não existe' })
    try {
      return reply.code(201).send(deps.manager.start(project))
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message })
    }
  })

  app.post('/api/sessions/:localId/stop', async (req, reply) => {
    await deps.manager.stop((req.params as { localId: string }).localId)
    return reply.code(204).send()
  })

  app.post('/api/sessions/:localId/revive', async (req, reply) => {
    try {
      return deps.manager.revive((req.params as { localId: string }).localId)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.get('/api/sessions/:localId/history', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    const info = deps.manager.get(localId)
    if (!info) return reply.code(404).send({ error: 'sessão não existe' })
    if (!info.claudeSessionId) return []
    const project = projects.get(info.projectId)
    if (!project) return []
    return readTranscript(deps.config.claudeConfigDir, project.path, info.claudeSessionId)
  })
}
```

Em `server/src/app.ts`, adicionar import e registro (depois de `registerProjectRoutes`):
```ts
import { registerSessionRoutes } from './routes/sessions.js'
// ... dentro de buildApp:
registerSessionRoutes(app, deps)
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/sessions.ts server/src/app.ts server/test/routes-sessions.test.ts
git commit -m "feat: rotas rest de sessões com histórico via transcript"
```

---

### Task 12: Hub WebSocket + bootstrap final do servidor

**Files:**
- Create: `server/src/routes/ws.ts`, `server/src/index.ts`
- Modify: `server/src/app.ts` (registrar ws), `server/src/claude/manager.ts` (nada — broadcast já existe)
- Test: `server/test/ws.test.ts`

**Interfaces:**
- Consumes: `SessionManager.broadcast` (o manager recebe a função `broadcast` do hub), mensagens WS do contrato global.
- Produces:
  - `createWsHub(): { register(app, deps): void; broadcast(msg: object): void }`
  - Ao conectar, cliente recebe `{type:'sessions_snapshot', sessions: manager.list()}`.
  - Mensagens do cliente: `send_message` → `manager.send`; `mark_read` → `manager.markRead`. Erros de send viram `{type:'error', localId, message}` só para o socket que pediu.
  - `server/src/index.ts` liga tudo: config → db → hub → manager(broadcast=hub.broadcast) → buildApp → listen; SIGINT/SIGTERM → `manager.stopAll()` antes de sair.

- [ ] **Step 1: Teste que falha**

`server/test/ws.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { createWsHub } from '../src/routes/ws.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let app: Awaited<ReturnType<typeof buildApp>>
let manager: SessionManager
let db: Db
let port: number

beforeEach(async () => {
  db = openDb(':memory:')
  const hub = createWsHub()
  manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: (m) => hub.broadcast(m) })
  app = await buildApp({ config: loadConfig({}), db, manager, wsHub: hub })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as { port: number }).port
})

afterEach(async () => {
  await manager.stopAll()
  await app.close()
})

function collect(ws: WebSocket): object[] {
  const msgs: object[] = []
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())))
  return msgs
}

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('websocket hub', () => {
  it('envia snapshot ao conectar e retransmite eventos de sessão', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs = collect(ws)
    await waitUntil(() => msgs.some((m: any) => m.type === 'sessions_snapshot'))

    const post = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { name: 'P1', path: mkdtempSync(join(tmpdir(), 'tm-')) },
    })
    const sess = await app.inject({ method: 'POST', url: `/api/projects/${post.json().id}/sessions` })
    const { localId } = sess.json()
    await waitUntil(() => msgs.some((m: any) => m.type === 'session_status' && m.status === 'idle'))

    ws.send(JSON.stringify({ type: 'send_message', localId, text: 'olá' }))
    await waitUntil(() => msgs.some((m: any) => m.type === 'session_event' && m.event?.kind === 'result'))
    expect(msgs.some((m: any) => m.type === 'session_event' && m.event?.kind === 'assistant')).toBe(true)
    ws.close()
  })

  it('send_message para sessão inexistente devolve erro só ao solicitante', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const msgs = collect(ws)
    await waitUntil(() => msgs.some((m: any) => m.type === 'sessions_snapshot'))
    ws.send(JSON.stringify({ type: 'send_message', localId: 'nao-existe', text: 'x' }))
    await waitUntil(() => msgs.some((m: any) => m.type === 'error'))
    ws.close()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w server`
Expected: FAIL — `createWsHub` não existe / buildApp não aceita wsHub

- [ ] **Step 3: Implementar**

`server/src/routes/ws.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { SessionManager } from '../claude/manager.js'

export function createWsHub() {
  const clients = new Set<WebSocket>()

  return {
    broadcast(msg: object): void {
      const data = JSON.stringify(msg)
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(data)
      }
    },

    register(app: FastifyInstance, deps: { manager: SessionManager }): void {
      app.get('/ws', { websocket: true }, (socket) => {
        clients.add(socket)
        socket.send(JSON.stringify({ type: 'sessions_snapshot', sessions: deps.manager.list() }))
        socket.on('close', () => clients.delete(socket))
        socket.on('message', (data) => {
          let msg: any
          try { msg = JSON.parse(data.toString()) } catch { return }
          try {
            if (msg.type === 'send_message') deps.manager.send(msg.localId, msg.text)
            else if (msg.type === 'mark_read') deps.manager.markRead(msg.localId)
          } catch (err) {
            socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: (err as Error).message }))
          }
        })
      })
    },
  }
}

export type WsHub = ReturnType<typeof createWsHub>
```

Em `server/src/app.ts`, mudar a assinatura e registrar o hub:
```ts
import type { WsHub } from './routes/ws.js'

export interface AppDeps {
  config: Config
  db: Db
  manager: SessionManager
  wsHub?: WsHub
}

// dentro de buildApp, após registerSessionRoutes:
if (deps.wsHub) deps.wsHub.register(app, { manager: deps.manager })
```

`server/src/index.ts`:
```ts
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { createSessionManager } from './claude/manager.js'
import { createWsHub } from './routes/ws.js'
import { buildApp } from './app.js'

const config = loadConfig()
const db = openDb(config.dbPath)
const wsHub = createWsHub()
const manager = createSessionManager({ db, claudeBin: config.claudeBin, broadcast: (m) => wsHub.broadcast(m) })

const app = await buildApp({ config, db, manager, wsHub })
await app.listen({ port: config.port, host: config.host })
console.log(`Termaster server em http://${config.host}:${config.port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log('encerrando sessões...')
    await manager.stopAll()
    await app.close()
    process.exit(0)
  })
}
```

- [ ] **Step 4: Rodar testes e smoke manual**

Run: `npm test -w server`
Expected: PASS

Run: `npm run dev -w server` (em background) e `curl -s http://127.0.0.1:4832/api/health`
Expected: `{"ok":true}` — depois encerrar o dev server.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ws.ts server/src/index.ts server/src/app.ts server/test/ws.test.ts
git commit -m "feat: hub websocket e bootstrap do servidor"
```

**Checkpoint: backend do MVP completo.** Daqui em diante é frontend.

### Task 13: Scaffold do frontend (Vite + React + Vitest)

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/test/smoke.test.tsx`

**Interfaces:**
- Consumes: nada.
- Produces: `npm run dev -w web` sobe Vite na 5173 com proxy `/api` e `/ws` → 4832; `npm test -w web` roda Vitest com jsdom.

- [ ] **Step 1: Criar arquivos de configuração**

`web/package.json`:
```json
{
  "name": "@termaster/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-markdown": "^9.0.0",
    "rehype-highlight": "^7.0.0",
    "remark-gfm": "^4.0.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4832',
      '/ws': { target: 'ws://127.0.0.1:4832', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/test/**/*.test.{ts,tsx}'],
  },
})
```

`web/index.html`:
```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Termaster</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

`web/src/App.tsx` (placeholder desta task; substituído na Task 15):
```tsx
export default function App() {
  return <h1>Termaster</h1>
}
```

`web/src/styles.css` (base do tema escuro; classes usadas pelas tasks seguintes):
```css
:root {
  --bg: #0f1117; --bg-panel: #171a23; --bg-hover: #1f2330;
  --border: #2a2f3e; --text: #e2e5ec; --text-dim: #8b91a3;
  --accent: #7c5cff; --ok: #3ecf8e; --warn: #f5b83d; --err: #f0565f;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; }
.app { display: flex; height: 100vh; }
.sidebar { width: 240px; background: var(--bg-panel); border-right: 1px solid var(--border); padding: 12px; overflow-y: auto; }
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.status-idle { background: var(--text-dim); }
.status-working { background: var(--accent); animation: pulse 1.2s infinite; }
.status-needs_attention { background: var(--warn); }
.status-dead { background: var(--err); }
.status-stopped { background: #555; }
.status-starting { background: var(--accent); opacity: .5; }
@keyframes pulse { 50% { opacity: .4; } }
.badge { background: var(--err); color: white; border-radius: 10px; font-size: 11px; padding: 1px 7px; }
.card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; cursor: pointer; }
.card:hover { background: var(--bg-hover); }
button { background: var(--accent); border: 0; color: white; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
button.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
input, select, textarea { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 8px; }
```

`web/src/test/smoke.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'

describe('App', () => {
  it('renderiza', () => {
    render(<App />)
    expect(screen.getByText('Termaster')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Instalar e rodar**

Run: `npm install` (raiz) e `npm test -w web`
Expected: PASS (1 teste)

- [ ] **Step 3: Smoke visual**

Run: `npm run dev -w web` e abrir http://localhost:5173
Expected: página escura com "Termaster". Encerrar depois.

- [ ] **Step 4: Commit**

```bash
git add web package.json package-lock.json
git commit -m "chore: scaffold do frontend vite+react+vitest"
```

---

### Task 14: Tipos, reducer de chat (applyEvent) e store

**Files:**
- Create: `web/src/types.ts`, `web/src/chat/applyEvent.ts`, `web/src/store.ts`, `web/src/api.ts`, `web/src/ws.ts`
- Test: `web/src/test/applyEvent.test.ts`, `web/src/test/store.test.ts`

**Interfaces:**
- Consumes: contrato WS/REST global (ver topo do plano) — eventos chegam com o shape de `ClaudeEvent` do server.
- Produces:
  - `web/src/types.ts`: `Project`, `SessionInfo`, `SessionStatus`, `ClaudeEvent` (espelhos do server), e:
    ```ts
    export type ChatItem =
      | { kind: 'user_text'; text: string }
      | { kind: 'assistant_text'; text: string }
      | { kind: 'thinking'; text: string }
      | { kind: 'tool_call'; id: string; name: string; input: unknown; result?: string; isError?: boolean }
      | { kind: 'turn_end'; costUsd: number; isError: boolean }
    ```
  - `applyEvent(items: ChatItem[], evt: ClaudeEvent): ChatItem[]` — função PURA: assistant text/thinking/tool_use viram itens; `user` com `tool_result` preenche `result` do tool_call correspondente (match por `tool_use_id`); `user` com texto vira `user_text` (acontece ao carregar histórico); `result` vira `turn_end`; `system`/`raw`/`init` são ignorados.
  - `useStore` (zustand): estado `{ projects, sessions, chat: Record<localId, ChatItem[]>, unread: Record<localId, number>, activeLocalId?: string, view: 'dashboard' | 'chat' }` e ações `applyWsMessage(msg)`, `openSession(localId)`, `openDashboard()`, `addLocalUserText(localId, text)`, `setProjects`, `setHistory(localId, events)`.
  - `api.ts`: `fetchProjects()`, `createProject(input)`, `startSession(projectId)`, `stopSession(localId)`, `reviveSession(localId)`, `fetchHistory(localId)` — todos `fetch` em `/api/...`, lançam `Error` com a mensagem do body em não-2xx.
  - `ws.ts`: `connectWs(onMessage: (msg: any) => void): { send(msg: object): void }` — reconecta a cada 2s se cair.

- [ ] **Step 1: Testes que falham (applyEvent)**

`web/src/test/applyEvent.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { applyEvent } from '../chat/applyEvent'
import type { ChatItem, ClaudeEvent } from '../types'

const assistantEvt = (content: object[]): ClaudeEvent =>
  ({ kind: 'assistant', message: { role: 'assistant', content }, raw: {} }) as ClaudeEvent

describe('applyEvent', () => {
  it('texto do assistente vira assistant_text', () => {
    const out = applyEvent([], assistantEvt([{ type: 'text', text: 'olá!' }]))
    expect(out).toEqual([{ kind: 'assistant_text', text: 'olá!' }])
  })

  it('thinking vira item thinking', () => {
    const out = applyEvent([], assistantEvt([{ type: 'thinking', thinking: 'hmm' }]))
    expect(out).toEqual([{ kind: 'thinking', text: 'hmm' }])
  })

  it('tool_use vira tool_call e tool_result preenche o resultado', () => {
    let items: ChatItem[] = []
    items = applyEvent(items, assistantEvt([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]))
    expect(items[0]).toMatchObject({ kind: 'tool_call', id: 't1', name: 'Bash' })
    items = applyEvent(items, {
      kind: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'arquivos...' }] },
      raw: {},
    } as ClaudeEvent)
    expect(items[0]).toMatchObject({ kind: 'tool_call', id: 't1', result: 'arquivos...' })
  })

  it('user com texto (histórico) vira user_text', () => {
    const out = applyEvent([], {
      kind: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'faça X' }] },
      raw: {},
    } as ClaudeEvent)
    expect(out).toEqual([{ kind: 'user_text', text: 'faça X' }])
  })

  it('result vira turn_end', () => {
    const out = applyEvent([], { kind: 'result', subtype: 'success', isError: false, resultText: 'ok', costUsd: 0.01, raw: {} } as ClaudeEvent)
    expect(out).toEqual([{ kind: 'turn_end', costUsd: 0.01, isError: false }])
  })

  it('init, system e raw são ignorados', () => {
    for (const evt of [
      { kind: 'init', sessionId: 's', model: 'm', raw: {} },
      { kind: 'system', subtype: 'thinking_tokens', raw: {} },
      { kind: 'raw', raw: {} },
    ] as ClaudeEvent[]) {
      expect(applyEvent([], evt)).toEqual([])
    }
  })
})
```

- [ ] **Step 2: Testes que falham (store)**

`web/src/test/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store'

beforeEach(() => {
  useStore.setState({ projects: [], sessions: {}, chat: {}, unread: {}, activeLocalId: undefined, view: 'dashboard' })
})

describe('store', () => {
  it('session_status atualiza sessão', () => {
    useStore.getState().applyWsMessage({ type: 'session_status', localId: 'l1', status: 'idle', claudeSessionId: 'c1' })
    expect(useStore.getState().sessions['l1']).toMatchObject({ status: 'idle', claudeSessionId: 'c1' })
  })

  it('session_event acumula chat e incrementa unread quando não é a sessão ativa', () => {
    useStore.getState().applyWsMessage({
      type: 'session_event', localId: 'l1',
      event: { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'oi' }] }, raw: {} },
    })
    expect(useStore.getState().chat['l1']).toHaveLength(1)
    expect(useStore.getState().unread['l1']).toBe(1)
  })

  it('sessão ativa não acumula unread', () => {
    useStore.getState().openSession('l1')
    useStore.getState().applyWsMessage({
      type: 'session_event', localId: 'l1',
      event: { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'oi' }] }, raw: {} },
    })
    expect(useStore.getState().unread['l1'] ?? 0).toBe(0)
  })

  it('openSession zera unread e muda view', () => {
    useStore.setState({ unread: { l1: 5 } })
    useStore.getState().openSession('l1')
    expect(useStore.getState().unread['l1']).toBe(0)
    expect(useStore.getState().view).toBe('chat')
    expect(useStore.getState().activeLocalId).toBe('l1')
  })

  it('sessions_snapshot popula sessões', () => {
    useStore.getState().applyWsMessage({
      type: 'sessions_snapshot',
      sessions: [{ localId: 'l1', projectId: 1, status: 'idle', claudeSessionId: null, updatedAt: 'x' }],
    })
    expect(Object.keys(useStore.getState().sessions)).toEqual(['l1'])
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL — módulos não existem

- [ ] **Step 4: Implementar**

`web/src/types.ts`:
```ts
export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs_attention' | 'stopped' | 'dead'

export interface Project { id: number; name: string; path: string; color: string; icon: string }

export interface SessionInfo {
  localId: string
  projectId: number
  status: SessionStatus
  claudeSessionId: string | null
  updatedAt: string
}

export interface ContentBlock {
  type: string; text?: string; thinking?: string
  id?: string; name?: string; input?: unknown
  tool_use_id?: string; content?: unknown
}

export interface ApiMessage { role: string; content: ContentBlock[] | string }

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string; raw: unknown }
  | { kind: 'assistant'; message: ApiMessage; raw: unknown }
  | { kind: 'user'; message: ApiMessage; raw: unknown }
  | { kind: 'system'; subtype: string; raw: unknown }
  | { kind: 'result'; subtype: string; isError: boolean; resultText: string; costUsd: number; raw: unknown }
  | { kind: 'raw'; raw: unknown }
  | { kind: 'parse_error'; line: string }

export type ChatItem =
  | { kind: 'user_text'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'turn_end'; costUsd: number; isError: boolean }

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'iniciando', idle: 'ociosa', working: 'trabalhando',
  needs_attention: 'aguardando você', stopped: 'finalizada', dead: 'morta',
}
```

`web/src/chat/applyEvent.ts`:
```ts
import type { ChatItem, ClaudeEvent, ContentBlock } from '../types'

function blockToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b: ContentBlock) => b.text ?? '').join('\n')
  }
  return JSON.stringify(content)
}

export function applyEvent(items: ChatItem[], evt: ClaudeEvent): ChatItem[] {
  switch (evt.kind) {
    case 'assistant': {
      const blocks = Array.isArray(evt.message.content) ? evt.message.content : []
      const added: ChatItem[] = []
      for (const b of blocks) {
        if (b.type === 'text' && b.text) added.push({ kind: 'assistant_text', text: b.text })
        else if (b.type === 'thinking' && b.thinking) added.push({ kind: 'thinking', text: b.thinking })
        else if (b.type === 'tool_use' && b.id && b.name) added.push({ kind: 'tool_call', id: b.id, name: b.name, input: b.input })
      }
      return added.length ? [...items, ...added] : items
    }
    case 'user': {
      const blocks = Array.isArray(evt.message.content) ? evt.message.content : []
      let next = items
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          next = next.map((it) =>
            it.kind === 'tool_call' && it.id === b.tool_use_id
              ? { ...it, result: blockToText(b.content) }
              : it,
          )
        } else if (b.type === 'text' && b.text) {
          next = [...next, { kind: 'user_text', text: b.text }]
        }
      }
      if (typeof evt.message.content === 'string' && evt.message.content) {
        next = [...next, { kind: 'user_text', text: evt.message.content }]
      }
      return next
    }
    case 'result':
      return [...items, { kind: 'turn_end', costUsd: evt.costUsd, isError: evt.isError }]
    default:
      return items
  }
}
```

`web/src/store.ts`:
```ts
import { create } from 'zustand'
import type { ChatItem, ClaudeEvent, Project, SessionInfo } from './types'
import { applyEvent } from './chat/applyEvent'

interface State {
  projects: Project[]
  sessions: Record<string, SessionInfo>
  chat: Record<string, ChatItem[]>
  unread: Record<string, number>
  activeLocalId?: string
  view: 'dashboard' | 'chat'
  setProjects(projects: Project[]): void
  setHistory(localId: string, events: ClaudeEvent[]): void
  addLocalUserText(localId: string, text: string): void
  applyWsMessage(msg: any): void
  openSession(localId: string): void
  openDashboard(): void
}

export const useStore = create<State>((set, get) => ({
  projects: [],
  sessions: {},
  chat: {},
  unread: {},
  activeLocalId: undefined,
  view: 'dashboard',

  setProjects: (projects) => set({ projects }),

  setHistory: (localId, events) =>
    set((s) => ({ chat: { ...s.chat, [localId]: events.reduce(applyEvent, [] as ChatItem[]) } })),

  addLocalUserText: (localId, text) =>
    set((s) => ({ chat: { ...s.chat, [localId]: [...(s.chat[localId] ?? []), { kind: 'user_text', text }] } })),

  applyWsMessage: (msg) => {
    if (msg.type === 'sessions_snapshot') {
      const sessions: Record<string, SessionInfo> = {}
      for (const info of msg.sessions as SessionInfo[]) sessions[info.localId] = info
      set({ sessions })
    } else if (msg.type === 'session_status') {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [msg.localId]: { ...(s.sessions[msg.localId] ?? { projectId: 0, updatedAt: '' }), localId: msg.localId, status: msg.status, claudeSessionId: msg.claudeSessionId ?? null },
        },
      }))
    } else if (msg.type === 'session_event') {
      const { localId, event } = msg
      set((s) => {
        const nextChat = applyEvent(s.chat[localId] ?? [], event)
        const isActive = s.activeLocalId === localId && s.view === 'chat'
        const grew = nextChat.length > (s.chat[localId] ?? []).length
        return {
          chat: { ...s.chat, [localId]: nextChat },
          unread: isActive || !grew ? s.unread : { ...s.unread, [localId]: (s.unread[localId] ?? 0) + 1 },
        }
      })
    }
  },

  openSession: (localId) =>
    set((s) => ({ activeLocalId: localId, view: 'chat', unread: { ...s.unread, [localId]: 0 } })),

  openDashboard: () => set({ view: 'dashboard', activeLocalId: undefined }),
}))
```

`web/src/api.ts`:
```ts
import type { ClaudeEvent, Project, SessionInfo } from './types'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const fetchProjects = () => req<Project[]>('/api/projects')
export const createProject = (input: { name: string; path: string; color?: string; icon?: string }) =>
  req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) })
export const startSession = (projectId: number) =>
  req<SessionInfo>(`/api/projects/${projectId}/sessions`, { method: 'POST' })
export const stopSession = (localId: string) =>
  req<void>(`/api/sessions/${localId}/stop`, { method: 'POST' })
export const reviveSession = (localId: string) =>
  req<SessionInfo>(`/api/sessions/${localId}/revive`, { method: 'POST' })
export const fetchHistory = (localId: string) =>
  req<ClaudeEvent[]>(`/api/sessions/${localId}/history`)
```

`web/src/ws.ts`:
```ts
export function connectWs(onMessage: (msg: any) => void): { send(msg: object): void } {
  let ws: WebSocket
  let queue: object[] = []

  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = (e) => onMessage(JSON.parse(e.data))
    ws.onopen = () => {
      for (const m of queue) ws.send(JSON.stringify(m))
      queue = []
    }
    ws.onclose = () => setTimeout(open, 2000)
  }
  open()

  return {
    send(msg: object) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      else queue.push(msg)
    },
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test -w web`
Expected: PASS (todos)

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: tipos, reducer de chat, store zustand e clientes api/ws"
```

---

### Task 15: Sidebar + Dashboard + criação de projetos

**Files:**
- Create: `web/src/components/Sidebar.tsx`, `web/src/components/Dashboard.tsx`, `web/src/components/ProjectCard.tsx`, `web/src/components/NewProjectModal.tsx`
- Modify: `web/src/App.tsx` (layout real + conexão WS + carga inicial)
- Test: `web/src/test/dashboard.test.tsx`

**Interfaces:**
- Consumes: `useStore`, `api.ts`, `ws.ts`, `STATUS_LABEL` (Task 14).
- Produces: navegação funcional dashboard↔chat. Novo módulo `web/src/wsContext.ts` exporta `WsContext = createContext<{ send(msg: object): void } | null>(null)` — módulo próprio para evitar import circular (`App → ChatView → App`). A Task 16 o consome para enviar mensagens.

- [ ] **Step 1: Teste que falha**

`web/src/test/dashboard.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dashboard } from '../components/Dashboard'
import { useStore } from '../store'

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'AiShiba', path: '/tmp/a', color: '#ff0000', icon: '🐕' }],
    sessions: { l1: { localId: 'l1', projectId: 1, status: 'working', claudeSessionId: 'c1', updatedAt: 'x' } },
    chat: {}, unread: { l1: 3 }, view: 'dashboard',
  })
})

describe('Dashboard', () => {
  it('mostra card com nome, ícone, status traduzido e unread', () => {
    render(<Dashboard />)
    expect(screen.getByText('AiShiba')).toBeTruthy()
    expect(screen.getByText('🐕')).toBeTruthy()
    expect(screen.getByText('trabalhando')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('projeto sem sessão mostra botão iniciar', () => {
    useStore.setState({ sessions: {}, unread: {} })
    render(<Dashboard />)
    expect(screen.getByText('Iniciar sessão')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL — componentes não existem

- [ ] **Step 3: Implementar**

`web/src/components/ProjectCard.tsx`:
```tsx
import type { Project, SessionInfo } from '../types'
import { STATUS_LABEL } from '../types'
import { startSession, reviveSession } from '../api'
import { useStore } from '../store'

export function ProjectCard({ project, session, unread }: {
  project: Project
  session?: SessionInfo
  unread: number
}) {
  const openSession = useStore((s) => s.openSession)

  const onStart = async () => {
    const info = await startSession(project.id)
    openSession(info.localId)
  }

  const canOpen = session && session.status !== 'stopped'

  return (
    <div className="card" style={{ borderLeft: `4px solid ${project.color}` }}
         onClick={() => canOpen && openSession(session.localId)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22 }}>{project.icon}</span>
        <strong style={{ flex: 1 }}>{project.name}</strong>
        {unread > 0 && <span className="badge">{unread}</span>}
      </div>
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)' }}>
        {session ? (
          <>
            <span className={`status-dot status-${session.status}`} />
            <span>{STATUS_LABEL[session.status]}</span>
            {session.status === 'dead' && (
              <button className="ghost" onClick={(e) => { e.stopPropagation(); reviveSession(session.localId) }}>
                Reviver
              </button>
            )}
          </>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); onStart() }}>Iniciar sessão</button>
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>{project.path}</div>
    </div>
  )
}
```

`web/src/components/Dashboard.tsx`:
```tsx
import { useState } from 'react'
import { useStore } from '../store'
import { ProjectCard } from './ProjectCard'
import { NewProjectModal } from './NewProjectModal'

export function Dashboard() {
  const { projects, sessions, unread } = useStore()
  const [showModal, setShowModal] = useState(false)

  const sessionOf = (projectId: number) =>
    Object.values(sessions)
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]

  return (
    <div style={{ padding: 24, overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Projetos</h2>
        <button onClick={() => setShowModal(true)}>+ Novo projeto</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {projects.map((p) => {
          const session = sessionOf(p.id)
          return <ProjectCard key={p.id} project={p} session={session} unread={session ? (unread[session.localId] ?? 0) : 0} />
        })}
      </div>
      {projects.length === 0 && <p style={{ color: 'var(--text-dim)' }}>Nenhum projeto ainda. Crie o primeiro!</p>}
      {showModal && <NewProjectModal onClose={() => setShowModal(false)} />}
    </div>
  )
}
```

`web/src/components/NewProjectModal.tsx`:
```tsx
import { useState } from 'react'
import { createProject, fetchProjects } from '../api'
import { useStore } from '../store'

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const setProjects = useStore((s) => s.setProjects)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [icon, setIcon] = useState('📁')
  const [color, setColor] = useState('#7c5cff')
  const [error, setError] = useState('')

  const submit = async () => {
    try {
      await createProject({ name, path, icon, color })
      setProjects(await fetchProjects())
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0009', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: 420, cursor: 'default' }}>
        <h3 style={{ marginTop: 0 }}>Novo projeto</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Caminho absoluto (ex.: /home/coppi/Projects/X)" value={path} onChange={(e) => setPath(e.target.value)} />
          <div style={{ display: 'flex', gap: 10 }}>
            <input style={{ width: 80 }} placeholder="Ícone" value={icon} onChange={(e) => setIcon(e.target.value)} />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
          {error && <span style={{ color: 'var(--err)' }}>{error}</span>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="ghost" onClick={onClose}>Cancelar</button>
            <button onClick={submit}>Criar</button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

`web/src/components/Sidebar.tsx`:
```tsx
import { useStore } from '../store'

export function Sidebar() {
  const { projects, sessions, unread, activeLocalId, openSession, openDashboard } = useStore()

  return (
    <div className="sidebar">
      <h3 style={{ cursor: 'pointer' }} onClick={openDashboard}>⌂ Termaster</h3>
      {Object.values(sessions)
        .filter((s) => s.status !== 'stopped')
        .map((s) => {
          const p = projects.find((p) => p.id === s.projectId)
          if (!p) return null
          const active = s.localId === activeLocalId
          return (
            <div key={s.localId} onClick={() => openSession(s.localId)}
                 style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6,
                          cursor: 'pointer', background: active ? 'var(--bg-hover)' : 'transparent' }}>
              <span className={`status-dot status-${s.status}`} />
              <span>{p.icon}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              {(unread[s.localId] ?? 0) > 0 && <span className="badge">{unread[s.localId]}</span>}
            </div>
          )
        })}
    </div>
  )
}
```

`web/src/wsContext.ts`:
```ts
import { createContext } from 'react'

export const WsContext = createContext<{ send(msg: object): void } | null>(null)
```

`web/src/App.tsx` (substitui o placeholder):
```tsx
import { useEffect, useMemo } from 'react'
import { useStore } from './store'
import { fetchProjects } from './api'
import { connectWs } from './ws'
import { WsContext } from './wsContext'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './components/Dashboard'
import { ChatView } from './components/ChatView'

export default function App() {
  const view = useStore((s) => s.view)
  const setProjects = useStore((s) => s.setProjects)

  const ws = useMemo(() => connectWs((msg) => useStore.getState().applyWsMessage(msg)), [])

  useEffect(() => {
    fetchProjects().then(setProjects)
  }, [])

  return (
    <WsContext.Provider value={ws}>
      <div className="app">
        <Sidebar />
        <div className="main">{view === 'dashboard' ? <Dashboard /> : <ChatView />}</div>
      </div>
    </WsContext.Provider>
  )
}
```

Nota: `ChatView` ainda não existe — crie um placeholder mínimo nesta task para compilar (substituído na Task 16):
```tsx
// web/src/components/ChatView.tsx (placeholder)
export function ChatView() {
  return <div style={{ padding: 24 }}>Chat…</div>
}
```
Ajuste também `web/src/test/smoke.test.tsx`: o texto `Termaster` agora aparece via Sidebar (`⌂ Termaster`) — atualizar o assert para `screen.getByText(/Termaster/)`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w web`
Expected: PASS

- [ ] **Step 5: Smoke visual com backend**

Run: `npm run dev -w server` + `npm run dev -w web`, abrir http://localhost:5173, criar um projeto de teste apontando para uma pasta vazia, ver o card, iniciar sessão, ver status mudar para "ociosa".
Expected: fluxo completo sem erros no console. Encerrar dev servers.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: sidebar, dashboard, cards de projeto e modal de criação"
```

### Task 16: ChatView com markdown, thinking e input

**Files:**
- Create: `web/src/components/MessageBlock.tsx`, `web/src/components/ChatInput.tsx`
- Modify: `web/src/components/ChatView.tsx` (substituir placeholder)
- Test: `web/src/test/message-block.test.tsx`

**Interfaces:**
- Consumes: `useStore`, `WsContext` (Task 15), `ChatItem` (Task 14), `fetchHistory`/`stopSession` (Task 14).
- Produces: `MessageBlock({ item }: { item: ChatItem })` — renderiza `user_text` (bolha à direita), `assistant_text` (markdown), `thinking` (recolhível, colapsado por padrão), `turn_end` (linha discreta com custo). `tool_call` é delegado ao `ToolCallCard` (placeholder nesta task, real na Task 17).

- [ ] **Step 1: Teste que falha**

`web/src/test/message-block.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageBlock } from '../components/MessageBlock'

describe('MessageBlock', () => {
  it('renderiza markdown do assistente (negrito vira <strong>)', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'isso é **importante**' }} />)
    expect(screen.getByText('importante').tagName).toBe('STRONG')
  })

  it('user_text renderiza como bolha do usuário', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: 'faça X' }} />)
    expect(screen.getByText('faça X')).toBeTruthy()
  })

  it('thinking começa recolhido e expande no clique', () => {
    render(<MessageBlock item={{ kind: 'thinking', text: 'raciocínio interno' }} />)
    expect(screen.queryByText('raciocínio interno')).toBeNull()
    fireEvent.click(screen.getByText(/Pensamento/))
    expect(screen.getByText('raciocínio interno')).toBeTruthy()
  })

  it('turn_end mostra custo', () => {
    render(<MessageBlock item={{ kind: 'turn_end', costUsd: 0.0123, isError: false }} />)
    expect(screen.getByText(/\$0.0123/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL — MessageBlock não existe

- [ ] **Step 3: Implementar**

`web/src/components/MessageBlock.tsx`:
```tsx
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import type { ChatItem } from '../types'
import { ToolCallCard } from './ToolCallCard'

export function MessageBlock({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user_text':
      return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 0' }}>
          <div style={{ background: 'var(--accent)', color: 'white', borderRadius: '12px 12px 2px 12px',
                        padding: '10px 14px', maxWidth: '70%', whiteSpace: 'pre-wrap' }}>
            {item.text}
          </div>
        </div>
      )
    case 'assistant_text':
      return (
        <div className="markdown" style={{ margin: '8px 0', lineHeight: 1.6 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {item.text}
          </ReactMarkdown>
        </div>
      )
    case 'thinking':
      return <Thinking text={item.text} />
    case 'tool_call':
      return <ToolCallCard item={item} />
    case 'turn_end':
      return (
        <div style={{ textAlign: 'center', color: item.isError ? 'var(--err)' : 'var(--text-dim)',
                      fontSize: 12, margin: '12px 0', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
          {item.isError ? 'turno terminou com erro' : 'turno concluído'} · ${item.costUsd.toFixed(4)}
        </div>
      )
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ margin: '8px 0' }}>
      <span onClick={() => setOpen(!open)}
            style={{ cursor: 'pointer', color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 13 }}>
        {open ? '▾' : '▸'} 💭 Pensamento
      </span>
      {open && (
        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 12, marginTop: 6,
                      color: 'var(--text-dim)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
      )}
    </div>
  )
}
```

`web/src/components/ToolCallCard.tsx` (placeholder desta task; real na Task 17):
```tsx
import type { ChatItem } from '../types'

export function ToolCallCard({ item }: { item: Extract<ChatItem, { kind: 'tool_call' }> }) {
  return <div style={{ color: 'var(--text-dim)' }}>🔧 {item.name}</div>
}
```

`web/src/components/ChatInput.tsx`:
```tsx
import { useContext, useState } from 'react'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

export function ChatInput({ localId, disabled }: { localId: string; disabled: boolean }) {
  const ws = useContext(WsContext)
  const addLocalUserText = useStore((s) => s.addLocalUserText)
  const [text, setText] = useState('')

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    ws?.send({ type: 'send_message', localId, text: trimmed })
    addLocalUserText(localId, trimmed)
    setText('')
  }

  return (
    <div style={{ display: 'flex', gap: 8, padding: 16, borderTop: '1px solid var(--border)' }}>
      <textarea
        style={{ flex: 1, resize: 'none', minHeight: 44 }}
        rows={2}
        placeholder={disabled ? 'sessão trabalhando…' : 'Mensagem para o Claude Code…'}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
        }}
      />
      <button onClick={send} disabled={disabled}>Enviar</button>
    </div>
  )
}
```

`web/src/components/ChatView.tsx` (substitui o placeholder):
```tsx
import { useContext, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { fetchHistory } from '../api'
import { MessageBlock } from './MessageBlock'
import { ChatInput } from './ChatInput'
import { STATUS_LABEL } from '../types'
import { WsContext } from '../wsContext'

export function ChatView() {
  const ws = useContext(WsContext)
  const { activeLocalId, sessions, chat, projects, setHistory } = useStore()
  const bottomRef = useRef<HTMLDivElement>(null)

  const session = activeLocalId ? sessions[activeLocalId] : undefined
  const project = session ? projects.find((p) => p.id === session.projectId) : undefined
  const items = activeLocalId ? (chat[activeLocalId] ?? []) : []

  useEffect(() => {
    if (activeLocalId && (chat[activeLocalId] ?? []).length === 0) {
      fetchHistory(activeLocalId).then((events) => setHistory(activeLocalId, events))
    }
  }, [activeLocalId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items.length])

  useEffect(() => {
    if (session?.status === 'needs_attention' && activeLocalId) {
      ws?.send({ type: 'mark_read', localId: activeLocalId })
    }
  }, [session?.status])

  if (!session || !project) return <div style={{ padding: 24 }}>Selecione uma sessão.</div>

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 20 }}>{project.icon}</span>
        <strong>{project.name}</strong>
        <span className={`status-dot status-${session.status}`} />
        <span style={{ color: 'var(--text-dim)' }}>{STATUS_LABEL[session.status]}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {items.map((item, i) => <MessageBlock key={i} item={item} />)}
        <div ref={bottomRef} />
      </div>
      <ChatInput localId={session.localId} disabled={session.status === 'working' || session.status === 'dead' || session.status === 'stopped'} />
    </>
  )
}
```

Instalar dependência do highlight (o css vem do pacote highlight.js, dependência transitiva do rehype-highlight — adicionar explícita):
Run: `npm install highlight.js -w web`

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w web`
Expected: PASS

- [ ] **Step 5: Smoke visual completo (primeira conversa real!)**

Run: dev servers up; criar projeto apontando para uma pasta de teste; iniciar sessão; enviar "crie um arquivo ola.txt com o texto 'olá termaster'".
Expected: mensagens aparecem no chat, tool calls como "🔧 Write", turno conclui com custo, arquivo criado na pasta.

- [ ] **Step 6: Commit**

```bash
git add web/src package-lock.json
git commit -m "feat: chat rico com markdown, thinking recolhível e input"
```

---

### Task 17: ToolCallCard recolhível + DiffView

**Files:**
- Create: `web/src/components/DiffView.tsx`
- Modify: `web/src/components/ToolCallCard.tsx` (substituir placeholder)
- Test: `web/src/test/toolcall.test.tsx`

**Interfaces:**
- Consumes: `ChatItem` tool_call (Task 14).
- Produces:
  - `ToolCallCard` — cabeçalho com ícone/nome/resumo de 1 linha do input, recolhido por padrão; expandido mostra input formatado + resultado. Para `Edit`/`Write`/`MultiEdit` mostra `DiffView`; para `Bash` mostra comando + output em `<pre>`.
  - `DiffView({ oldText, newText }: { oldText: string; newText: string })` — linhas removidas em vermelho (prefixo `-`), adicionadas em verde (prefixo `+`). Diff simples linha a linha (sem lib externa: linhas de `oldText` como removidas, de `newText` como adicionadas — suficiente para old_string/new_string, que já são trechos).

- [ ] **Step 1: Teste que falha**

`web/src/test/toolcall.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolCallCard } from '../components/ToolCallCard'
import { DiffView } from '../components/DiffView'

describe('ToolCallCard', () => {
  it('Bash: recolhido mostra comando resumido; expandido mostra output', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls -la' }, result: 'total 0\narquivo.txt' }} />)
    expect(screen.getByText(/ls -la/)).toBeTruthy()
    expect(screen.queryByText(/arquivo.txt/)).toBeNull()
    fireEvent.click(screen.getByText(/Bash/))
    expect(screen.getByText(/arquivo.txt/)).toBeTruthy()
  })

  it('Edit expandido mostra diff', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't2', name: 'Edit',
      input: { file_path: '/x.ts', old_string: 'const a = 1', new_string: 'const a = 2' } }} />)
    fireEvent.click(screen.getByText(/Edit/))
    expect(screen.getByText('- const a = 1')).toBeTruthy()
    expect(screen.getByText('+ const a = 2')).toBeTruthy()
  })

  it('resultado pendente mostra spinner textual', () => {
    render(<ToolCallCard item={{ kind: 'tool_call', id: 't3', name: 'Read', input: { file_path: '/y' } }} />)
    fireEvent.click(screen.getByText(/Read/))
    expect(screen.getByText(/executando/)).toBeTruthy()
  })
})

describe('DiffView', () => {
  it('marca linhas removidas e adicionadas', () => {
    render(<DiffView oldText={'a\nb'} newText={'c'} />)
    expect(screen.getByText('- a')).toBeTruthy()
    expect(screen.getByText('- b')).toBeTruthy()
    expect(screen.getByText('+ c')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL — DiffView não existe; ToolCallCard placeholder não tem comportamento

- [ ] **Step 3: Implementar**

`web/src/components/DiffView.tsx`:
```tsx
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const line = (prefix: string, text: string, color: string, bg: string, key: string) => (
    <div key={key} style={{ color, background: bg, padding: '1px 8px', whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 13 }}>
      {prefix} {text}
    </div>
  )
  return (
    <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', margin: '6px 0' }}>
      {oldText.split('\n').map((l, i) => line('-', l, '#ff8589', '#3d1418', `o${i}`))}
      {newText.split('\n').map((l, i) => line('+', l, '#7ee2a8', '#12351f', `n${i}`))}
    </div>
  )
}
```

`web/src/components/ToolCallCard.tsx` (substitui o placeholder):
```tsx
import { useState } from 'react'
import type { ChatItem } from '../types'
import { DiffView } from './DiffView'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>

const TOOL_ICON: Record<string, string> = {
  Bash: '💻', Read: '📖', Edit: '✏️', Write: '📝', MultiEdit: '✏️',
  Grep: '🔍', Glob: '🔍', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖',
}

function summarize(item: ToolCallItem): string {
  const input = (item.input ?? {}) as Record<string, unknown>
  const first = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? ''
  const s = String(first)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

export function ToolCallCard({ item }: { item: ToolCallItem }) {
  const [open, setOpen] = useState(false)
  const input = (item.input ?? {}) as Record<string, unknown>
  const isEdit = ['Edit', 'Write', 'MultiEdit'].includes(item.name)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, margin: '6px 0', background: 'var(--bg-panel)' }}>
      <div onClick={() => setOpen(!open)}
           style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>
        <span>{open ? '▾' : '▸'}</span>
        <span>{TOOL_ICON[item.name] ?? '🔧'}</span>
        <strong>{item.name}</strong>
        <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summarize(item)}
        </span>
      </div>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {item.name === 'Edit' && (
            <DiffView oldText={String(input.old_string ?? '')} newText={String(input.new_string ?? '')} />
          )}
          {item.name === 'Write' && (
            <DiffView oldText="" newText={String(input.content ?? '')} />
          )}
          {!isEdit && (
            <pre style={{ fontSize: 12, overflow: 'auto', maxHeight: 200, background: 'var(--bg)', padding: 8, borderRadius: 6 }}>
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>Resultado:</div>
          {item.result === undefined ? (
            <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>executando…</div>
          ) : (
            <pre style={{ fontSize: 12, overflow: 'auto', maxHeight: 300, background: 'var(--bg)', padding: 8, borderRadius: 6 }}>
              {item.result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat: tool calls recolhíveis com diff colorido para edits"
```

---

### Task 18: Notificações (Notification API + som + título da aba)

**Files:**
- Create: `web/src/notifications.ts`
- Modify: `web/src/App.tsx` (assinar mudanças de status), `web/src/components/Dashboard.tsx` (botão de ativar notificações)
- Test: `web/src/test/notifications.test.ts`

**Interfaces:**
- Consumes: `useStore` (Task 14).
- Produces:
  - `initNotifications(): void` — pede permissão da Notification API (idempotente).
  - `notifySessionChange(projectName: string, status: SessionStatus, prev: SessionStatus | undefined): void` — dispara notificação + beep quando status vira `needs_attention` (vindo de `working`) ou `dead`. Exportada pura o bastante para testar a REGRA de decisão separada do efeito:
  - `shouldNotify(status, prev): { notify: boolean; title?: string }` — função pura testável.

- [ ] **Step 1: Teste que falha**

`web/src/test/notifications.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { shouldNotify } from '../notifications'

describe('shouldNotify', () => {
  it('working → needs_attention notifica', () => {
    expect(shouldNotify('needs_attention', 'working').notify).toBe(true)
  })
  it('qualquer → dead notifica', () => {
    expect(shouldNotify('dead', 'working').notify).toBe(true)
    expect(shouldNotify('dead', 'idle').notify).toBe(true)
  })
  it('idle → working NÃO notifica', () => {
    expect(shouldNotify('working', 'idle').notify).toBe(false)
  })
  it('needs_attention sem prev (snapshot inicial) NÃO notifica', () => {
    expect(shouldNotify('needs_attention', undefined).notify).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -w web`
Expected: FAIL

- [ ] **Step 3: Implementar**

`web/src/notifications.ts`:
```ts
import type { SessionStatus } from './types'

export function shouldNotify(status: SessionStatus, prev: SessionStatus | undefined): { notify: boolean; title?: string } {
  if (!prev) return { notify: false }
  if (status === 'needs_attention' && prev === 'working') return { notify: true, title: 'terminou e aguarda você' }
  if (status === 'dead') return { notify: true, title: 'sessão morreu' }
  return { notify: false }
}

export function initNotifications(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

let audioCtx: AudioContext | undefined
function beep(): void {
  try {
    audioCtx ??= new AudioContext()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain); gain.connect(audioCtx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35)
    osc.start(); osc.stop(audioCtx.currentTime + 0.35)
  } catch { /* som é best-effort */ }
}

export function notifySessionChange(projectName: string, status: SessionStatus, prev: SessionStatus | undefined): void {
  const { notify, title } = shouldNotify(status, prev)
  if (!notify) return
  beep()
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`Termaster · ${projectName}`, { body: title })
  }
}
```

Em `web/src/store.ts`, dentro do handler de `session_status` em `applyWsMessage`, ANTES do `set(...)`, adicionar:
```ts
const prev = get().sessions[msg.localId]?.status
const projectId = get().sessions[msg.localId]?.projectId
const projectName = get().projects.find((p) => p.id === projectId)?.name ?? 'projeto'
notifySessionChange(projectName, msg.status, prev)
```
com o import `import { notifySessionChange } from './notifications'`.

Em `web/src/App.tsx`, no `useEffect` inicial, chamar `initNotifications()` no primeiro clique do usuário (política dos browsers):
```ts
useEffect(() => {
  const once = () => { initNotifications(); window.removeEventListener('click', once) }
  window.addEventListener('click', once)
  return () => window.removeEventListener('click', once)
}, [])
```

Título da aba com total de não-lidos (em `App.tsx`):
```ts
const totalUnread = useStore((s) => Object.values(s.unread).reduce((a, b) => a + b, 0))
useEffect(() => {
  document.title = totalUnread > 0 ? `(${totalUnread}) Termaster` : 'Termaster'
}, [totalUnread])
```

Nota de teste: `store.test.ts` roda em jsdom sem `Notification`/`AudioContext` — `notifySessionChange` deve ser resiliente (os guards `'Notification' in window` e try/catch do beep cobrem isso).

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -w web` (novos + antigos)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat: notificações de atenção com som e badge no título"
```

---

### Task 19: Teste ponta-a-ponta com o claude REAL + verificação final

**Files:**
- Create: `server/test/e2e-real.test.ts`, `docs/superpowers/verificacao-mvp.md`

**Interfaces:**
- Consumes: tudo.
- Produces: prova de que o MVP funciona com o binário real, e um checklist de verificação manual.

- [ ] **Step 1: Teste E2E gated**

`server/test/e2e-real.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Roda APENAS com RUN_REAL=1 (usa o claude real; custa tokens).
describe.runIf(process.env.RUN_REAL === '1')('e2e com claude real', () => {
  it('cria sessão, executa tarefa com ferramenta e termina o turno', async () => {
    const db = openDb(':memory:')
    const projects = createProjectsService(db)
    const dir = mkdtempSync(join(tmpdir(), 'tm-e2e-'))
    const project = projects.create({ name: 'E2E', path: dir })

    const broadcasts: any[] = []
    const mgr = createSessionManager({ db, broadcast: (m) => broadcasts.push(m) })
    const info = mgr.start(project)

    const waitUntil = async (cond: () => boolean, ms = 120_000) => {
      const start = Date.now()
      while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timeout e2e')
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    mgr.send(info.localId, "crie um arquivo chamado ola.txt com o conteúdo exato 'termaster funciona' e nada mais")
    await waitUntil(() => mgr.get(info.localId)?.status === 'needs_attention')

    expect(existsSync(join(dir, 'ola.txt'))).toBe(true)
    expect(broadcasts.some((b) => b.type === 'session_event' && b.event?.kind === 'result' && !b.event.isError)).toBe(true)
    await mgr.stop(info.localId)
  }, 180_000)
})
```

- [ ] **Step 2: Rodar o E2E real**

Run: `RUN_REAL=1 npm test -w server -- e2e-real`
Expected: PASS (cria `ola.txt` de verdade via sessão gerenciada)

- [ ] **Step 3: Checklist de verificação manual (usar a skill superpowers:verification-before-completion)**

`docs/superpowers/verificacao-mvp.md`:
```markdown
# Verificação manual do MVP — executar com os dois dev servers rodando

- [ ] Criar 2 projetos com cores/ícones diferentes → cards distintos no dashboard
- [ ] Iniciar sessão nos 2 → dois indicadores na sidebar
- [ ] Enviar tarefa real no projeto A (ex.: "liste os arquivos e resuma o projeto")
- [ ] Ver tool calls recolhíveis aparecendo durante o trabalho
- [ ] Trocar para projeto B durante o trabalho de A → badge de não-lido cresce em A
- [ ] Ao terminar A: notificação do navegador + som + título da aba com contador
- [ ] Pedir uma edição de arquivo → DiffView vermelho/verde no tool call
- [ ] Matar o processo claude de A na mão (kill) → card mostra "morta" + botão Reviver
- [ ] Reviver → sessão continua com o MESMO contexto (perguntar algo sobre a conversa anterior)
- [ ] Reiniciar o servidor termaster → sessões antigas aparecem como paradas, revive funciona
- [ ] Fechar e reabrir a aba → histórico do chat recarrega do transcript
```
Executar cada item e marcar. Qualquer falha → corrigir antes de fechar o MVP.

- [ ] **Step 4: Commit final do MVP**

```bash
git add server/test/e2e-real.test.ts docs/superpowers/verificacao-mvp.md
git commit -m "test: e2e com claude real e checklist de verificação do mvp"
```

---

## Fora deste plano (próximos planos)

- **Fase 2** — handoff tmux (instalar tmux!), servidor MCP Hermes (`perguntar_agente`, mural), botão "encaminhar para...". Pré-requisito descoberto: `--mcp-config` SOMA aos MCP existentes (validado), então o Hermes entra por aí sem tocar nas configs dos projetos.
- **Fase 3** — orquestrador central + painel de tarefas.
- Melhorias adiadas: streaming token a token (`--include-partial-messages`), toggle de permissão por sessão, seletor de modelo por sessão, polimento visual (usar skill frontend-design), suporte a subagentes visualizados (campo `parent_tool_use_id` já vem nos eventos).

## Notas de execução

- Executar as tasks EM ORDEM; cada uma termina com testes verdes + commit.
- Se `npm test` falhar em task anterior intocada, PARE e investigue (regressão).
- O fake-claude é a fonte de verdade dos testes; se o protocolo real mudar (task 6 detecta), atualizar fake + parser juntos.

