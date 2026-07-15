# Terminal PTY embutido — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rodar o Claude Code interativo num `node-pty` no backend e espelhá-lo via `xterm.js` numa aba do navegador, substituindo o handoff do `gnome-terminal`.

**Architecture:** Um `TerminalManager` mantém processos `node-pty` indexados por `localId` (com ring-buffer de scrollback e token efêmero). O `SessionManager.openInTerminal` continua dono das transições de estado (para o headless → `in_terminal` → `onExit`→`stopped`) e delega o lançamento ao `TerminalManager` via o launcher injetável já existente. Um canal WebSocket binário dedicado (`/ws/terminal/:localId`) transporta bytes ↔ teclas; o front usa `xterm.js`.

**Tech Stack:** Node + TypeScript strict (ESM, imports `.js`), Fastify 5 + `@fastify/websocket`, `node-pty`, better-sqlite3, vitest; React 18 + Vite 6 + zustand + `@xterm/xterm` + `@xterm/addon-fit`.

## Global Constraints

- **Sem caminhos hardcoded.** O binário `claude` vem de `deps.claudeBin`/`config.claudeBin` (default `'claude'`); no Windows os bins globais do npm são shims `.cmd` — não assumir extensão.
- **Terminal:** `name: 'xterm-256color'`, `env: process.env`. Bytes crus (o ConPTY cuida do resto no Windows).
- **Buffer de scrollback limitado a 256 KB** por PTY (ring-buffer).
- **`spawn`/`ptySpawn` sem shell** (argv array). O `claudeSessionId` já é validado pela regex `^[A-Za-z0-9][A-Za-z0-9_-]*$` em `openInTerminal` antes de virar argumento.
- **Bind `127.0.0.1`** (já é o caso). O `/ws/terminal/:localId` recusa `Origin` não-loopback e exige `?token=…` que confira.
- **ESM + TypeScript strict**, imports com sufixo `.js`. Testes com vitest; `fake-claude.mjs` e um fake-pty injetável para os testes (nunca importar o módulo nativo `node-pty` nos testes de unidade).
- **Encerrar → `stopped`** (sem auto-revive). Vários terminais vivos simultâneos, um por `localId`.

**Convenção de canais WS do terminal:**
- **Servidor → cliente:** mensagens de texto (string) — dados do PTY e a linha `"\r\n— sessão encerrada —\r\n"`.
- **Cliente → servidor:** teclas como mensagem **binária**; controle de resize como **texto** JSON `{ "type": "resize", "cols": N, "rows": N }`. O backend distingue pelo flag `isBinary`.

---

### Task 1: TerminalManager (node-pty registry + buffer + token)

**Files:**
- Create: `server/src/terminal/pty.ts` (interface `PtyProcess`/`PtyFactory` + `nodePtyFactory` de produção)
- Create: `server/src/terminal/manager.ts` (`createTerminalManager`)
- Test: `server/test/terminal-manager.test.ts`
- Modify: `server/package.json` (dep `node-pty`)

**Interfaces:**
- Produces:
  - `interface PtyProcess { onData(cb:(d:string)=>void):void; onExit(cb:(e:{exitCode:number})=>void):void; write(d:string):void; resize(cols:number,rows:number):void; kill():void }`
  - `type PtyFactory = (file:string, args:string[], opts:{cwd:string;cols:number;rows:number}) => PtyProcess`
  - `nodePtyFactory: PtyFactory`
  - `createTerminalManager(deps:{ptyFactory:PtyFactory})` → objeto com:
    - `open(localId:string, opts:{cwd:string;claudeBin:string;resumeSessionId:string;skipPermissions:boolean;onExit:()=>void}): string` (retorna token)
    - `attach(localId:string, socket:{send(d:string):void;readyState:number}, token:string): boolean`
    - `detach(localId:string, socket:{send(d:string):void;readyState:number}): void`
    - `write(localId:string, data:string): void`
    - `resize(localId:string, cols:number, rows:number): void`
    - `close(localId:string): void`
    - `has(localId:string): boolean`
  - `type TerminalManager = ReturnType<typeof createTerminalManager>`

- [ ] **Step 1: Adicionar a dependência `node-pty`**

Run: `npm install node-pty@^1.0.0 -w server`
Expected: `node-pty` aparece em `server/package.json` → `dependencies`. (Publica binários pré-compilados; o install normalmente não compila. Se compilar, exige `build-essential`/Python no Linux.)

- [ ] **Step 2: Criar a abstração de PTY (`pty.ts`)**

Create `server/src/terminal/pty.ts`. O `import 'node-pty'` fica isolado aqui e **não** é importado por `manager.ts` nem pelos testes.

```ts
import { spawn as ptySpawn, type IPty } from 'node-pty'

export interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number },
) => PtyProcess

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p: IPty = ptySpawn(file, args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: process.env as Record<string, string>,
  })
  return {
    onData: (cb) => { p.onData(cb) },
    onExit: (cb) => { p.onExit(({ exitCode }) => cb({ exitCode })) },
    write: (d) => p.write(d),
    resize: (cols, rows) => p.resize(cols, rows),
    kill: () => p.kill(),
  }
}
```

- [ ] **Step 3: Escrever os testes do TerminalManager (falhando)**

Create `server/test/terminal-manager.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTerminalManager } from '../src/terminal/manager.js'
import type { PtyProcess } from '../src/terminal/pty.js'

function makeFakePty() {
  let dataCb: (d: string) => void = () => {}
  let exitCb: (e: { exitCode: number }) => void = () => {}
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []
  let killed = false
  const proc: PtyProcess = {
    onData: (cb) => { dataCb = cb },
    onExit: (cb) => { exitCb = cb },
    write: (d) => { writes.push(d) },
    resize: (cols, rows) => { resizes.push({ cols, rows }) },
    kill: () => { killed = true; exitCb({ exitCode: 0 }) },
  }
  return { proc, emit: (d: string) => dataCb(d), exit: (c = 0) => exitCb({ exitCode: c }), writes, resizes, get killed() { return killed } }
}

function makeSocket() {
  const sent: string[] = []
  return { sent, readyState: 1 as number, send: (d: string) => { sent.push(d) } }
}

function setup() {
  const fakes: ReturnType<typeof makeFakePty>[] = []
  const factory = () => { const f = makeFakePty(); fakes.push(f); return f.proc }
  const tm = createTerminalManager({ ptyFactory: factory })
  return { tm, fakes }
}

const OPTS = { cwd: '/tmp', claudeBin: 'claude', resumeSessionId: 'sid-1', skipPermissions: true, onExit: () => {} }

describe('TerminalManager', () => {
  it('open cria PTY, retorna token e has() vira true', () => {
    const { tm, fakes } = setup()
    const token = tm.open('l1', OPTS)
    expect(token).toMatch(/^[a-f0-9]+$/)
    expect(tm.has('l1')).toBe(true)
    expect(fakes).toHaveLength(1)
  })

  it('attach valida token, replaya buffer e recebe dados novos', () => {
    const { tm, fakes } = setup()
    const token = tm.open('l1', OPTS)
    fakes[0].emit('linha-anterior')
    const sock = makeSocket()
    expect(tm.attach('l1', sock, token)).toBe(true)
    expect(sock.sent.join('')).toContain('linha-anterior')
    fakes[0].emit('ao-vivo')
    expect(sock.sent.join('')).toContain('ao-vivo')
  })

  it('attach com token errado é rejeitado', () => {
    const { tm } = setup()
    tm.open('l1', OPTS)
    expect(tm.attach('l1', makeSocket(), 'errado')).toBe(false)
  })

  it('write e resize chegam ao PTY', () => {
    const { tm, fakes } = setup()
    tm.open('l1', OPTS)
    tm.write('l1', 'y\r')
    tm.resize('l1', 120, 40)
    expect(fakes[0].writes).toContain('y\r')
    expect(fakes[0].resizes).toEqual([{ cols: 120, rows: 40 }])
  })

  it('buffer respeita o limite de 256 KB', () => {
    const { tm, fakes } = setup()
    tm.open('l1', OPTS)
    fakes[0].emit('x'.repeat(300 * 1024))
    const sock = makeSocket()
    tm.attach('l1', sock, tm.open('l1', OPTS)) // reusa entry vivo, token novo
    expect(sock.sent.join('').length).toBeLessThanOrEqual(256 * 1024)
  })

  it('open em localId já vivo reusa o PTY e devolve token novo', () => {
    const { tm, fakes } = setup()
    const t1 = tm.open('l1', OPTS)
    const t2 = tm.open('l1', OPTS)
    expect(fakes).toHaveLength(1)
    expect(t2).not.toBe(t1)
  })

  it('close mata o PTY e dispara onExit', () => {
    let exited = false
    const fakes: ReturnType<typeof makeFakePty>[] = []
    const tm = createTerminalManager({ ptyFactory: () => { const f = makeFakePty(); fakes.push(f); return f.proc } })
    tm.open('l1', { ...OPTS, onExit: () => { exited = true } })
    tm.close('l1')
    expect(fakes[0].killed).toBe(true)
    expect(exited).toBe(true)
    expect(tm.has('l1')).toBe(false)
  })

  it('PTY que sai sozinho avisa os clientes e dispara onExit', () => {
    let exited = false
    const fakes: ReturnType<typeof makeFakePty>[] = []
    const tm = createTerminalManager({ ptyFactory: () => { const f = makeFakePty(); fakes.push(f); return f.proc } })
    const token = tm.open('l1', { ...OPTS, onExit: () => { exited = true } })
    const sock = makeSocket()
    tm.attach('l1', sock, token)
    fakes[0].exit(0)
    expect(sock.sent.join('')).toContain('sessão encerrada')
    expect(exited).toBe(true)
    expect(tm.has('l1')).toBe(false)
  })
})
```

- [ ] **Step 4: Rodar os testes para vê-los falhar**

Run: `npm test -w server -- terminal-manager`
Expected: FAIL — `createTerminalManager` não existe.

- [ ] **Step 5: Implementar `manager.ts`**

Create `server/src/terminal/manager.ts`:

```ts
import { randomBytes } from 'node:crypto'
import type { PtyFactory, PtyProcess } from './pty.js'

const BUFFER_LIMIT = 256 * 1024

export interface OpenOpts {
  cwd: string
  claudeBin: string
  resumeSessionId: string
  skipPermissions: boolean
  onExit: () => void
}

interface Socketish {
  send(data: string): void
  readyState: number
}

interface PtyEntry {
  proc: PtyProcess
  buffer: string
  token: string
  clients: Set<Socketish>
  exited: boolean
}

export function createTerminalManager(deps: { ptyFactory: PtyFactory }) {
  const entries = new Map<string, PtyEntry>()

  const append = (entry: PtyEntry, data: string) => {
    entry.buffer += data
    if (entry.buffer.length > BUFFER_LIMIT) {
      entry.buffer = entry.buffer.slice(entry.buffer.length - BUFFER_LIMIT)
    }
  }
  const fanout = (entry: PtyEntry, data: string) => {
    for (const c of entry.clients) if (c.readyState === 1) c.send(data)
  }

  return {
    open(localId: string, opts: OpenOpts): string {
      const existing = entries.get(localId)
      if (existing && !existing.exited) {
        existing.token = randomBytes(24).toString('hex')
        return existing.token
      }
      const args = ['--resume', opts.resumeSessionId]
      if (opts.skipPermissions) args.push('--dangerously-skip-permissions')
      const proc = deps.ptyFactory(opts.claudeBin, args, { cwd: opts.cwd, cols: 80, rows: 24 })
      const entry: PtyEntry = { proc, buffer: '', token: randomBytes(24).toString('hex'), clients: new Set(), exited: false }
      entries.set(localId, entry)
      proc.onData((data) => { append(entry, data); fanout(entry, data) })
      proc.onExit(() => {
        entry.exited = true
        fanout(entry, '\r\n— sessão encerrada —\r\n')
        entries.delete(localId)
        opts.onExit()
      })
      return entry.token
    },

    attach(localId: string, socket: Socketish, token: string): boolean {
      const entry = entries.get(localId)
      if (!entry || entry.exited || entry.token !== token) return false
      entry.clients.add(socket)
      if (entry.buffer) socket.send(entry.buffer)
      return true
    },

    detach(localId: string, socket: Socketish): void {
      entries.get(localId)?.clients.delete(socket)
    },

    write(localId: string, data: string): void {
      const entry = entries.get(localId)
      if (entry && !entry.exited) entry.proc.write(data)
    },

    resize(localId: string, cols: number, rows: number): void {
      const entry = entries.get(localId)
      if (entry && !entry.exited) entry.proc.resize(cols, rows)
    },

    close(localId: string): void {
      const entry = entries.get(localId)
      if (entry && !entry.exited) entry.proc.kill()
    },

    has(localId: string): boolean {
      const e = entries.get(localId)
      return !!e && !e.exited
    },
  }
}

export type TerminalManager = ReturnType<typeof createTerminalManager>
```

- [ ] **Step 6: Rodar os testes para vê-los passar**

Run: `npm test -w server -- terminal-manager`
Expected: PASS (8 testes).

- [ ] **Step 7: Commit**

```bash
git add server/src/terminal/ server/test/terminal-manager.test.ts server/package.json server/package-lock.json
git commit -m "feat(terminal): TerminalManager com node-pty, ring-buffer e token efêmero"
```

---

### Task 2: Refatorar SessionManager para delegar ao TerminalManager

**Files:**
- Modify: `server/src/claude/manager.ts` (remover `spawn`/`defaultLauncher`/`terminalBin`; launcher retorna token; `openInTerminal` retorna `SessionInfo & { token }`)
- Test: `server/test/manager.test.ts` (atualizar `makeManagerWithLauncher` e asserções)

**Interfaces:**
- Consumes: nada de Task 1 diretamente (o wiring é na Task 4).
- Produces:
  - `interface TerminalLauncherOpts { localId:string; cwd:string; claudeBin:string; resumeSessionId:string; skipPermissions:boolean; onExit:()=>void }`
  - `deps.terminalLauncher?: (opts:TerminalLauncherOpts) => string`
  - `openInTerminal(localId:string): Promise<SessionInfo & { token:string }>`

- [ ] **Step 1: Atualizar os testes existentes de openInTerminal (falharão)**

Em `server/test/manager.test.ts`, no `describe('openInTerminal')`, ajustar `makeManagerWithLauncher` para o launcher retornar um token e o teste conferir o token:

Trocar (linhas ~299-313):
```ts
    function makeManagerWithLauncher() {
      const launches: any[] = []
      let lastOnExit: (() => void) | undefined
      const terminalLauncher = (opts: any) => {
        launches.push(opts)
        lastOnExit = opts.onExit
      }
```
por:
```ts
    function makeManagerWithLauncher() {
      const launches: any[] = []
      let lastOnExit: (() => void) | undefined
      const terminalLauncher = (opts: any) => {
        launches.push(opts)
        lastOnExit = opts.onExit
        return 'fake-token'
      }
```

E no teste "para sessão idle…" acrescentar, após `expect(result.status).toBe('in_terminal')`:
```ts
      expect(result.token).toBe('fake-token')
      expect(launches[0].localId).toBe(info.localId)
      expect(launches[0].claudeBin).toBeTruthy()
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w server -- manager`
Expected: FAIL — `result.token` é `undefined` e `launches[0].localId` é `undefined` (o launcher atual não retorna token nem recebe `localId`).

- [ ] **Step 3: Refatorar `manager.ts`**

No topo, remover a importação de `spawn` (linha 2: `import { spawn } from 'node:child_process'`).

Substituir a interface `TerminalLauncherOpts` (linhas ~16-21) por:
```ts
export interface TerminalLauncherOpts {
  localId: string
  cwd: string
  claudeBin: string
  resumeSessionId: string
  skipPermissions: boolean
  onExit: () => void
}
```

Em `interface Deps`: remover `terminalBin?: string` e trocar a linha do launcher por:
```ts
  /** Injetável: lança o Claude interativo num PTY e retorna o token do canal. Obrigatório para openInTerminal. */
  terminalLauncher?: (opts: TerminalLauncherOpts) => string
```

Remover o bloco `defaultLauncher` inteiro (linhas ~43-57) e a linha `const launchTerminal = deps.terminalLauncher ?? defaultLauncher` (linha ~58).

Atualizar o comentário do sweep de órfãos (linha ~110) de "o gnome-terminal da execução anterior" para "o PTY da execução anterior".

Em `openInTerminal`, logo após validar a regex do id (após a linha ~208), inserir a guarda:
```ts
      if (!deps.terminalLauncher) throw new Error('terminal launcher não configurado')
```

Trocar a chamada `launchTerminal({ ... })` (linhas ~229-246) por captura de token e passagem dos novos campos:
```ts
      const token = deps.terminalLauncher({
        localId,
        cwd: project.path,
        claudeBin: deps.claudeBin ?? 'claude',
        resumeSessionId: row.claude_session_id,
        skipPermissions,
        onExit: () => {
          const cur = deps.db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
          if (cur?.status === 'in_terminal') {
            persist(localId, 'stopped', null)
            deps.broadcast({
              type: 'session_status',
              localId,
              projectId: row.project_id,
              status: 'stopped',
              claudeSessionId: row.claude_session_id,
            })
          }
        },
      })

      return { ...infoOf(localId)!, token }
```
(remover o antigo `return infoOf(localId)!` que ficava no fim do método).

- [ ] **Step 4: Rodar os testes**

Run: `npm test -w server -- manager`
Expected: PASS. (Os demais testes que usam o `makeManager` base seguem passando: nenhum deles chama `openInTerminal`.)

- [ ] **Step 5: Commit**

```bash
git add server/src/claude/manager.ts server/test/manager.test.ts
git commit -m "refactor(manager): openInTerminal delega ao launcher PTY e retorna token; remove gnome"
```

---

### Task 3: Remover `terminalBin` da config

**Files:**
- Modify: `server/src/config.ts` (remover campo e env)
- Modify: `server/src/index.ts` (remover `terminalBin: config.terminalBin`)
- Test: `server/test/config.test.ts` (remover asserções de `terminalBin`)

**Interfaces:**
- Produces: `Config` sem o campo `terminalBin`.

- [ ] **Step 1: Atualizar o teste de config (falhará ao compilar/rodar)**

Em `server/test/config.test.ts`, remover as três referências a `terminalBin`:
- a asserção `expect(c.terminalBin).toBe('gnome-terminal')`
- a entrada `CLAUDINEI_TERMINAL: '/usr/bin/xterm'` no env do teste
- a asserção `expect(c.terminalBin).toBe('/usr/bin/xterm')`

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w server -- config`
Expected: PASS já após remover as asserções — mas o `tsc` acusará `terminalBin` inexistente só após o Step 3. (Se preferir TDD estrito, pule para o Step 3 e rode `npx tsc -p server --noEmit`, que falhará em `index.ts`.)

- [ ] **Step 3: Remover de `config.ts` e `index.ts`**

Em `server/src/config.ts`: remover a linha `terminalBin: string` da interface e a linha `terminalBin: env.CLAUDINEI_TERMINAL ?? 'gnome-terminal',` do objeto retornado.

Em `server/src/index.ts`: remover a linha `terminalBin: config.terminalBin,` do objeto passado a `createSessionManager` (será substituída pelo launcher na Task 4).

- [ ] **Step 4: Verificar tipos e testes**

Run: `npx tsc -p server --noEmit && npm test -w server -- config`
Expected: `tsc` limpo; testes de config PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/index.ts server/test/config.test.ts
git commit -m "chore(config): remove terminalBin (gnome-terminal aposentado)"
```

---

### Task 4: Instanciar e ligar o TerminalManager no app

**Files:**
- Modify: `server/src/index.ts` (instanciar `createTerminalManager` com `nodePtyFactory`; injetar o launcher no `SessionManager`; passar `terminalManager` ao `buildApp`)
- Modify: `server/src/app.ts` (`AppDeps` ganha `terminalManager`; registrar rotas de terminal — o registro real vem na Task 5, aqui só o encanamento de tipos/deps)

**Interfaces:**
- Consumes: `createTerminalManager`, `nodePtyFactory` (Task 1); `TerminalLauncherOpts`, `terminalLauncher` (Task 2).
- Produces: `AppDeps` com `terminalManager: TerminalManager`.

- [ ] **Step 1: Instanciar e injetar em `index.ts`**

Em `server/src/index.ts`, após `const wsHub = createWsHub()`, adicionar:
```ts
import { createTerminalManager } from './terminal/manager.js'
import { nodePtyFactory } from './terminal/pty.js'
```
(imports no topo, junto dos demais) e no corpo:
```ts
const terminalManager = createTerminalManager({ ptyFactory: nodePtyFactory })
```
No objeto passado a `createSessionManager`, adicionar o launcher:
```ts
  terminalLauncher: (opts) => terminalManager.open(opts.localId, {
    cwd: opts.cwd,
    claudeBin: opts.claudeBin,
    resumeSessionId: opts.resumeSessionId,
    skipPermissions: opts.skipPermissions,
    onExit: opts.onExit,
  }),
```
E passar ao `buildApp`:
```ts
const app = await buildApp({ config, db, manager, wsHub, terminalManager })
```

- [ ] **Step 2: Estender `AppDeps` em `app.ts`**

Em `server/src/app.ts`, adicionar o import e o campo:
```ts
import type { TerminalManager } from './terminal/manager.js'
```
```ts
export interface AppDeps {
  config: Config
  db: Db
  manager: SessionManager
  wsHub?: WsHub
  terminalManager?: TerminalManager
}
```
(Opcional para não quebrar chamadas de teste que montam o app sem terminal. O registro das rotas de terminal entra na Task 5.)

- [ ] **Step 3: Verificar tipos e build**

Run: `npx tsc -p server --noEmit`
Expected: limpo.

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts server/src/app.ts
git commit -m "feat(app): instancia TerminalManager e injeta launcher PTY no SessionManager"
```

---

### Task 5: Rotas REST do terminal (POST/DELETE) + remover /open-terminal

**Files:**
- Create: `server/src/routes/terminal.ts` (`registerTerminalRoutes` — REST agora; o WS entra na Task 6)
- Modify: `server/src/routes/sessions.ts` (remover o handler `POST /api/sessions/:localId/open-terminal`)
- Modify: `server/src/app.ts` (chamar `registerTerminalRoutes` quando `terminalManager` presente)
- Test: `server/test/terminal-routes.test.ts`

**Interfaces:**
- Consumes: `manager.openInTerminal` → `SessionInfo & { token }` (Task 2); `terminalManager.close/has` (Task 1).
- Produces:
  - `POST /api/sessions/:localId/terminal` → `{ token: string, wsUrl: string }`
  - `DELETE /api/sessions/:localId/terminal` → 204
  - `registerTerminalRoutes(app, { manager, terminalManager })`

- [ ] **Step 1: Escrever os testes de rota (falhando)**

Create `server/test/terminal-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { registerTerminalRoutes } from '../src/routes/terminal.js'

function fakeManager() {
  const calls: string[] = []
  return {
    calls,
    async openInTerminal(localId: string) {
      calls.push(`open:${localId}`)
      if (localId === 'sem-conversa') throw new Error('esta sessão ainda não tem uma conversa para abrir no terminal')
      return { localId, projectId: 1, status: 'in_terminal', claudeSessionId: 'sid', updatedAt: '', token: 'tok-123' }
    },
  }
}
function fakeTerminal() {
  const closed: string[] = []
  return { closed, close: (id: string) => closed.push(id), has: () => true, attach: () => true, detach: () => {}, write: () => {}, resize: () => {}, open: () => 'tok' }
}

async function makeApp(mgr: any, tm: any) {
  const app = Fastify()
  await app.register(websocket)
  registerTerminalRoutes(app, { manager: mgr, terminalManager: tm })
  return app
}

let mgr: ReturnType<typeof fakeManager>
let tm: ReturnType<typeof fakeTerminal>
beforeEach(() => { mgr = fakeManager(); tm = fakeTerminal() })

describe('rotas do terminal', () => {
  it('POST abre e devolve token + wsUrl', async () => {
    const app = await makeApp(mgr, tm)
    const res = await app.inject({ method: 'POST', url: '/api/sessions/l1/terminal' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ token: 'tok-123', wsUrl: '/ws/terminal/l1' })
    await app.close()
  })

  it('POST em sessão sem conversa retorna 400', async () => {
    const app = await makeApp(mgr, tm)
    const res = await app.inject({ method: 'POST', url: '/api/sessions/sem-conversa/terminal' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/conversa/)
    await app.close()
  })

  it('DELETE encerra o terminal e retorna 204', async () => {
    const app = await makeApp(mgr, tm)
    const res = await app.inject({ method: 'DELETE', url: '/api/sessions/l1/terminal' })
    expect(res.statusCode).toBe(204)
    expect(tm.closed).toEqual(['l1'])
    await app.close()
  })
})
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w server -- terminal-routes`
Expected: FAIL — `registerTerminalRoutes` não existe.

- [ ] **Step 3: Criar `routes/terminal.ts` (só REST por enquanto)**

Create `server/src/routes/terminal.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { TerminalManager } from '../terminal/manager.js'

export interface TerminalRouteDeps {
  manager: Pick<SessionManager, 'openInTerminal'>
  terminalManager: Pick<TerminalManager, 'close' | 'attach' | 'detach' | 'write' | 'resize'>
}

export function registerTerminalRoutes(app: FastifyInstance, deps: TerminalRouteDeps): void {
  app.post('/api/sessions/:localId/terminal', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    try {
      const info = await deps.manager.openInTerminal(localId)
      return reply.send({ token: info.token, wsUrl: `/ws/terminal/${localId}` })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/sessions/:localId/terminal', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    deps.terminalManager.close(localId)
    return reply.code(204).send()
  })
}
```

- [ ] **Step 4: Registrar em `app.ts` e remover o handler antigo**

Em `server/src/app.ts`, importar e registrar (dentro de `buildApp`, após `registerFsRoutes(app)`):
```ts
import { registerTerminalRoutes } from './routes/terminal.js'
```
```ts
  if (deps.terminalManager) registerTerminalRoutes(app, { manager: deps.manager, terminalManager: deps.terminalManager })
```

Em `server/src/routes/sessions.ts`, **remover** o handler `app.post('/api/sessions/:localId/open-terminal', ...)` (linhas ~46-52).

- [ ] **Step 5: Rodar os testes**

Run: `npm test -w server -- terminal-routes && npx tsc -p server --noEmit`
Expected: PASS; tipos limpos.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/terminal.ts server/src/routes/sessions.ts server/src/app.ts server/test/terminal-routes.test.ts
git commit -m "feat(terminal): rotas POST/DELETE /api/sessions/:id/terminal; remove /open-terminal"
```

---

### Task 6: Canal WebSocket binário `/ws/terminal/:localId`

**Files:**
- Modify: `server/src/routes/terminal.ts` (adicionar `isLoopbackOrigin` + o handler `GET /ws/terminal/:localId`)
- Test: `server/test/terminal-routes.test.ts` (testes de `isLoopbackOrigin`)

**Interfaces:**
- Consumes: `terminalManager.attach/detach/write/resize` (Task 1).
- Produces: `isLoopbackOrigin(origin:string): boolean` (exportada); rota WS que valida Origin+token e conecta o socket ao PTY.

- [ ] **Step 1: Escrever os testes de `isLoopbackOrigin` (falhando)**

Adicionar em `server/test/terminal-routes.test.ts`:
```ts
import { isLoopbackOrigin } from '../src/routes/terminal.js'

describe('isLoopbackOrigin', () => {
  it('aceita origens loopback', () => {
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:4832')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:4832')).toBe(true)
  })
  it('recusa origens externas e lixo', () => {
    expect(isLoopbackOrigin('https://evil.com')).toBe(false)
    expect(isLoopbackOrigin('not-a-url')).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w server -- terminal-routes`
Expected: FAIL — `isLoopbackOrigin` não existe.

- [ ] **Step 3: Implementar em `routes/terminal.ts`**

Adicionar a função exportada (topo do arquivo, após os imports):
```ts
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}
```
(Nota: `new URL('http://[::1]:4832').hostname` retorna `'::1'`.)

Adicionar o handler WS ao final de `registerTerminalRoutes`:
```ts
  app.get('/ws/terminal/:localId', { websocket: true }, (socket, req) => {
    const { localId } = req.params as { localId: string }
    const token = (req.query as { token?: string }).token ?? ''
    const origin = req.headers.origin
    if (origin && !isLoopbackOrigin(origin)) { socket.close(1008, 'origin'); return }
    if (!deps.terminalManager.attach(localId, socket as unknown as { send(d: string): void; readyState: number }, token)) {
      socket.close(1008, 'token')
      return
    }
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        deps.terminalManager.write(localId, data.toString('utf8'))
      } else {
        try {
          const m = JSON.parse(data.toString('utf8'))
          if (m?.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
            deps.terminalManager.resize(localId, m.cols, m.rows)
          }
        } catch { /* frame de controle inválido: ignora */ }
      }
    })
    socket.on('close', () => deps.terminalManager.detach(localId, socket as unknown as { send(d: string): void; readyState: number }))
  })
```

- [ ] **Step 4: Rodar os testes e tipos**

Run: `npm test -w server -- terminal-routes && npx tsc -p server --noEmit`
Expected: PASS; tipos limpos. (O round-trip WS real fica no smoke manual da Task 10.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/terminal.ts server/test/terminal-routes.test.ts
git commit -m "feat(terminal): canal WS binário /ws/terminal com Origin loopback + token"
```

---

### Task 7: Frontend — dependências xterm + camada de API

**Files:**
- Modify: `web/package.json` (`@xterm/xterm`, `@xterm/addon-fit`)
- Modify: `web/src/api.ts` (`openTerminal` passa a POST `/terminal` → `{token,wsUrl}`; novo `closeTerminal` DELETE)
- Test: `web/src/test/api.test.ts` (ajustar/adicionar cobertura de `openTerminal`/`closeTerminal` se houver)

**Interfaces:**
- Produces:
  - `openTerminal(localId:string): Promise<{ token:string; wsUrl:string }>`
  - `closeTerminal(localId:string): Promise<void>`

- [ ] **Step 1: Instalar as dependências do xterm**

Run: `npm install @xterm/xterm@^5.5.0 @xterm/addon-fit@^0.10.0 -w web`
Expected: ambas em `web/package.json` → `dependencies`.

- [ ] **Step 2: Atualizar `web/src/api.ts`**

Substituir o `openTerminal` atual (linhas ~30-31) por:
```ts
export const openTerminal = (localId: string) =>
  req<{ token: string; wsUrl: string }>(`/api/sessions/${localId}/terminal`, { method: 'POST' })
export const closeTerminal = (localId: string) =>
  req<void>(`/api/sessions/${localId}/terminal`, { method: 'DELETE' })
```

- [ ] **Step 3: Ajustar o teste de api (se existir cobertura de open-terminal)**

Em `web/src/test/api.test.ts`, se houver um caso citando `/open-terminal`, trocar a URL esperada para `/api/sessions/<id>/terminal` com `method: 'POST'`. Adicionar um caso mínimo:
```ts
it('openTerminal faz POST em /terminal e devolve token+wsUrl', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ token: 't', wsUrl: '/ws/terminal/a' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
  const { openTerminal } = await import('../api')
  await expect(openTerminal('a')).resolves.toEqual({ token: 't', wsUrl: '/ws/terminal/a' })
  expect(spy).toHaveBeenCalledWith('/api/sessions/a/terminal', expect.objectContaining({ method: 'POST' }))
  spy.mockRestore()
})
```
(Se `web/src/test/api.test.ts` não existir, criar com esse único caso e os imports padrão do arquivo `ws.test.ts`/`store.test.ts`: `import { describe, it, expect, vi } from 'vitest'`.)

- [ ] **Step 4: Rodar os testes**

Run: `npm test -w web -- api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/api.ts web/src/test/api.test.ts
git commit -m "feat(web): deps xterm + api openTerminal(POST /terminal) e closeTerminal(DELETE)"
```

---

### Task 8: Store — view 'terminal' + ação openTerminal

**Files:**
- Modify: `web/src/store.ts` (união `view` ganha `'terminal'`; ação `openTerminal(localId)`)
- Test: `web/src/test/store.test.ts` (caso para `openTerminal`)

**Interfaces:**
- Produces: `view: 'dashboard' | 'chat' | 'mural' | 'tasks' | 'terminal'`; `openTerminal(localId:string): void` (seta `view:'terminal'`, `activeLocalId:localId`).

- [ ] **Step 1: Escrever o teste (falhando)**

Adicionar em `web/src/test/store.test.ts`:
```ts
it('openTerminal muda view para terminal e seta activeLocalId', () => {
  useStore.getState().openTerminal('l9')
  expect(useStore.getState().view).toBe('terminal')
  expect(useStore.getState().activeLocalId).toBe('l9')
})
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w web -- store`
Expected: FAIL — `openTerminal` não existe no store.

- [ ] **Step 3: Implementar no store**

Em `web/src/store.ts`:
- Na interface `State`, trocar `view: 'dashboard' | 'chat' | 'mural' | 'tasks'` por `view: 'dashboard' | 'chat' | 'mural' | 'tasks' | 'terminal'` e adicionar à assinatura `openTerminal(localId: string): void`.
- No objeto do store, adicionar a ação (junto de `openSession`):
```ts
  openTerminal: (localId) => set({ view: 'terminal', activeLocalId: localId }),
```

- [ ] **Step 4: Rodar os testes**

Run: `npm test -w web -- store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/store.ts web/src/test/store.test.ts
git commit -m "feat(web): store ganha view 'terminal' e ação openTerminal"
```

---

### Task 9: TerminalView (xterm.js) + roteamento no App

**Files:**
- Create: `web/src/components/TerminalView.tsx`
- Modify: `web/src/App.tsx` (renderizar `TerminalView` quando `view === 'terminal'`)
- Modify: `web/src/styles.css` (regras mínimas do container do terminal)

**Interfaces:**
- Consumes: `openTerminal`/`closeTerminal` da api (Task 7); `activeLocalId`, `openDashboard` do store.

- [ ] **Step 1: Criar `TerminalView.tsx`**

Create `web/src/components/TerminalView.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { openTerminal as openTerminalApi, closeTerminal as closeTerminalApi } from '../api'

export function TerminalView() {
  const localId = useStore((s) => s.activeLocalId)
  const openDashboard = useStore((s) => s.openDashboard)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!localId || !ref.current) return
    let ws: WebSocket | undefined
    let disposed = false
    const term = new Terminal({ fontFamily: 'monospace', fontSize: 13, theme: { background: '#0b1020' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    fit.fit()

    const sendResize = () => {
      fit.fit()
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    const onData = term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d))
    })
    window.addEventListener('resize', sendResize)

    ;(async () => {
      const { token, wsUrl } = await openTerminalApi(localId)
      if (disposed) return
      ws = new WebSocket(`ws://${location.host}${wsUrl}?token=${encodeURIComponent(token)}`)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => sendResize()
      ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
    })().catch((err) => term.write(`\r\n[erro ao abrir terminal: ${String(err)}]\r\n`))

    return () => {
      disposed = true
      window.removeEventListener('resize', sendResize)
      onData.dispose()
      ws?.close()
      term.dispose()
    }
  }, [localId])

  const encerrar = async () => {
    if (localId) await closeTerminalApi(localId).catch(() => {})
    openDashboard()
  }

  if (!localId) return null
  return (
    <div className="terminal-view">
      <div className="terminal-view__bar">
        <button onClick={encerrar}>Encerrar terminal</button>
      </div>
      <div className="terminal-view__screen" ref={ref} />
    </div>
  )
}
```

- [ ] **Step 2: Regras de CSS mínimas**

Adicionar ao fim de `web/src/styles.css`:
```css
.terminal-view { display: flex; flex-direction: column; height: 100%; }
.terminal-view__bar { display: flex; justify-content: flex-end; padding: 8px; }
.terminal-view__screen { flex: 1; min-height: 0; padding: 4px 8px; }
```

- [ ] **Step 3: Rotear no `App.tsx`**

Em `web/src/App.tsx`:
- importar: `import { TerminalView } from './components/TerminalView'`
- adicionar na área de views: `{view === 'terminal' && <TerminalView />}`

- [ ] **Step 4: Verificar build e tipos**

Run: `npm run build -w web`
Expected: `tsc` limpo e `vite build` OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TerminalView.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat(web): TerminalView com xterm.js + fit, canal WS binário e Encerrar terminal"
```

---

### Task 10: Gatilho no ChatView/Sidebar + smoke integrado

**Files:**
- Modify: `web/src/components/ChatView.tsx` (o botão "Abrir no terminal" chama `store.openTerminal` e troca a view)
- Modify: `web/src/components/Sidebar.tsx` (clicar numa sessão `in_terminal` abre a view de terminal)
- Test: `web/src/test/chatview.test.tsx` (ajustar o caso do "Abrir no terminal")

**Interfaces:**
- Consumes: `openTerminal` do store (Task 8).

- [ ] **Step 1: Ajustar o teste do ChatView (falhando)**

Em `web/src/test/chatview.test.tsx`, o caso "mostra 'Abrir no terminal' quando idle e chama POST /open-terminal ao clicar" passa a verificar que o clique troca a view para `'terminal'`:
```ts
it('mostra "Abrir no terminal" quando idle e ao clicar abre a view de terminal', async () => {
  useStore.setState({ sessions: { a: sess('a', { status: 'idle' }) }, activeLocalId: 'a', view: 'chat' })
  render(<ChatView />)
  fireEvent.click(await screen.findByText(/Abrir no terminal/i))
  await vi.waitFor(() => expect(useStore.getState().view).toBe('terminal'))
  expect(useStore.getState().activeLocalId).toBe('a')
})
```
(Manter os imports/utilitários já presentes no arquivo — `render`, `screen`, `fireEvent`, `vi`, `sess`, `useStore`. Remover o caso antigo que dependia de `resolveOpen`/`/open-terminal` e o mock de fetch correspondente, pois o POST agora acontece dentro do `TerminalView`, não no ChatView.)

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w web -- chatview`
Expected: FAIL — o clique ainda chama `openTerminal` da api em vez de trocar a view.

- [ ] **Step 3: Atualizar o `ChatView.tsx`**

Em `web/src/components/ChatView.tsx`:
- Remover `openTerminal` do import de `../api` (linha 3 → deixar apenas `import { fetchHistory } from '../api'`).
- Pegar a ação do store no componente: `const openTerminal = useStore((s) => s.openTerminal)`.
- Trocar o handler (linha ~54) de `await openTerminal(session.localId)` por:
```ts
      openTerminal(session.localId)
```
(sincrono; o `TerminalView` cuida do POST e da conexão ao montar).

- [ ] **Step 4: Sidebar — sessão in_terminal abre o terminal**

Em `web/src/components/Sidebar.tsx`:
- Pegar a ação: `const openTerminal = useStore((s) => s.openTerminal)` (junto do `openSession` já desestruturado no topo).
- No `onClick` do item de sessão (linha ~38), rotear por status:
```tsx
            <div key={s.localId} onClick={() => (s.status === 'in_terminal' ? openTerminal(s.localId) : openSession(s.localId))}>
```

- [ ] **Step 5: Rodar todos os testes do web e o build**

Run: `npm test -w web && npm run build -w web`
Expected: todos PASS; build OK.

- [ ] **Step 6: Smoke manual integrado (com `claude` real)**

Subir backend (`npm run dev -w server`) e vite (`npm run dev -w web`), criar/abrir uma sessão, clicar em **Abrir no terminal**, confirmar no navegador:
1. o `xterm` renderiza a TUI do Claude Code e o histórico da conversa aparece;
2. digitar um comando e ver a resposta; se surgir prompt de permissão, responder `y` funciona;
3. navegar para o Dashboard e voltar pela sidebar (sessão `in_terminal`) → o terminal reconecta e o buffer recente reaparece;
4. **Encerrar terminal** → estado volta a `stopped`; reviver reabre o chat headless com o histórico.

Registrar o resultado do smoke em `docs/DECISOES-AUTONOMAS.md` (nova entrada) se houver qualquer decisão de ajuste.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/ChatView.tsx web/src/components/Sidebar.tsx web/src/test/chatview.test.tsx
git commit -m "feat(web): Abrir no terminal e sidebar roteiam para a view de terminal PTY"
```

---

## Self-Review

**1. Spec coverage:**
- Substituir gnome → Tasks 2, 3 (remoção) + 4 (launcher PTY). ✅
- Persistir/reconectar (PTY vive independente do WS; buffer replay) → Task 1 (`attach` replaya buffer; `detach` não mata) + Task 9 (POST na montagem reconecta). ✅
- Vários por sessão → Task 1 (`Map<localId, PtyEntry>`). ✅
- Multiplataforma (sem hardcode, `xterm-256color`, `env`) → Global Constraints + Task 1 (`nodePtyFactory`). ✅
- Abordagem A (WS binário dedicado + TerminalManager) → Tasks 1, 6. ✅
- Encerrar → stopped → Task 2 (`onExit` persiste stopped) + Task 5 (DELETE→close) + Task 9 (botão). ✅
- Segurança (loopback bind, Origin, token, sem shell) → Task 6 (`isLoopbackOrigin`+token) + Task 1 (argv). ✅
- Erros (400 sem conversa; idempotente já in_terminal; WS recusa token/Origin; PTY morre sozinho; reconexão; boot normaliza órfãs) → Tasks 5, 1, 6 + normalização de boot já existente. ✅
- Testes (unit TerminalManager, rotas, isLoopbackOrigin, store, smoke) → Tasks 1, 5, 6, 8, 10. ✅
- Fora de escopo (sem iniciar novo direto no terminal; sem auto-revive; sem senha; validação Windows manual) → respeitado. ✅

**2. Placeholder scan:** nenhum "TBD/TODO"; todo passo de código traz o código completo. ✅

**3. Type consistency:**
- `TerminalLauncherOpts` (localId, cwd, claudeBin, resumeSessionId, skipPermissions, onExit) idêntico entre Task 2 (definição) e Task 4 (uso no launcher). ✅
- `openInTerminal` retorna `SessionInfo & { token }` em Task 2; consumido em Task 5 como `info.token`. ✅
- `open(localId, {cwd,claudeBin,resumeSessionId,skipPermissions,onExit})` de Task 1 casa com o adapter da Task 4. ✅
- Convenção de canais (server→texto; cliente→binário=teclas / texto=resize) idêntica entre Task 6 (backend) e Task 9 (frontend). ✅
- `openTerminal` da api retorna `{token,wsUrl}` (Task 7) e é consumido no `TerminalView` (Task 9). ✅

## Notas de risco (para o executor)

- **`node-pty` nativo:** se o `npm install` falhar por falta de toolchain, instalar `build-essential` (Linux) e reexecutar. Os testes de unidade **não** dependem do módulo nativo (usam fake-pty); só o smoke da Task 10 exercita o `nodePtyFactory` real.
- **Proxy do Vite:** a entrada existente `'/ws'` já cobre `/ws/terminal/*` por prefixo — não precisa mexer no `vite.config.ts`.
- **`socket.OPEN` do `ws`:** o TerminalManager compara `readyState === 1` (constante OPEN) para não depender de propriedade de instância.
