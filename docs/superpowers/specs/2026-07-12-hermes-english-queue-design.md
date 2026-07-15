# Hermes em inglês + fila de tarefas — Design

**Data:** 2026-07-12
**Status:** Aprovado

## Objetivo

1. **Nomenclatura 100% em inglês** em tudo que agente/API/dados tocam (ferramentas MCP,
   parâmetros, campos HTTP/WS, colunas e valores no banco, tipos TS).
2. **Fila de tarefas**: despachar para um agente ocupado (ou sem sessão ativa) não
   falha mais — enfileira e entrega quando o alvo ficar disponível.

## 1) Rename (inglês)

### Ferramentas MCP (hermes-mcp.mjs) — nomes, params, descrições e retornos em EN
| Antes | Depois | Params |
|---|---|---|
| listar_projetos | `list_projects` | — |
| perguntar_agente | `ask_agent` | `project`, `question` |
| publicar_no_mural | `post_to_board` | `title`, `content` |
| ler_mural | `read_board` | `limit?` |
| despachar_tarefa | `dispatch_task` | `project`, `task` |
| listar_tarefas | `list_tasks` | — |

### Status de tarefa
`em_andamento | concluida | falhou` → **`queued | in_progress | completed | failed`**
(`queued` é novo — parte da fila). Migração: `UPDATE tasks SET status = CASE ...` para
os valores antigos (idempotente).

### Banco (SQLite ≥3.25: `ALTER TABLE … RENAME COLUMN`, com try/catch idempotente)
- `tasks.descricao` → `description`; `tasks.resultado` → `result`.
- `mural` (board): `titulo` → `title`, `conteudo` → `content`. A TABELA `mural` mantém
  o nome (rename de tabela tem mais atrito; o nome não vaza para agentes).
- `CREATE TABLE IF NOT EXISTS` novos já usam os nomes EN (instalação nova não migra).

### HTTP/WS/Tipos
- Rotas: `/api/hermes/ask` body `{ fromProjectId, toProjectName, question }` (resposta
  `{ answer }`); `/api/hermes/mural` → **`/api/hermes/board`** (POST `{ projectId,
  title, content }`, GET idem); `/api/orchestrator/dispatch` body `{ fromProjectId,
  toProjectName, description }`.
- WS: `mural_post` → **`board_post`** com `{ title, content, ... }`; `task_update`
  com `Task` nos campos novos.
- Tipos web: `MuralPost` → `BoardPost { title, content }`; `Task { description,
  result, status: queued|in_progress|completed|failed }`. Store: `mural` →
  `board` / `setMural` → `setBoard` / `openMural` fica (nome de view interna) —
  NÃO: renomear também (`openBoard`, view 'board') para coerência.
- UI: rótulos por i18n (pt continua mostrando "Em andamento" etc.):
  `tasks.queued/inProgress/completed/failed` nas 3 línguas.
- Componentes: `MuralPanel.tsx` → `BoardPanel.tsx` (rename de arquivo/símbolo).
- Sem compat retroativa de payloads PT (app local, único consumidor é o próprio front
  + hermes script — atualizados juntos).

## 2) Fila de tarefas

### Comportamento
- `dispatch_task` NUNCA falha por indisponibilidade: se o alvo tem sessão ativa e
  livre (não-working) → entrega imediata (status `in_progress`); senão → **`queued`**.
- Entrega FIFO por projeto alvo: quando uma sessão do projeto fica **disponível**
  (status vira `idle` ou `needs_attention`), a tarefa `queued` mais antiga daquele
  projeto é entregue. O dreno encadeia sozinho: tarefa termina → status do alvo muda →
  próxima da fila é entregue.
- Timeout de execução (10 min após a entrega) inalterado. Tarefa `queued` não expira
  (fica visível no painel Tasks; cancelamento fica fora do escopo).
- `ask_agent` (síncrono) continua falhando rápido com mensagem clara — quem pergunta
  está esperando a resposta; fila não faz sentido ali.

### Mecânica
- `tasks.ts`: `create(..., status)` explícito; `nextQueued(toProjectId)`;
  `markInProgress(id)`; `setResult(id, 'completed'|'failed', result)`.
- `manager`: novo hook `deps.onSessionAvailable?: (projectId: number) => void`,
  disparado no listener de status do `wire` quando o status novo é `idle` ou
  `needs_attention`.
- `orchestrator`: função `drain(projectId)` — pega `nextQueued`, se o alvo está
  disponível entrega via `dispatchTask` (marca `in_progress`, broadcast) e o
  `onComplete` grava `completed/failed` + broadcast. `dispatch` HTTP usa o mesmo
  caminho: tenta entregar; senão cria `queued` + broadcast. `index/app` liga
  `onSessionAvailable → drain`.
- Corrida (duas entregas simultâneas p/ o mesmo alvo): o dreno roda no event loop
  single-thread e `markInProgress` só promove `queued` → releitura antes de entregar
  garante no-máximo-uma; o `dispatchTask` já recusa alvo `working` como cinto extra.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| Alvo ocupado no dispatch | `queued` (antes: falhava) |
| Alvo sem sessão ativa | `queued` até alguém dar start/revive no projeto |
| Alvo morre com tarefa entregue em andamento | timeout de 10 min → `failed` (existente) |
| Vários `queued` p/ o mesmo alvo | FIFO, um por vez, encadeado pelos eventos de status |
| DB antigo (colunas/status PT) | migrações idempotentes na abertura |

## Testes

- server: migrações (DB velho com dados PT → colunas/valores EN); tasks service
  (nextQueued FIFO/markInProgress); orchestrator dispatch → queued quando ocupado,
  entrega quando livre, dreno encadeado (2 tarefas na fila drenam em sequência com
  fake-claude); hook onSessionAvailable; rotas com bodies EN.
- hermes script: é fino (HTTP) — os testes das rotas cobrem; nomes/params validados
  por leitura (sem harness MCP).
- web: tipos/painéis renomeados (tasks-panel/mural→board tests), i18n dos 4 status.
- Smoke real (controlador): dispatch para alvo ocupado → aparece `queued` no painel →
  alvo termina → entrega automática → `completed`.

## Fora de escopo (YAGNI)

- Cancelar/repriorizar tarefas na fila; expiração de queued.
- Fila para `ask_agent`.
- Compat com payloads PT antigos.
