# Opções ao iniciar sessão — Plano incremental

> Executar via subagente + revisão adversarial, mesmo rito do MVP.

**Goal:** Ao iniciar uma sessão, oferecer dois controles por sessão: "Continuar última conversa" (`--continue`, marcado por padrão) e "Pular permissões" (`--dangerously-skip-permissions`/`bypassPermissions`, marcado por padrão). A escolha vale para aquela sessão; o revive preserva a escolha de permissão.

**Contexto/decisões do usuário:**
- Continuar: um diálogo de início com checkbox "Continuar" **marcado por padrão**, desmarcável antes de abrir.
- Permissão: **por sessão**, ligado por padrão.
- Aviso de UX: sem o fluxo de aprovação de permissão na web (Fase 2), uma sessão com bypass DESLIGADO vai pausar aguardando aprovação. O modal deve avisar isso.

**Fatos validados (claude 2.1.206):**
- `--continue` numa pasta SEM histórico começa uma conversa nova sem erro (não precisa checar existência de histórico antes).
- `--continue` numa pasta COM histórico retoma a última conversa (contexto preservado no claude).
- `--continue` e `--resume` são mutuamente exclusivos (start usa continue; revive usa resume).

## Global Constraints
- TypeScript strict; ESM `.js`. Testes offline com fake-claude (nunca o real). Commits convencionais com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Bypass continua sendo o **padrão** (ligado). Nada muda no comportamento atual quando o usuário não mexe nos checkboxes.

## Contrato de interfaces (novo/alterado)
- `SessionOptions` ganha: `skipPermissions?: boolean` (default true), `continueLatest?: boolean` (default false).
- `manager.start(project, opts?: { continueLatest?: boolean; skipPermissions?: boolean }): SessionInfo`.
- Tabela `sessions` ganha coluna `skip_permissions INTEGER NOT NULL DEFAULT 1` (migração via ALTER defensivo). `revive` lê essa coluna e repassa; `continueLatest` não é persistido (só afeta o 1º spawn).
- REST: `POST /api/projects/:id/sessions` aceita body opcional `{ continueConversation?: boolean, skipPermissions?: boolean }`.
- Front: `startSession(projectId, opts?: { continueConversation?: boolean; skipPermissions?: boolean })`; novo `StartSessionModal`.

---

### Task A — Backend: args dinâmicos + flags no start/revive + schema

**Files:** `server/src/claude/session.ts`, `server/src/claude/manager.ts`, `server/src/db.ts`, `server/src/routes/sessions.ts`; testes `server/test/session.test.ts`, `server/test/manager.test.ts`, `server/test/routes-sessions.test.ts`.

**session.ts** — substituir `BASE_ARGS` fixo por montagem dinâmica em `start()`:
```ts
const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', this.opts.skipPermissions === false ? 'default' : 'bypassPermissions',
]
if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId)
else if (this.opts.continueLatest) args.push('--continue')
```
(resume tem precedência; nunca os dois juntos.) `SessionOptions` ganha `skipPermissions?` e `continueLatest?`.

**db.ts** — no schema, adicionar `skip_permissions INTEGER NOT NULL DEFAULT 1` em `sessions`; após `db.exec(SCHEMA)`, migração defensiva:
```ts
try { db.exec(`ALTER TABLE sessions ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 1`) } catch { /* já existe */ }
```

**manager.ts** — `start(project, opts?)` insere `skip_permissions` na row e passa `continueLatest`/`skipPermissions` à factory. `revive` lê `skip_permissions` da row e passa `skipPermissions` (booleano) à factory (continueLatest fica false no revive; usa resume).

**routes/sessions.ts** — `POST /api/projects/:id/sessions` lê `req.body` `{ continueConversation, skipPermissions }` e chama `manager.start(project, { continueLatest: continueConversation, skipPermissions })`. Defaults: continue=true, skipPermissions=true quando ausentes (mantém compat: um POST sem body inicia com continue+bypass).
*Nota de compat:* a rota já é chamada sem body hoje; garantir que body ausente ⇒ `{}` e defaults aplicam.

**Testes (TDD):**
- session: `skipPermissions:false` → args contêm `--permission-mode default` e NÃO `bypassPermissions`; `continueLatest:true` (sem resume) → args contêm `--continue`; `resumeSessionId` presente + `continueLatest:true` → contém `--resume` e NÃO `--continue`. (Verificar via um spy no spawn OU expor os args montados; preferir refatorar `start()` para delegar a um `buildArgs(opts)` puro e testável, exportado.)
- manager: `start(project, {continueLatest:false, skipPermissions:false})` → a factory recebe essas opts (usar sessionFactory espião que captura opts); a row persiste `skip_permissions=0`; `revive` de uma row com `skip_permissions=0` passa `skipPermissions:false` à factory.
- routes-sessions: `POST` com body `{continueConversation:false, skipPermissions:false}` cria sessão (201); `POST` sem body ainda cria (201) com defaults.

Recomendação forte: extrair `export function buildClaudeArgs(opts): string[]` em session.ts e testá-la diretamente (pura), além do fluxo.

---

### Task B — Frontend: StartSessionModal + wiring

**Files:** novo `web/src/components/StartSessionModal.tsx`; `web/src/components/ProjectCard.tsx`; `web/src/api.ts`; teste `web/src/test/start-session-modal.test.tsx`.

**api.ts** — `startSession(projectId, opts?: { continueConversation?: boolean; skipPermissions?: boolean })` envia `body: JSON.stringify(opts ?? {})` quando `opts` existe (lembrar do fix: header Content-Type só com body). Sem opts, mantém POST sem corpo (compat).

**StartSessionModal.tsx** — modal com dois checkboxes marcados por padrão:
- ☑ "Continuar última conversa desta pasta (se houver)" → `continueConversation`
- ☑ "Pular permissões (--dangerously-skip-permissions)" → `skipPermissions`
- Quando "Pular permissões" está DESMARCADO, mostrar aviso em amarelo: "Sem pular permissões, a sessão vai pausar esperando aprovação — a aprovação pela web ainda não existe (Fase 2). Use o handoff pro terminal para aprovar."
- Botões: "Cancelar" e "Iniciar sessão". Ao iniciar: `const info = await startSession(project.id, { continueConversation, skipPermissions })`; depois `openSession(info.localId)`; fecha modal.

**ProjectCard.tsx** — o botão "Iniciar sessão" agora abre o `StartSessionModal` (estado local `showStart`), em vez de chamar `startSession` direto. "Reviver" permanece chamando `reviveSession` direto.

**Testes:**
- StartSessionModal: renderiza com ambos checkboxes marcados; desmarcar "Pular permissões" mostra o aviso; clicar "Iniciar" chama `startSession` com as flags corretas (mock de api) e chama `openSession`.

---

### Task C — Smoke visual + revisão

- Subir dev servers; criar/usar um projeto numa pasta que já teve conversa; iniciar sessão com "Continuar" marcado → verificar que o contexto anterior é reconhecido pelo claude; iniciar outra com "Continuar" desmarcado → conversa limpa; testar "Pular permissões" desmarcado → ver o aviso e o comportamento (sessão pausa/uso via terminal).
- Suítes verdes; revisão adversarial das duas tasks; revisão final do incremento.
