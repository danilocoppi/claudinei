# Controles da sessão ativa (modelo + modo de permissão) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar modelo e modo de permissão (5 modos, paridade shift+tab) de uma sessão ativa a quente via `control_request`, com um controle ao lado do Enviar.

**Architecture:** Toda sessão é lançada com `--dangerously-skip-permissions` (habilita o ciclo completo); o modo desejado ≠ bypass é aplicado por `control_request` pós-init. `ClaudeSession` ganha `setModel`/`setPermissionMode` (control_request → resolve no control_response). `manager.setSessionOptions` aplica na viva + persiste (coluna `permission_mode`). Rota PATCH; front com um pill+popover (`SessionControls`) na barra de input.

**Tech Stack:** Node + Fastify 5 + better-sqlite3, vitest; React 18 + react-i18next.

## Global Constraints

- `PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'`. Default de sessão: `'bypassPermissions'`.
- Lançamento SEMPRE com `--dangerously-skip-permissions` (a flag). `buildClaudeArgs` NÃO passa mais `--permission-mode`. O modo inicial ≠ bypass é aplicado por control pós-init.
- control_request: `{type:'control_request', request_id, request:{subtype, ...}}`; subtypes `set_model` (`{model}`) e `set_permission_mode` (`{mode}`). Sucesso = `control_response.response.subtype==='success'`; erro = `subtype!=='success'` com `.error`.
- Trocas bloqueadas em `working`/`stopped`/`dead` (backend recusa; front desabilita).
- Timeout de control: 10s default, injetável via `controlTimeoutMs` (testes usam pequeno).
- Coluna `skip_permissions` fica (morta) por compat de SQLite; a verdade passa a ser `permission_mode`.
- ESM + TS strict, imports `.js`. i18n: chaves `perm.*` e `controls.*` nas 3 línguas (o dicionário `en` é a fonte tipada; `es`/`pt-BR` são `: typeof en`).

---

### Task 1: ClaudeSession — flag de launch + hot-swap via control_request

**Files:**
- Modify: `server/src/claude/session.ts`
- Modify: `server/test/fake-claude.mjs` (responde control_request)
- Test: `server/test/session-control.test.ts` (create)

**Interfaces:**
- Produces:
  - `type PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'` (exportado)
  - `SessionOptions.permissionMode?: PermissionMode`, `SessionOptions.controlTimeoutMs?: number`
  - `ClaudeSession.setModel(model: string): Promise<void>`
  - `ClaudeSession.setPermissionMode(mode: PermissionMode): Promise<void>`
  - `buildClaudeArgs` deixa de receber `skipPermissions`; passa a receber nada de permissão (usa a flag fixa).

- [ ] **Step 1: fake-claude responde control_request**

Em `server/test/fake-claude.mjs`, dentro de `rl.on('line', ...)`, ANTES do `const text = ...`, adicionar:
```js
  if (msg?.type === 'control_request') {
    const r = msg.request ?? {}
    if (r.mode === 'timeout-test') return            // simula não-resposta (testa timeout)
    if (r.mode === 'fail-test') { out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'modo inválido' } }); return }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: r.mode ? { mode: r.mode } : {} } })
    return
  }
```

- [ ] **Step 2: Testes (falhando) — `server/test/session-control.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { ClaudeSession, buildClaudeArgs } from '../src/claude/session.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const mk = (opts = {}) => new ClaudeSession({
  projectPath: mkdtempSync(join(tmpdir(), 'tm-')),
  claudeBin: process.execPath, extraArgsOverride: [FAKE], controlTimeoutMs: 400, ...opts,
})
const waitUntil = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)) }
}
let live: ClaudeSession[] = []
afterEach(async () => { for (const s of live) await s.stop(); live = [] })
const start = (opts = {}) => { const s = mk(opts); live.push(s); s.start(); return s }

describe('buildClaudeArgs', () => {
  it('sempre usa --dangerously-skip-permissions e nunca --permission-mode', () => {
    const args = buildClaudeArgs({})
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--permission-mode')
  })
})

describe('ClaudeSession control_request', () => {
  it('setModel resolve no control_response de sucesso', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setModel('haiku')).resolves.toBeUndefined()
  })

  it('setPermissionMode resolve no sucesso', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('plan')).resolves.toBeUndefined()
  })

  it('control com error rejeita com a mensagem', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('fail-test' as any)).rejects.toThrow(/inválido/)
  })

  it('sem resposta dentro do timeout, rejeita', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('timeout-test' as any)).rejects.toThrow(/resposta/)
  })

  it('recusa control quando não está ativa (após stop)', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await s.stop()
    await expect(s.setModel('opus')).rejects.toThrow(/status/)
  })
})
```

Run: `npm test -w server -- session-control` → FAIL (setModel/setPermissionMode não existem).

- [ ] **Step 3: Implementar em `session.ts`**

No topo, exportar o tipo e ajustar `SessionOptions`:
```ts
export type PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'
```
Em `SessionOptions`: remover `skipPermissions?` (será migrado nos consumidores na Task 2) — mas para NÃO quebrar a Task 2 antes da hora, MANTER `skipPermissions?` como opcional deprecado (ignorado) e ADICIONAR:
```ts
  /** Modo de permissão desejado; aplicado por control_request pós-init se ≠ bypassPermissions. Default bypass. */
  permissionMode?: PermissionMode
  /** Timeout (ms) para o control_response. Default 10000. */
  controlTimeoutMs?: number
```

`buildClaudeArgs`: trocar a linha do permission-mode. Nova assinatura e corpo do array inicial:
```ts
export function buildClaudeArgs(opts: {
  continueLatest?: boolean
  resumeSessionId?: string
  hermes?: HermesOptions
  model?: string
}): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ]
  // ...resto igual (resume/continue/model/hermes)...
```
E em `start()`, a chamada de `buildClaudeArgs` remove `skipPermissions:` do objeto.

Na classe, adicionar estado e métodos. Campos:
```ts
  private controlSeq = 0
  private pendingControls = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
```

Em `handleEvent`, ANTES de `this.emit('event', evt)`, interceptar o control_response (ele chega como kind 'raw' com o objeto cru):
```ts
    if (evt.kind === 'raw') {
      const raw = evt.raw as any
      if (raw?.type === 'control_response') {
        const rid = raw.response?.request_id
        const pending = rid ? this.pendingControls.get(rid) : undefined
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingControls.delete(rid)
          if (raw.response?.subtype === 'success') pending.resolve()
          else pending.reject(new Error(raw.response?.error ?? 'controle falhou'))
        }
        return // não vaza como evento de chat
      }
    }
```
No bloco do `init`, após `this.setStatus('idle')`, disparar o modo inicial:
```ts
      const desired = this.opts.permissionMode
      if (desired && desired !== 'bypassPermissions') void this.setPermissionMode(desired).catch(() => {})
```

Método helper + os dois públicos:
```ts
  private sendControl(subtype: string, payload: object): Promise<void> {
    if (!this.proc || this.status === 'stopped' || this.status === 'dead' || this.status === 'working') {
      return Promise.reject(new Error(`sessão não aceita controle no status ${this.status}`))
    }
    const request_id = `ctrl-${++this.controlSeq}`
    const proc = this.proc
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(request_id)
        reject(new Error('sem resposta do Claude ao controle (timeout)'))
      }, this.opts.controlTimeoutMs ?? 10_000)
      this.pendingControls.set(request_id, { resolve, reject, timer })
      proc.stdin.write(JSON.stringify({ type: 'control_request', request_id, request: { subtype, ...payload } }) + '\n')
    })
  }

  setModel(model: string): Promise<void> { return this.sendControl('set_model', { model }) }
  setPermissionMode(mode: PermissionMode): Promise<void> { return this.sendControl('set_permission_mode', { mode }) }
```
No `close`/`stop`, limpar pendências (evita reject após morte não tratado): no handler de `'close'`, antes de `setStatus`, adicionar:
```ts
      for (const [, p] of this.pendingControls) { clearTimeout(p.timer); p.reject(new Error('sessão encerrou')) }
      this.pendingControls.clear()
```

Run: `npm test -w server -- session-control` → PASS.

- [ ] **Step 4: Suíte + tsc + commit**

Run: `npm test -w server && npx tsc -p server --noEmit`
Expected: verde (os consumidores ainda passam `skipPermissions`, que agora é ignorado por buildClaudeArgs — mas `SessionOptions` ainda o aceita; nenhum teste existente quebra porque o launch sempre usa a flag e o fake ignora args). Se algum teste asseria `--permission-mode` nos args, atualizá-lo para `--dangerously-skip-permissions` e anotar.

```bash
git add server/src/claude/session.ts server/test/fake-claude.mjs server/test/session-control.test.ts
git commit -m "feat(session): launch com --dangerously-skip-permissions + setModel/setPermissionMode via control_request"
```

---

### Task 2: manager + db — permission_mode, setSessionOptions, SessionInfo

**Files:**
- Modify: `server/src/db.ts` (coluna + backfill), `server/src/claude/manager.ts`
- Test: `server/test/manager.test.ts` (casos novos)

**Interfaces:**
- Consumes: `PermissionMode`, `setModel`/`setPermissionMode` (Task 1).
- Produces:
  - `SessionInfo` ganha `model: string | null` e `permissionMode: PermissionMode`
  - `manager.setSessionOptions(localId, opts: { model?: string; permissionMode?: PermissionMode }): Promise<SessionInfo>`
  - `start(project, { continueLatest?, permissionMode?, model? })` (troca `skipPermissions` por `permissionMode`)

- [ ] **Step 1: Migração no `db.ts`**

Após os ALTERs existentes:
```ts
  try { db.exec(`ALTER TABLE sessions ADD COLUMN permission_mode TEXT`) } catch { /* já existe */ }
  db.exec(`UPDATE sessions SET permission_mode = CASE WHEN skip_permissions = 0 THEN 'default' ELSE 'bypassPermissions' END WHERE permission_mode IS NULL`)
```

- [ ] **Step 2: Testes (falhando)** — adicionar em `server/test/manager.test.ts`:

```ts
describe('setSessionOptions (hot-swap)', () => {
  it('sessão viva: aplica no processo e persiste model + permission_mode', async () => {
    const mgr = makeManager()
    const info = mgr.start(project)
    await waitUntil(() => mgr.get(info.localId)?.status === 'idle')
    const out = await mgr.setSessionOptions(info.localId, { model: 'haiku', permissionMode: 'plan' })
    expect(out.model).toBe('haiku')
    expect(out.permissionMode).toBe('plan')
    const row = db.prepare('SELECT model, permission_mode FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.model).toBe('haiku'); expect(row.permission_mode).toBe('plan')
    await mgr.stop(info.localId)
  })

  it('sessão parada: só persiste (não lança)', async () => {
    const mgr = makeManager()
    db.prepare(`INSERT INTO sessions (local_id, project_id, status) VALUES ('s-parada', ?, 'stopped')`).run(project.id)
    const out = await mgr.setSessionOptions('s-parada', { permissionMode: 'auto' })
    expect(out.permissionMode).toBe('auto')
  })

  it('start persiste o permissionMode escolhido', async () => {
    const mgr = makeManager()
    const info = mgr.start(project, { permissionMode: 'acceptEdits' })
    const row = db.prepare('SELECT permission_mode FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.permission_mode).toBe('acceptEdits')
    await mgr.stop(info.localId)
  })
})
```
(o `makeManager`/`waitUntil`/`project` já existem no arquivo.)

Run: `npm test -w server -- manager` → FAIL.

- [ ] **Step 3: Implementar no `manager.ts`**

`SessionInfo` (interface): adicionar `model: string | null` e `permissionMode: PermissionMode` (importar `PermissionMode` de `./session.js`).

`infoOf`: ler os campos da row:
```ts
      model: row.model ?? null,
      permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
```

`start`: trocar a opção e o INSERT:
```ts
    start(project: Project, opts?: { continueLatest?: boolean; permissionMode?: PermissionMode; model?: string }): SessionInfo {
      // ...guards iguais...
      const permissionMode = opts?.permissionMode ?? 'bypassPermissions'
      const model = opts?.model || undefined
      const localId = randomUUID()
      deps.db.prepare(
        `INSERT INTO sessions (local_id, project_id, status, permission_mode, model, continue_latest) VALUES (?, ?, 'starting', ?, ?, ?)`,
      ).run(localId, project.id, permissionMode, model ?? null, opts?.continueLatest ? 1 : 0)
      wire(localId, project.id, factory({
        projectPath: project.path,
        continueLatest: opts?.continueLatest,
        permissionMode,
        model,
        hermes: deps.hermes ? { ...deps.hermes, projectId: project.id } : undefined,
      }))
      return infoOf(localId)!
    },
```

`revive`: trocar `skipPermissions: row.skip_permissions !== 0` por:
```ts
        permissionMode: (row.permission_mode ?? 'bypassPermissions') as PermissionMode,
```

`openInTerminal`: hoje deriva `skipPermissions` para o launcher do terminal. O terminal usa `--dangerously-skip-permissions` quando skip; agora TODA sessão tem a flag — então o launcher do terminal deve SEMPRE passar `--dangerously-skip-permissions`. Trocar o cálculo `const skipPermissions = row.skip_permissions !== 0` e o campo passado ao launcher: o `TerminalLauncherOpts.skipPermissions` vira sempre `true` (ou renomeie — mas para escopo mínimo, passar `skipPermissions: true` fixo e anotar). Anotar no report.

Novo método (após `revive` ou perto de `send`):
```ts
    async setSessionOptions(localId: string, opts: { model?: string; permissionMode?: PermissionMode }): Promise<SessionInfo> {
      const row = deps.db.prepare('SELECT * FROM sessions WHERE local_id=?').get(localId) as any
      if (!row) throw new Error(`sessão ${localId} não existe`)
      const entry = live.get(localId)
      if (entry) {
        if (entry.session.status === 'working') throw new Error('sessão está trabalhando; aguarde o turno terminar')
        if (opts.model) await entry.session.setModel(opts.model)
        if (opts.permissionMode) await entry.session.setPermissionMode(opts.permissionMode)
      }
      deps.db.prepare(
        `UPDATE sessions SET model = COALESCE(?, model), permission_mode = COALESCE(?, permission_mode), updated_at = datetime('now') WHERE local_id = ?`,
      ).run(opts.model ?? null, opts.permissionMode ?? null, localId)
      const info = infoOf(localId)!
      deps.broadcast({ type: 'session_status', localId, projectId: row.project_id, status: info.status, claudeSessionId: info.claudeSessionId, model: info.model, permissionMode: info.permissionMode })
      return info
    },
```
(o `session_status` do broadcast passa a poder carregar `model`/`permissionMode` — o front os lê na Task 4.)

- [ ] **Step 4: Suíte + tsc + commit**

Run: `npm test -w server && npx tsc -p server --noEmit`
Expected: verde. Testes/rotas que ainda passam `skipPermissions` ao `start` do manager quebram de tipo — atualizar as CHAMADAS para `permissionMode` (grep `start(project` e `skipPermissions:` em server/test e routes; o mapeamento é `skipPermissions:false → permissionMode:'default'`, `true/omitido → 'bypassPermissions'`). Anotar cada ajuste no report.

```bash
git add server/src/db.ts server/src/claude/manager.ts server/test/manager.test.ts
git commit -m "feat(manager): permission_mode + setSessionOptions (hot-swap) + SessionInfo model/permissionMode"
```

---

### Task 3: rota PATCH /options + api + StartSessionModal (5 modos) + i18n perm.*

**Files:**
- Modify: `server/src/routes/sessions.ts` (PATCH /options), `server/test/routes-sessions.test.ts`
- Modify: `web/src/api.ts`, `web/src/components/StartSessionModal.tsx`, `web/src/i18n/{en,es,pt-BR}.ts`, `web/src/test/start-session-modal.test.tsx`

**Interfaces:**
- Consumes: `manager.setSessionOptions` (Task 2).
- Produces:
  - `PATCH /api/sessions/:localId/options` `{model?, permissionMode?}` → `SessionInfo`; modo inválido → 400; modelo inválido → ignorado.
  - `api.setSessionOptions(localId, {model?, permissionMode?}): Promise<SessionInfo>`
  - `PERMISSION_MODES` (const) reutilizável; StartSessionModal com seletor de 5 modos.

- [ ] **Step 1: Rota + teste**

Em `server/src/routes/sessions.ts`, adicionar a lista e a rota:
```ts
const PERMISSION_MODES = new Set(['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'])
```
```ts
  app.patch('/api/sessions/:localId/options', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    const body = (req.body ?? {}) as { model?: string; permissionMode?: string }
    const model = body.model && (MODEL_ALLOWLIST.has(body.model) || FULL_MODEL_RE.test(body.model)) ? body.model : undefined
    if (body.permissionMode !== undefined && !PERMISSION_MODES.has(body.permissionMode)) {
      return reply.code(400).send({ error: 'modo de permissão inválido' })
    }
    try {
      return await deps.manager.setSessionOptions(localId, { model, permissionMode: body.permissionMode as any })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })
```
Teste em `server/test/routes-sessions.test.ts` (após criar uma sessão e esperar idle):
```ts
  it('PATCH /options troca modo e persiste', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const { localId } = r1.json()
    await waitUntil(() => { const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any; return row?.status === 'idle' })
    const res = await app.inject({ method: 'PATCH', url: `/api/sessions/${localId}/options`, payload: { permissionMode: 'plan' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().permissionMode).toBe('plan')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })
  it('PATCH /options com modo inválido → 400', async () => {
    const r1 = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions` })
    const res = await app.inject({ method: 'PATCH', url: `/api/sessions/${r1.json().localId}/options`, payload: { permissionMode: 'evil' } })
    expect(res.statusCode).toBe(400)
    await app.inject({ method: 'POST', url: `/api/sessions/${r1.json().localId}/stop` })
  })
```

- [ ] **Step 2: api + i18n**

`web/src/api.ts`:
```ts
export type PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export const setSessionOptions = (localId: string, opts: { model?: string; permissionMode?: PermissionMode }) =>
  req<SessionInfo>(`/api/sessions/${localId}/options`, { method: 'PATCH', body: JSON.stringify(opts) })
```
Chaves i18n (adicionar a `perm` e `controls` em EN/ES/PT — todos os 3, `: typeof en` intacto):
```
perm: { manual:'Manual'/'Manual'/'Manual', auto:'Auto'/'Auto'/'Auto',
        acceptEdits:'Accept edits'/'Aceptar ediciones'/'Aceitar edições',
        plan:'Plan'/'Plan'/'Plano',
        bypass:'Skip permissions'/'Omitir permisos'/'Pular permissões' }
controls: { model:'Model'/'Modelo'/'Modelo', permission:'Permission'/'Permiso'/'Permissão',
            applied:'applied'/'aplicado'/'aplicado',
            workingHint:'wait for the current turn to finish'/'espera a que termine el turno'/'aguarde o turno terminar',
            title:'Session controls'/'Controles de sesión'/'Controles da sessão' }
```

- [ ] **Step 3: StartSessionModal — seletor de 5 modos**

Trocar o checkbox "Pular permissões" por um `<select>` de modo, no padrão do seletor de modelo já existente. Estado: `const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions')`. Options: bypass(`perm.bypass`)/manual(`perm.manual`=default)/auto/acceptEdits/plan — o `value` de "Manual" é `'default'`. O aviso condicional aparece quando `permissionMode !== 'bypassPermissions'`. No submit: `startSession(project.id, { continueConversation, permissionMode, model: model || undefined })`. Ajustar `api.startSession` para aceitar `permissionMode` em vez de `skipPermissions` (e a rota POST /sessions no backend — trocar `skipPermissions` por `permissionMode` no body e no `manager.start`).
Atualizar `web/src/test/start-session-modal.test.tsx`: onde asseria `skipPermissions`, passar a asserir `permissionMode` (o teste que marcava/desmarcava o checkbox vira selecionar um modo no `<select>`).

- [ ] **Step 4: Rodar e commitar**

Run: `npm test -w server && npm test -w web && npx tsc -p server --noEmit && npm run build -w web`
Expected: tudo verde. (A rota POST /sessions e `manager.start` passam a usar `permissionMode`; atualizar quaisquer chamadas remanescentes — grep `skipPermissions`.)

```bash
git add server/src/routes/sessions.ts server/test/routes-sessions.test.ts web/src/api.ts web/src/components/StartSessionModal.tsx web/src/i18n web/src/test/start-session-modal.test.tsx
git commit -m "feat: PATCH /options + StartSessionModal com 5 modos de permissão + i18n"
```

---

### Task 4: SessionControls (pill + popover) na barra de input

**Files:**
- Create: `web/src/components/SessionControls.tsx`
- Modify: `web/src/components/ChatInput.tsx` (renderiza o controle), `web/src/styles.css`, `web/src/types.ts` (SessionInfo campos), `web/src/store.ts` (session_status carrega model/permissionMode)
- Test: `web/src/test/session-controls.test.tsx` (create)

**Interfaces:**
- Consumes: `setSessionOptions`, `PermissionMode` (api); `PERMISSION_MODES` labels via i18n.

- [ ] **Step 1: types + store**

Em `web/src/types.ts`, `SessionInfo`: adicionar `model?: string | null` e `permissionMode?: PermissionMode` (definir `PermissionMode` aqui ou importar da api). Em `web/src/store.ts`, no handler `session_status`, carregar `model: msg.model ?? s.sessions[...]?.model` e `permissionMode: msg.permissionMode ?? ...` (padrão dos campos existentes).

- [ ] **Step 2: Teste (falhando) — `web/src/test/session-controls.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { SessionControls } from '../components/SessionControls'
import type { SessionInfo } from '../types'

const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 's1', projectId: 1, status: 'idle', claudeSessionId: 'c', updatedAt: 'x', model: 'opus', permissionMode: 'bypassPermissions', ...o })

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(sess({ permissionMode: 'plan' })), { status: 200, headers: { 'Content-Type': 'application/json' } })) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SessionControls', () => {
  it('mostra o modelo atual e abre o popover', () => {
    render(<SessionControls session={sess()} />)
    expect(screen.getByText(/opus/i)).toBeTruthy()
    fireEvent.click(screen.getByTestId('session-controls-pill'))
    expect(screen.getByText('Plano')).toBeTruthy() // label pt do modo plan (setup fixa pt-BR)
  })

  it('clicar um modo faz PATCH /options', async () => {
    render(<SessionControls session={sess()} />)
    fireEvent.click(screen.getByTestId('session-controls-pill'))
    fireEvent.click(screen.getByText('Plano'))
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/s1/options', expect.objectContaining({ method: 'PATCH' })))
  })

  it('desabilitado quando a sessão está trabalhando', () => {
    render(<SessionControls session={sess({ status: 'working' })} />)
    expect((screen.getByTestId('session-controls-pill') as HTMLButtonElement).disabled).toBe(true)
  })
})
```

Run: `npm test -w web -- session-controls` → FAIL.

- [ ] **Step 3: `SessionControls.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '../types'
import { setSessionOptions, type PermissionMode } from '../api'

const MODES: PermissionMode[] = ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan']
const MODE_KEY: Record<PermissionMode, string> = {
  bypassPermissions: 'perm.bypass', default: 'perm.manual', auto: 'perm.auto', acceptEdits: 'perm.acceptEdits', plan: 'perm.plan',
}
const MODE_COLOR: Record<PermissionMode, string> = {
  bypassPermissions: '#5cffb3', default: '#e8b33f', auto: '#58c4dc', acceptEdits: '#4fd6c9', plan: '#a98bff',
}
const MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'] as const
const MODEL_KEY: Record<string, string> = { '': 'session.modelDefault', fable: 'session.modelFable', opus: 'session.modelOpus', sonnet: 'session.modelSonnet', haiku: 'session.modelHaiku' }

export function SessionControls({ session }: { session: SessionInfo }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const disabled = session.status === 'working'
  const mode = (session.permissionMode ?? 'bypassPermissions') as PermissionMode
  const model = session.model ?? ''

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ bottom: window.innerHeight - r.top + 8, left: r.left })
    setOpen((o) => !o)
  }
  const apply = async (opts: { model?: string; permissionMode?: PermissionMode }) => {
    setError(null)
    try {
      await setSessionOptions(session.localId, opts)
      setFlash(true); setTimeout(() => setFlash(false), 1200)
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <>
      <button ref={ref} data-testid="session-controls-pill" className="sess-pill" disabled={disabled}
              title={disabled ? t('controls.workingHint') : t('controls.title')} onClick={toggle}>
        <span className="sess-pill__dot" style={{ background: MODE_COLOR[mode] }} />
        <span>⚙ {model ? t(MODEL_KEY[model] as any) : t('session.modelDefault')}</span>
        {flash && <span className="sess-pill__flash">✓</span>}
      </button>
      {open && createPortal(
        <div className="sess-pop__overlay" onClick={() => setOpen(false)}>
          <div className="sess-pop glass" style={{ bottom: pos.bottom, left: pos.left }} onClick={(e) => e.stopPropagation()}>
            <div className="sess-pop__eyebrow">{t('controls.model')}</div>
            {MODELS.map((m) => (
              <div key={m || 'default'} className={`sess-pop__item ${m === model ? 'active' : ''}`} onClick={() => void apply({ model: m || undefined })}>
                <span>{t(MODEL_KEY[m] as any)}</span>{m === model && <span className="sess-pop__check">✓</span>}
              </div>
            ))}
            <div className="sess-pop__eyebrow">{t('controls.permission')}</div>
            {MODES.map((m) => (
              <div key={m} className={`sess-pop__item ${m === mode ? 'active' : ''}`} onClick={() => void apply({ permissionMode: m })}>
                <span className="sess-pill__dot" style={{ background: MODE_COLOR[m] }} />
                <span style={{ flex: 1 }}>{t(MODE_KEY[m] as any)}</span>{m === mode && <span className="sess-pop__check">✓</span>}
              </div>
            ))}
            {mode !== 'bypassPermissions' && <div className="sess-pop__warn">{t('session.permWarning')}</div>}
            {error && <div className="sess-pop__error">⚠ {error}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
```

- [ ] **Step 4: ChatInput integra + CSS**

Em `web/src/components/ChatInput.tsx`: importar `SessionControls` e `useStore`; obter a sessão (`const session = useStore((s) => s.sessions[localId])`) e renderizar `{session && <SessionControls session={session} />}` na `div` da barra, ANTES do `<button ...>Enviar`. (A barra vira `display:flex; gap:8; align-items:flex-end`.)

CSS (fim de `styles.css`):
```css
.sess-pill { display:inline-flex; align-items:center; gap:6px; background:transparent; border:1px solid var(--glass-border); border-radius:999px; padding:6px 12px; font-size:13px; cursor:pointer; white-space:nowrap; }
.sess-pill:hover:not(:disabled) { background:var(--glass-bg-strong); border-color:var(--accent); }
.sess-pill:disabled { opacity:.5; cursor:not-allowed; }
.sess-pill__dot { width:8px; height:8px; border-radius:50%; }
.sess-pill__flash { color:var(--ok); font-weight:600; }
.sess-pop__overlay { position:fixed; inset:0; z-index:60; }
.sess-pop { position:fixed; min-width:220px; border-radius:12px; padding:6px; z-index:61; }
.sess-pop__eyebrow { font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--text-dim); padding:8px 8px 4px; }
.sess-pop__item { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; }
.sess-pop__item:hover { background:var(--glass-bg-strong); }
.sess-pop__item.active { background:var(--glass-bg-strong); }
.sess-pop__check { color:var(--accent); font-weight:600; }
.sess-pop__warn { font-size:11px; color:#e8b33f; padding:6px 8px; }
.sess-pop__error { font-size:12px; color:var(--err); padding:6px 8px; }
```

- [ ] **Step 5: Rodar, build, commitar**

Run: `npm test -w web && npm run build -w web`
Expected: verde; build limpo.

```bash
git add web/src/components/SessionControls.tsx web/src/components/ChatInput.tsx web/src/styles.css web/src/types.ts web/src/store.ts web/src/test/session-controls.test.tsx
git commit -m "feat(web): SessionControls (pill + popover) para hot-swap de modelo/permissão ao lado do Enviar"
```

Após o merge, o controlador faz um smoke visual (screenshot) com sessão real: pill mostra o modelo/modo, popover troca ao vivo, chip muda de cor, desabilita em working.

---

## Self-Review

**1. Spec coverage:** flag de launch sempre + init auto-set → Task 1 ✅; control_request setModel/setPermissionMode + timeout + control_response → Task 1 ✅; permission_mode col + migração + setSessionOptions (viva aplica+persiste; parada só persiste) + SessionInfo campos → Task 2 ✅; PATCH /options (valida modo→400, modelo→ignora) + StartSessionModal 5 modos + i18n → Task 3 ✅; pill+popover ao lado do Enviar, hot-swap instantâneo, chip por cor, desabilita em working, aviso ao sair do bypass → Task 4 ✅; nota de segurança e YAGNI respeitados ✅.
**2. Placeholder scan:** código completo nas partes de risco (protocolo de control, SessionControls); tabelas i18n/mapeamento explícitas; regra clara para chamadas remanescentes de `skipPermissions` (grep+converter). Nenhum TODO/TBD. ✅
**3. Type consistency:** `PermissionMode` idêntico em session.ts (Task 1) → manager (Task 2) → api/rota (Task 3) → front (Task 4); `setSessionOptions(localId, {model?, permissionMode?})` consistente entre manager, rota, api e SessionControls; `SessionInfo.model|permissionMode` definidos na Task 2 (backend) e Task 4 (front types) com os mesmos nomes; chaves i18n `perm.*`/`controls.*` criadas na Task 3 e consumidas na Task 4. ✅
