# Hermes em inglês + fila de tarefas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renomear toda a superfície agente/API/dados do hermes para inglês e adicionar fila FIFO por projeto às tarefas despachadas (ocupado/sem sessão → `queued`, entrega automática quando o alvo liberar).

**Architecture:** Ver spec `docs/superpowers/specs/2026-07-12-hermes-english-queue-design.md` (tabelas de rename e mecânica da fila — sua fonte de verdade para NOMES exatos). Task 1 = rename ponta a ponta com migrações; Task 2 = fila (tasks service + hook onSessionAvailable no manager + drain no orchestrator + status queued na UI).

**Tech Stack:** Fastify 5 + TS strict ESM (imports `.js`); React 18 + TS strict (imports sem extensão); SQLite (better-sqlite3, RENAME COLUMN ok); Vitest.

## Global Constraints

- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- TDD; `npm test` em `server/` e `web/`; `npx tsc --noEmit` + `npm run build` (web) verdes ao fim de cada task.
- Nomes EXATOS do spec (ferramentas, params, campos, status, rotas). Nada de compat PT.
- Migrações idempotentes (try/catch como as existentes em `server/src/db.ts`).
- Comentários de código continuam em português (padrão do repo); NOMES são em inglês.

---

### Task 1: Rename ponta a ponta (inglês)

**Files:**
- Modify: `server/hermes/hermes-mcp.mjs` (6 ferramentas: nomes/params/descrições/retornos EN)
- Modify: `server/src/db.ts` (CREATE TABLE novos em EN + migrações RENAME COLUMN/UPDATE de status)
- Modify: `server/src/tasks.ts` (TaskStatus EN incl. 'queued'; campos description/result)
- Modify: `server/src/mural.ts` OU onde o serviço do board vive (grep `titulo`) → campos title/content; manter nome de arquivo se o churn for alto, MAS renomear tipos/campos
- Modify: `server/src/routes/hermes.ts` (bodies EN; rota /mural → /board; resposta { answer })
- Modify: `server/src/routes/orchestrator.ts` (body description)
- Modify: `server/src/routes/ws.ts`/hub se o broadcast `mural_post` nasce lá (grep) → `board_post` com title/content
- Modify: `server/src/claude/manager.ts` (dispatchTask onComplete: 'completed'|'failed' + mensagens EN nos motivos)
- Web: `web/src/types.ts` (BoardPost/Task EN), `web/src/store.ts` (board/setBoard/openBoard/view 'board' + handler board_post/task_update), `web/src/api.ts`, `web/src/components/MuralPanel.tsx` → `BoardPanel.tsx`, `web/src/components/TasksPanel.tsx`, `web/src/components/Sidebar.tsx`/`App.tsx` (view), i18n 3 línguas (`tasks.queued/inProgress/completed/failed` + o que existir de mural/board)
- Tests: atualizar todos os afetados (grep por titulo/conteudo/descricao/resultado/em_andamento/concluida/falhou/mural nos testes) + NOVO teste de migração (DB velho → EN)

**Interfaces (produz p/ Task 2):**
- `TaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed'`
- `Task { …, description: string, result: string | null }`
- Rotas: POST `/api/hermes/board`, GET `/api/hermes/board`, POST `/api/hermes/ask` → `{ answer }`, POST `/api/orchestrator/dispatch` body `{ fromProjectId?, toProjectName, description }`
- WS: `board_post { projectId, projectName, title, content, createdAt, id }`, `task_update { task: Task }`

- [ ] **Step 1: teste de migração (falha)** — em `server/test/` (novo arquivo `migrations-en.test.ts` ou no teste do db existente): criar um DB em tmp com o SCHEMA ANTIGO (colunas descricao/resultado/titulo/conteudo, status 'em_andamento'/'concluida'/'falhou' inseridos), abrir com `openDb` e asserir: colunas novas existem, valores de status migrados (`in_progress`/`completed`/`failed`), dados preservados.
- [ ] **Step 2: migrações no db.ts** — CREATE TABLE novos com nomes EN; depois dos CREATE, migrações guardadas:
```ts
  try { db.exec(`ALTER TABLE tasks RENAME COLUMN descricao TO description`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE tasks RENAME COLUMN resultado TO result`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE mural RENAME COLUMN titulo TO title`) } catch { /* já migrado */ }
  try { db.exec(`ALTER TABLE mural RENAME COLUMN conteudo TO content`) } catch { /* já migrado */ }
  db.exec(`UPDATE tasks SET status = CASE status WHEN 'em_andamento' THEN 'in_progress' WHEN 'concluida' THEN 'completed' WHEN 'falhou' THEN 'failed' ELSE status END`)
```
- [ ] **Step 3: rename mecânico server** — tasks.ts, mural/board service, rotas, manager (dispatchTask usa 'completed'/'failed'; motivos: 'target project has no active session' / 'target agent is busy' — a Task 2 muda esse comportamento, aqui só o texto), hermes-mcp.mjs (descrições EN; retornos: 'posted to board', `task dispatched (id ${r.id})`, lista de list_tasks com os campos novos). Rode `grep -rn "descricao\|resultado\|titulo\|conteudo\|em_andamento\|concluida\|falhou\|perguntar\|despachar\|listar_\|publicar\|ler_mural\|/mural\|pergunta\b" server/ --include=*.ts --include=*.mjs` até zerar (fora de comentários históricos).
- [ ] **Step 4: rename web** — tipos/store/api/painéis (arquivo MuralPanel→BoardPanel via `git mv`), view 'mural'→'board', i18n dos 4 status + chaves de board. Grep análogo no web até zerar. Testes atualizados SEM enfraquecer asserções.
- [ ] **Step 5: verde total** — suítes server+web, tsc ambos, build web.
- [ ] **Step 6: Commit** — `feat(hermes): nomenclatura 100% em inglês (ferramentas, rotas, campos, status) com migrações`

---

### Task 2: Fila de tarefas (queued → entrega automática)

**Files:**
- Modify: `server/src/tasks.ts` (`create` com status explícito; `nextQueued(toProjectId)`; `markInProgress(id)`)
- Modify: `server/src/claude/manager.ts` (deps `onSessionAvailable?: (projectId: number) => void`; disparo no wire quando status vira 'idle' | 'needs_attention')
- Modify: `server/src/routes/orchestrator.ts` (dispatch tenta entrega imediata senão queued; função `drain(projectId)` exportada/registrada; onComplete → setResult + broadcast + o encadeamento vem do próprio status)
- Modify: `server/src/index.ts`/`app.ts` (ligar onSessionAvailable → drain; atenção à ordem de criação manager × registro do orchestrator — use uma referência mutável/callback setter se necessário, seguindo o padrão de deps do repo)
- Modify: `web/src/components/TasksPanel.tsx` (status queued com estilo próprio se o painel colorir status — siga o existente)
- Tests: `server/test/orchestrator*.test.ts` (ou onde as rotas do orchestrator são testadas — grep) + manager.test (hook)

**Interfaces:**
- Consumes: TaskStatus/Task da Task 1; `dispatchTask` existente do manager (recusa working/sem-sessão — vira o guard interno da entrega).
- Produces: `drain(projectId: number): void`; deps novas citadas.

- [ ] **Step 1: testes falhando** — cobrir com fake-claude (padrões do manager.test/routes):
  1. dispatch com alvo SEM sessão ativa → 200 `{ id }`, task fica `queued` (não `failed`).
  2. dispatch com alvo `working` (mande antes uma msg "tarefa demorada" do fake) → `queued`.
  3. alvo fica disponível (interrompa/finalize o turno do fake) → a queued é entregue: vira `in_progress` e, ao concluir, `completed` com o resultado do fake; broadcasts `task_update` emitidos nas transições.
  4. duas tarefas na fila → drenam em SEQUÊNCIA (a 2ª só entrega depois da 1ª concluir), ordem FIFO.
  5. hook: manager dispara `onSessionAvailable(projectId)` ao virar idle/needs_attention (spy).
- [ ] **Step 2: implementar** — conforme spec §2 (releitura de `nextQueued` antes de entregar + guard do dispatchTask contra corrida; `drain` chamado também logo após criar uma task queued cujo alvo JÁ esteja disponível — cobre a janela entre o check e o insert).
- [ ] **Step 3: UI** — status `queued` renderizado (i18n já criado na Task 1); se houver cor por status no painel, `queued` = tom neutro/aguardando.
- [ ] **Step 4: verde total** — suítes, tsc, build.
- [ ] **Step 5: Commit** — `feat(tasks): fila FIFO por projeto — despacho nunca falha por indisponibilidade`

## Smoke (controlador)
- Rota real: dispatch p/ projeto ocupado → `queued` no painel → alvo termina → `in_progress` → `completed` automático.
- Hermes real: numa sessão real, pedir ao Claude "use a tool list_tasks" e ver os nomes EN funcionando.

## Self-Review (autor)
- Spec coberto: rename total (T1, com migrações e teste de DB velho), fila FIFO + hook + drain + corrida (T2), ask_agent inalterado (fail-fast), UI queued (T2/i18n T1). ✔
- Placeholders: nenhum; onde o nome de arquivo/teste é incerto o passo manda grep/seguir padrão. ✔
- Consistência: TaskStatus/campos EN idênticos entre T1/T2; `drain` assinatura única. ✔
