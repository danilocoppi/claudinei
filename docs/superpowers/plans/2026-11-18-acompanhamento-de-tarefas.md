# Acompanhamento de tarefas longas — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o agente de cada terminal publica o andamento de tarefas longas por uma ferramenta do Hermes, e o Claudinei o mostra numa coluna à direita do chat.

**Architecture:** `update_progress` (Hermes) → `POST /api/hermes/progress` → `progress.ts` valida, grava `~/.claudinei/acompanhamento/<projectId>-<engine>.json` e o servidor transmite `{type:'progress'}` por WebSocket. A interface guarda o estado por `projectId:engine`, busca o atual ao abrir, e a `ProgressColumn` desenha ao lado do chat.

**Tech Stack:** TypeScript, Fastify, MCP SDK 1.29 + zod, React + zustand, vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-18-acompanhamento-de-tarefas-design.md`

## Global Constraints

- Um acompanhamento por terminal = `projectId` + `engine`; cada chamada substitui o estado inteiro; o servidor carimba `updatedAt` (ISO).
- Estados de tarefa: `pending`, `in_progress`, `review`, `blocked`, `done`.
- Limites: `title` ≤ 200; `now.title` ≤ 200; `now.detail` ≤ 1000; `tasks` ≤ 40, `name` ≤ 200, `note` ≤ 500; `waiting` ≤ 10 itens de ≤ 500. Textos vazios (só espaço) recusados em `title`, `now.title`, `name`.
- `engine` só `^[a-z0-9-]{1,32}$` (vira nome de arquivo).
- Pasta: `config.progressDir = env.CLAUDINEI_PROGRESS ?? ~/.claudinei/acompanhamento`.
- Sem GPU: a bolinha pulsa só por `opacity`; `prefers-reduced-motion` desliga.
- Textos de interface em pt-BR, en, es (i18n existente).
- Servidor e testes do servidor no Node 24: `N24=/usr/local/n/versions/node/24.15.0/bin; cd server && PATH=$N24:$PATH $N24/npx vitest run <arquivo>`. Interface: `cd web && npx vitest run <arquivo>`.
- Não reiniciar o `claudinei.service`. Ensaio na instância isolada (9199) com `env -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS`.

## Review Focus

1. `engine` com caminho (`../x`, `a/b`) na API → 400, nada gravado fora da pasta. Teste na Task 1.
2. Arquivo corrompido ou meio gravado no disco → leitura devolve `null` (sem 500); gravação atômica (tmp + rename). Teste na Task 1.
3. Chamada inválida do agente (status desconhecido, 41 tarefas) → a ferramenta devolve o erro legível e o estado anterior continua. Testes nas Tasks 2 e 3.
4. Dois motores no mesmo projeto → estados separados; a aba do Codex não mostra o do Claude. Testes nas Tasks 4 e 5.
5. Terminal `stopped`/`dead` (ou sem sessão) com tarefa `in_progress` → aviso e bolinhas paradas; `idle`/`needs_attention` → sem aviso. Teste na Task 5.

---

### Task 1: armazenamento e validação (`server/src/progress.ts`)

**Files:** Create `server/src/progress.ts`; Modify `server/src/config.ts` (`progressDir`); Test `server/test/progress.test.ts`.

**Interfaces — Produces:**
- `type ProgressStatus = 'pending' | 'in_progress' | 'review' | 'blocked' | 'done'`
- `interface ProgressInput { title: string; now: { title: string; detail?: string }; tasks: { name: string; status: ProgressStatus; note?: string }[]; waiting: string[] }`
- `interface Progress extends ProgressInput { updatedAt: string }`
- `validateProgress(input: unknown): { ok: true; value: ProgressInput } | { ok: false; error: string }` — `error` em inglês, diz o campo (`"tasks[3].status must be one of pending, in_progress, review, blocked, done"`). `waiting` ausente vira `[]`; strings aparadas.
- `createProgressStore(opts: { dir: string; now?: () => Date })` → `{ get(projectId: number, engine: string): Progress | null; set(projectId: number, engine: string, input: ProgressInput): Progress; clear(projectId: number, engine: string): void; pathOf(projectId: number, engine: string): string }`; `engine` inválido → `throw new UserError('invalid_engine', …)` (de `user-error.ts`).

- [ ] **Step 1: testes que falham** (`progress.test.ts`): `'aceita o estado completo e preenche waiting vazio'`; `'recusa status desconhecido, nome vazio e mais de 40 tarefas, dizendo o campo'` (mensagens contêm `tasks[0].status`, `tasks[0].name`, `tasks`); `'recusa textos acima dos limites'` (title 201, detail 1001, note 501, 11 waiting); `'grava, lê e carimba updatedAt'` (now fixo → `updatedAt` = ISO dele; arquivo em `pathOf(1,'claude')` = `<dir>/1-claude.json`); `'motores separados no mesmo projeto'`; `'engine com caminho é recusado e nada é gravado fora'` (`'../x'`, `'a/b'` → throw; diretório-pai sem arquivo novo); `'arquivo corrompido lê como null'`; `'clear apaga e get volta null'`; `'gravação é atômica'` (após `set`, não sobra `*.tmp` no diretório).
- [ ] **Step 2:** rodar → FAIL (módulo não existe).
- [ ] **Step 3:** implementar; `config.progressDir` como as outras pastas.
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** commit `feat(acompanhamento): estado validado e gravado por terminal`.

### Task 2: rotas e transmissão

**Files:** Create `server/src/routes/progress.ts`; Modify `server/src/app.ts` (registrar com `createProgressStore({ dir: deps.config.progressDir })` e `deps.wsHub?.broadcast`); Test `server/test/progress-routes.test.ts` (padrão de `routes-hermes.test.ts`: `buildApp` + `app.inject`, `loadConfig({ CLAUDINEI_PROGRESS: tmpdir })`).

**Interfaces — Consumes:** Task 1. **Produces:**
- `POST /api/hermes/progress` body `{ projectId: number; engine: string; state: unknown }` → 200 `Progress`; 400 `{ error }` (validação ou engine); 404 projeto inexistente; `requireProjectAccess`. Transmite `{ type: 'progress', projectId, engine, progress }`.
- `GET /api/projects/:id/progress?engine=<e>` → 200 `{ progress: Progress | null; path: string }`.
- `DELETE /api/projects/:id/progress?engine=<e>` → 204; transmite `{ type: 'progress', projectId, engine, progress: null }`.

- [ ] **Step 1: testes que falham:** `'POST grava, devolve o estado e transmite'`; `'POST inválido: 400 com o campo, e o estado anterior fica'`; `'GET devolve o estado e o caminho do arquivo'`; `'GET de terminal sem acompanhamento: progress null'`; `'DELETE apaga e transmite null'`; `'projeto inexistente: 404'`; `'engine com caminho: 400'`.
- [ ] **Step 2:** rodar → FAIL. - [ ] **Step 3:** implementar. - [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** commit `feat(acompanhamento): rotas e aviso em tempo real`.

### Task 3: ferramenta `update_progress` no Hermes

**Files:** Modify `server/src/hermes/run-hermes.ts`; Test `server/test/hermes-mode.test.ts`.

**Interfaces — Consumes:** `POST /api/hermes/progress` (Task 2). Usa `PROJECT_ID` e `ENGINE ?? 'claude'` já disponíveis em `runHermes`.

- `inputSchema` zod: `title`, `now: { title, detail? }`, `tasks: [{ name, status: enum, note? }]`, `waiting?: string[]`. Resposta: `progress updated` ou, em erro da API, resultado com `isError: true` e o texto do erro.
- Descrição (cópia fixa; ajuste de redação sem mudar o sentido; ≤ 2000 caracteres):

```
Publishes the progress of a long task to the operator's progress column in Claudinei, so they can follow it without reading the chat. Use it only for work with several steps (a feature, a migration, a review with fixes), never for a quick answer or a single command. Call it when the long task starts (with all planned tasks), each time a task finishes or changes status, when you get blocked or need the operator, and when the whole task ends (every task done). Do not call it on every tool use. Each call replaces the whole state, so always send the full list. Carry over into `waiting` every item from the previous state that still depends on the operator, unless they answered it. A newer long task (yours, a scheduled routine or a task dispatched by another project) replaces the previous one. Only the main agent calls this; subagents never do. Write the texts in the operator's language. If the call is rejected, fix what the error says and call again.
```

- [ ] **Step 1: testes que falham** (servidor HTTP fake, spawn do shim como os testes existentes): `'update_progress manda o estado com o projeto e o motor do terminal'` (body recebido: `projectId: 1`, `engine: 'codex'` via `CLAUDINEI_ENGINE`, `state.tasks[0].status`); `'erro da API volta ao agente como erro legível'` (fake responde 400 `{error:'tasks[0].status must be …'}` → `result.isError === true` e o texto contém `tasks[0].status`); `'a descrição orienta: tarefas longas, carregar o que espera o operador, subagentes não'` (`tools/list` → descrição contém `several steps`, `Carry over`, `subagents never`).
- [ ] **Step 2:** FAIL. - [ ] **Step 3:** implementar. - [ ] **Step 4:** PASS + suíte do servidor inteira.
- [ ] **Step 5:** commit `feat(hermes): ferramenta update_progress`.

### Task 4: estado na interface

**Files:** Modify `web/src/types.ts`, `web/src/api.ts`, `web/src/store.ts`; Test `web/src/test/progress-store.test.ts`.

**Interfaces — Produces:**
- `types.ts`: `ProgressStatus`, `Progress` (mesma forma da Task 1).
- `api.ts`: `fetchProgress(projectId: number, engine: string): Promise<{ progress: Progress | null; path: string }>`; `clearProgress(projectId: number, engine: string): Promise<void>`.
- `store.ts`: `progress: Record<string, Progress | null>` com chave `progressKey(projectId, engine) = \`${projectId}:${engine}\`` (exportada); `setProgress(projectId, engine, p)`; `applyWsMessage` trata `type: 'progress'`; `progressOpen: boolean` persistido em `localStorage['claudinei.progressOpen']` (`'1'`/`'0'`), `toggleProgress()`.

- [ ] **Step 1: testes que falham:** `'mensagem progress guarda por projeto e motor'` (duas mensagens, motores diferentes, chaves separadas); `'progress null apaga'`; `'abrir/fechar a coluna persiste'`.
- [ ] **Step 2:** FAIL. - [ ] **Step 3:** implementar. - [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(acompanhamento): estado na interface`.

### Task 5: botão, coluna e layout

**Files:** Create `web/src/components/ProgressColumn.tsx`; Modify `web/src/components/ChatView.tsx` (botão no cabeçalho antes de "Schedules"; o conteúdo atual do chat vai num `div.chat-main` e a coluna é irmã dele num `div.chat-layout` em linha), `web/src/styles.css`, `web/src/i18n/{pt-BR,en,es}.ts`, `UX-CONTRACT.md` (seção "Acompanhamento de tarefas longas"); Test `web/src/test/progress-column.test.tsx`.

**Interfaces — Consumes:** Task 4. **Produces:** `ProgressColumn({ projectId, engine, sessionStatus }: { projectId: number; engine: string; sessionStatus?: SessionStatus })`; busca com `fetchProgress` ao montar e ao mudar de terminal.

Comportamento:
- Botão `aria-label` "Acompanhamento" (`aria-pressed`), ícone de lista; bolinha `.progress-btn__dot` quando há tarefa `in_progress` e o terminal não está parado.
- "Parado" = `sessionStatus` ∈ {`stopped`, `dead`} ou ausente. Com tarefa `in_progress` e parado → aviso `progress.stale` e sem pulso.
- Blocos: título + "N de M" (`done`/total) com barra; **Agora** (bolinha pulsando por opacidade); **Tarefas** (ícone ✓/◐/○/!/👁 + chip do estado + nota); **Esperando você** (só com itens; destaque âmbar `--warn`); rodapé "atualizado há X" (âmbar após 45 min com tarefa não concluída) + caminho do arquivo com `CopyButton` + botão "Descartar" (`ConfirmDialog` → `clearProgress`).
- Vazio: `progress.empty`.
- Largura 340 px, `border-left` como os painéis; empurra o chat. `@media (max-width: 768px)`: `position: fixed; inset: 0; z-index` acima do chat, com botão de voltar (o mesmo toggle).

- [ ] **Step 1: testes que falham:** `'sem acompanhamento mostra o vazio'`; `'desenha título, contagem, agora, tarefas com estado e esperando você'` (texto "2 de 3", chips "em andamento"/"concluída", item de waiting); `'estado novo pelo WebSocket atualiza a coluna'`; `'botão abre e fecha, e a bolinha só com tarefa em andamento'`; `'terminal parado com tarefa em andamento avisa; ocioso não'` (`dead` → aviso; `idle` → sem aviso); `'motor da aba: a coluna do Codex não mostra o do Claude'`; `'descartar pede confirmação e apaga'` (fetch DELETE chamado após confirmar); `'atualizado há mais de 45 min fica âmbar com tarefa aberta'` (classe `progress__updated--old`, `Date.now` mockado).
- [ ] **Step 2:** FAIL. - [ ] **Step 3:** implementar. - [ ] **Step 4:** PASS + suíte da interface + `npx tsc --noEmit -p .` em `web`.
- [ ] **Step 5:** commit `feat(acompanhamento): coluna à direita do chat`.

### Task 6: ensaio com os motores reais

**Files:** nenhum de produto.

- [ ] **Step 1:** instância isolada (9199) com `CLAUDINEI_PROGRESS=/tmp/claudinei-e2e/acompanhamento`, CLIs reais, sem as variáveis herdadas do serviço; projeto descartável `/home/coppi/e2e-padaria` (README de site de padaria).
- [ ] **Step 2:** Claude (sonnet): "Cria três páginas para o site, uma por vez: cardapio.html, encomendas.html e contato.html, cada uma com título e um parágrafo." Esperado: `update_progress` no início com 3 tarefas, a cada página e no fim; a coluna (Chrome, Playwright) mostra a evolução; screenshot da coluna aberta para conferir o visual.
- [ ] **Step 3:** pedido rápido ("que horas a padaria abre?") → nenhuma chamada de `update_progress`.
- [ ] **Step 4:** Codex e OpenCode com a mesma tarefa longa → chamam a ferramenta (Kimi: sem login, registrar).
- [ ] **Step 5:** limpar `/tmp/claudinei-e2e`, a pasta do projeto, `~/.claude/projects/-home-coppi-e2e-padaria`, rollouts do Codex do teste; matar só o PID da 9199.
