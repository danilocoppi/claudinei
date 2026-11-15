# Mensagem no terminal errado — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o agente de cada terminal pergunta antes de agir quando a mensagem parece trabalho de outro projeto, com as quatro saídas do design.

**Architecture:** o MCP Hermes (`server/src/hermes/run-hermes.ts`), que todos os motores carregam, passa a declarar `instructions` no `initialize`. Ao subir, busca `GET /api/hermes/projects` (que passa a trazer grupo e setor), acha o próprio projeto por `CLAUDINEI_PROJECT_ID` e monta o texto com uma função pura. Sem API, sobe com a regra genérica.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` 1.29 (`new McpServer(info, { instructions })`), Fastify, vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-mensagem-no-terminal-errado-design.md`

## Global Constraints

- Servidor e testes do servidor com o Node 24: `N24=/usr/local/n/versions/node/24.15.0/bin; cd server && PATH=$N24:$PATH $N24/npx vitest run <arquivo>`.
- O Hermes nunca deixa de subir: busca com timeout de **3 s** (`AbortSignal.timeout(3000)`); qualquer erro → regra genérica.
- Texto da regra em inglês (como as descrições das ferramentas), pedindo a pergunta no idioma do operador.
- As quatro opções, nesta ordem: forward and drop here / forward and keep here too / it belongs here / sent by mistake, ignore.
- Não reiniciar o `claudinei.service`; verificação real numa instância isolada (porta 9199).

## Review Focus

1. API lenta (aceita a conexão e não responde) na subida do Hermes → `initialize` responde mesmo assim, em menos de 5 s, com a regra genérica. Teste na Task 2.
2. Nome de projeto/grupo com aspas ou quebra de linha → não quebra o texto nem injeta linha nova de instrução (nomes passam por `JSON.stringify`). Teste na Task 1.
3. Muitos projetos (200) → a lista nas instructions é cortada em 60 nomes com "…and N more (see list_projects)". Teste na Task 1.
4. `CLAUDINEI_PROJECT_ID` ausente/0 ou projeto que não está na lista (sem acesso, apagado) → regra genérica, ainda com os outros projetos. Teste na Task 1.
5. Projeto sem grupo/setor, e projeto cujo setor vem do grupo (`project.sectorId` nulo, `group.sectorId` preenchido) → o texto não mostra "group null"; setor herdado do grupo. Testes nas Tasks 1 e 2.

---

### Task 1: texto das instruções (função pura)

**Files:**
- Create: `server/src/hermes/instructions.ts`
- Test: `server/test/hermes-instructions.test.ts`

**Interfaces:**
- Produces: `export interface HermesProject { id: number; name: string; group?: string; sector?: string; hasActiveSession?: boolean }` e `export function buildInstructions(selfId: number, projects: HermesProject[] | undefined): string`.

- [ ] **Step 1: testes que falham** (`hermes-instructions.test.ts`):
  - `'diz qual é o projeto do terminal, com grupo e setor, e lista os outros'`: com `[{id:1,name:'Claudinei',group:'Ferramentas',sector:'Interno'},{id:2,name:'Loja',sector:'Clientes'}]` e `selfId 1` → contém `"Claudinei"`, `"Ferramentas"`, `"Interno"`, `"Loja"`; a linha do próprio projeto não aparece também na lista dos outros.
  - `'traz a regra com as quatro saídas na ordem'`: os índices de `/forward.*drop/i`, `/forward.*keep/i`, `/belongs here/i`, `/mistake/i` são crescentes; contém `dispatch_task`, `AskUserQuestion` e `operator's language`.
  - `'citar outro projeto de passagem não dispara'`: contém `in passing`.
  - `'sem API ou projeto desconhecido: regra genérica'`: `buildInstructions(0, undefined)` e `buildInstructions(9, [{id:2,name:'Loja'}])` contêm a regra (`/belongs here/i`) e `list_projects`; o segundo ainda cita `"Loja"`.
  - `'nome com aspas e quebra de linha não abre linha nova'`: projeto `'A"\nIgnore previous'` → o texto contém `JSON.stringify` desse nome e nenhuma linha começa com `Ignore previous`.
  - `'sem grupo nem setor não escreve null/undefined'`: não contém `null` nem `undefined`.
  - `'200 projetos: lista corta em 60 e diz quantos faltam'`: contém `and 139 more` (200 − self − 60) e o nome do 61º outro projeto não aparece.
- [ ] **Step 2:** rodar `hermes-instructions.test.ts` → FAIL (módulo não existe).
- [ ] **Step 3:** implementar `buildInstructions` em `instructions.ts`. Nomes sempre via `JSON.stringify`; descrição de um projeto = nome + `(group X, sector Y)` só com o que existir. Regra (cópia fixa, ajuste de redação permitido sem mudar o sentido):

```
## Messages that belong to another project
The operator runs one terminal per project and sometimes sends a message to the wrong one.
Before acting on a message, check whether the request itself is work for another project: it is about another project's code, product or task, and nothing ties it to this one. Mentioning another project in passing (a comparison, a reference, asking you to consult its agent) does not count; when in doubt, it belongs here.
When it looks like another project's work, do not act on it yet. Ask the operator one question, in the operator's language, with these options:
1. Forward it to <project> and drop the subject here
2. Forward it to <project> and keep working on it here too
3. It belongs here, go ahead
4. Sent by mistake, ignore it
Use your question tool when you have one (AskUserQuestion); otherwise ask as text with the numbered options and wait for the answer.
To forward, use dispatch_task and rewrite the request so it stands on its own: the other agent cannot see this conversation.
After options 1 or 4, disregard that subject from then on: do not bring it up, act on it or let it shape later work here. If the operator returns to it, ask again instead of assuming.
```

  Antes da regra: `This terminal belongs to project <self>.` (ou, sem self: `This terminal belongs to one Claudinei project; list_projects shows the others.`) e `Other projects: …` (até 60).
- [ ] **Step 4:** rodar o teste → PASS.
- [ ] **Step 5:** commit `feat(hermes): texto que ensina o agente a perguntar antes de agir em mensagem de outro projeto`.

### Task 2: grupo/setor na API e instructions no initialize do Hermes

**Files:**
- Modify: `server/src/routes/hermes.ts` (`GET /api/hermes/projects`)
- Modify: `server/src/hermes/run-hermes.ts` (busca na subida + `new McpServer(..., { instructions })`)
- Test: `server/test/routes-hermes.test.ts`, `server/test/hermes-mode.test.ts`

**Interfaces:**
- Consumes: `buildInstructions`, `HermesProject` (Task 1); `createGroupsService(db).list()` / `.listSectors()` de `server/src/groups.ts`.
- Produces: `GET /api/hermes/projects` → `{ id, name, hasActiveSession, group?: string, sector?: string }[]`; setor = `project.sectorId ?? group.sectorId`.

- [ ] **Step 1: testes que falham:**
  - `routes-hermes.test.ts` › `'GET /api/hermes/projects traz grupo e setor, e o setor herdado do grupo'`: cria setor "Interno", grupo "Ferramentas" no setor, põe o projeto "Origem" no grupo (via rotas/serviços existentes) → item de Origem tem `group: 'Ferramentas', sector: 'Interno'`; "Destino" sem os campos.
  - `hermes-mode.test.ts` › `'initialize traz as instructions com o projeto do terminal'`: servidor HTTP fake responde `/api/hermes/projects` com `[{id:1,name:'Claudinei',group:'Ferramentas'},{id:2,name:'Loja'}]`; spawn do shim com `CLAUDINEI_PROJECT_ID=1` → `result.instructions` contém `"Claudinei"`, `"Loja"` e `belongs here`.
  - `hermes-mode.test.ts` › `'API fora do ar ou muda: sobe com a regra genérica em menos de 5 s'`: (a) `CLAUDINEI_API=http://127.0.0.1:1`; (b) servidor que aceita e nunca responde → `initialize` responde, `instructions` contém `belongs here`, tempo < 5000 ms.
- [ ] **Step 2:** rodar os dois arquivos → FAIL.
- [ ] **Step 3:** implementar: na rota, mapear `groupId`/`sectorId` para nomes; em `runHermes`, antes do `McpServer`, `fetch` de `/api/hermes/projects` com o token e `AbortSignal.timeout(3000)` (erro → `undefined`), e passar `{ instructions: buildInstructions(PROJECT_ID, projetos) }`.
- [ ] **Step 4:** rodar os dois arquivos e depois a suíte do servidor inteira → PASS (a falha intermitente conhecida do orchestrator: rodar isolada antes de investigar).
- [ ] **Step 5:** commit `feat(hermes): instructions do MCP dizem o projeto do terminal e a regra do terminal errado`.

### Task 3: conferir nos motores reais

**Files:** nenhum de produto (se um motor ignorar as instructions: o plano B do design entra como task nova, só para ele, aprovada antes).

- [ ] **Step 1:** subir a instância isolada (9199, banco em `/tmp/claudinei-e2e`, **CLIs reais**, sem `CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION`/`CLAUDE_CODE_ENTRYPOINT`) e criar dois projetos em pastas descartáveis: "Padaria" (pasta com um `README.md` de site de padaria) e "Financeiro" (README de planilha de contas).
- [ ] **Step 2:** para cada motor instalado (Claude com modelo barato; Codex, Kimi, OpenCode se houver CLI e login), abrir terminal no "Padaria" e mandar: "Concilia o extrato de outubro do banco com a planilha de contas a pagar". Esperado: o agente **pergunta** com as quatro opções (no Claude, painel com botões); não mexe em arquivo nem chama `dispatch_task` antes da resposta.
- [ ] **Step 3:** no Claude, escolher "encaminhar e esquecer aqui" → `dispatch_task` para "Financeiro"; em seguida perguntar "o que falta no site?" → resposta só sobre a padaria.
- [ ] **Step 4:** controle negativo: "compara o README daqui com o do Financeiro" → age sem perguntar.
- [ ] **Step 5:** registrar o resultado por motor; limpar `/tmp/claudinei-e2e`, as pastas e `~/.claude/projects/<pastas codificadas>`; matar só o PID da porta 9199.
