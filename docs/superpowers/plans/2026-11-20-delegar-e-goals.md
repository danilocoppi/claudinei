# Delegar e ser acordado + Goals: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O terminal que delega uma tarefa recebe o resultado numa mensagem do Claudinei, sem precisar consultar `list_tasks`. A tarefa deixa de falhar por tempo. E `/goal <critério>` faz o terminal seguir turno após turno até o próprio agente declarar, com `goal_done`, que cumpriu o objetivo.

**Architecture:**
- **Árbitro do "próximo envio".** Um módulo novo, `server/src/next-send/`, decide o que vai à sessão quando ela fica livre. Ele consulta uma lista ordenada de *provedores*: cada provedor tem um número de posição (slot) e entrega no máximo uma mensagem. Esta trilha registra o slot 4 (aviso do resultado), o slot 5 (a fila de tarefas que já existe, via `drain`) e o slot 6 (o "continue" do goal). O slot 3, a fila do operador, vem da trilha paralela e entra na integração com uma linha.
- **Aviso do resultado** (`server/src/delegate/`). O estado de cada aviso fica na própria linha de `tasks`.
- **Goal** (`server/src/goal/`). O estado fica em colunas novas de `terminal_state`. O comando `/goal` é interceptado no `manager.send`, e a ferramenta `goal_done` é nova no Hermes.
- **Interface.** Cartões do Claudinei no chat, um aviso "A tarefa terminou", um bloco "Objetivo" na coluna de acompanhamento e um selo 🎯 no cartão da lateral.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 + `@modelcontextprotocol/sdk`/zod (servidor e Hermes); React, zustand e i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-delegar-e-goals-design.md`. Valem as decisões anexadas ao fim do desenho, inclusive a "Ordem única do próximo envio".

## Global Constraints

- **Ordem do próximo envio**, quando a sessão fica livre:
  1. auto-compactação;
  2. retomada do Claudinei (reinício/limite);
  3. fila do operador (outra trilha);
  4. aviso de resultado de tarefa delegada;
  5. tarefa de outro agente (`drain`);
  6. "continue" do goal, sempre por último.

  Os itens 1 e 2 já existem e continuam onde estão. O árbitro só roda com a sessão realmente livre: `idle`/`needs_attention`, sem compactar e sem `autoCompacting`. **Enquanto houver aviso aberto esperando o operador, os itens 3 a 6 seguram.** Aviso aberto quer dizer: interrupção com `holdReason` não nulo, ou limite ativo (`limitActive`).
- **Um envio por disponibilidade.** O árbitro para no primeiro provedor que entrega.
- **Textos ao agente** (inglês, verbatim; os selos são como a tela os reconhece):
  - `TASK_RESULT_PREFIX = '[Claudinei: task result]'`. Um item: `Task #<id> sent to <Projeto> completed|failed.` seguido do resultado. Vários: um bloco por tarefa na mesma mensagem.
  - Corte por tarefa: **4000** caracteres do resultado, terminando em `\n(full text: list_tasks #<id>)` quando cortado.
  - `GOAL_PREFIX = '[Claudinei: goal]'`, com o texto `${GOAL_PREFIX}: Continue toward the goal: <critério>. Turn <n>/20. When it is fully met, call goal_done with the evidence.`
  - `GOAL_START_PREFIX = '[Claudinei: goal start]'`, com o texto `${GOAL_START_PREFIX}: New goal: <critério>. Work toward it turn after turn. Only when it is entirely met, call goal_done with the evidence.`
- **Teto do goal:** **20** turnos (`GOAL_MAX_TURNS = 20`). Contam só turnos de origem `claudinei` (continue, aviso de resultado, retomada de reinício ou de limite) e o turno da partida. Não contam turnos de origem `task` ou `schedule`, nem a compactação.
- **Pausas do goal:**
  - `operator`: qualquer mensagem do operador que não seja `/goal`;
  - `error`: turno com erro que não é limite;
  - `limit`;
  - `interrupt`: Esc;
  - `cap`: chegou a 20 sem `goal_done`.

  Uma retomada armada do limite reativa um goal pausado por `limit`.
- **Goal esperando tarefas.** Com tarefas do próprio terminal em `queued` ou `in_progress` (`from_project_id` + `from_engine`), o slot 6 não manda nada e grava o estado `waiting`. O próximo aviso de resultado o devolve a `active`.
- **Tarefa sem prazo.** `dispatchTask` e `watchTurn` deixam de ter timeout por padrão. `askAgent` (2 min) e `sendAndWait` (30 min) seguem como hoje.
- **Quem é acordado.** O terminal `fromProjectId` + `fromEngine` da tarefa.
  - Sem `fromProjectId`: não acorda ninguém.
  - `fromEngine` nulo: vale a sessão viva mais recente do projeto; sem nenhuma, não acorda.
  - O motor de origem vale mesmo se estiver escondido (projeto 2).
- **Terminal de origem parado:**
  - com "Retomar trabalho interrompido" ligado: `bringUp` e entrega;
  - desligado: aviso com Continuar e ×.

  O × não apaga o resultado, que segue em `list_tasks`.
- **Hermes:** as instructions (`server/src/hermes/instructions.ts`, orçamento de 4096 caracteres do Claude) **não mudam**. Tudo novo vai em descrição de ferramenta (cada uma ≤ 2000 caracteres) e no texto das mensagens do Claudinei. As `developerInstructions` do Codex também não mudam.
- **Interface sem GPU** (AGENTS.md): cartões, aviso, bloco e selo sem animação. O texto ao operador vem do i18n em pt-BR, en e es.
- **Testes:**
  - servidor: `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>`;
  - web: `cd web && npx vitest run <arquivo>`;
  - tipos: `npx tsc --noEmit` no server e `npx tsc -b` na web.
- **Ensaio** só na porta **9195**, com dados em `/tmp/claudinei-e2e-delegar`. Nunca nas portas 9105, 9198 ou 9199. Sem `CLAUDINEI_HERMES_*` no ambiente. Reiniciar o `claudinei.service` exige autorização expressa (AGENTS.md).

## Review Focus

1. **Dois envios na mesma folga.** Com um resultado pendente e uma tarefa na fila para o mesmo terminal, a sessão livre recebe exatamente um envio: o aviso. A tarefa vai na folga seguinte. No Kimi e no OpenCode, um segundo envio quebraria com "turno em andamento". Teste na Task 2 (árbitro) e na Task 5 (amarrado).
2. **Goal que gira sozinho.** Não pode sair "continue":
   - depois de um turno com erro;
   - depois de um interrompido;
   - com a compactação começando;
   - com aviso aberto;
   - com tarefas delegadas em andamento.

   O teto para em 20. Testes na Task 4.
3. **Quem acordar.** Os casos:
   - tarefa criada pelo operador (sem origem);
   - `fromEngine` nulo;
   - projeto de origem apagado;
   - motor de origem escondido;
   - sessão de origem trabalhando.

   No último caso, o aviso sai no fim do turno e nunca no meio. Testes na Task 3.
4. **Reinício com aviso pendente e goal ativo.** Na subida, a retomada do reinício sai primeiro (slot 2, serviço do reinício). Aviso e continue só depois do turno dela. Com "retomar" desligado, ambos seguram até o Continuar. Teste na Task 5.
5. **Orçamento do Hermes e `goal_done` sem goal.**
   - As instructions geradas ficam idênticas às de antes.
   - Cada descrição nova cabe em 2000 caracteres.
   - `goal_done` sem objetivo ativo volta erro legível (`isError`), nunca exceção.

   Testes na Task 4.

---

### Task 1: Tarefa sem prazo e estado do aviso na linha da tarefa

**Files:**
- Modify: `server/src/db.ts`: `ALTER TABLE tasks ADD COLUMN notify TEXT`, com try/catch como as demais.
- Modify: `server/src/tasks.ts`
- Modify: `server/src/claude/manager.ts`: o prazo de `watchTurnEnd` fica opcional; `dispatchTask` e `watchTurn` ficam sem prazo por padrão.
- Modify: `server/src/hermes/run-hermes.ts`: descrições de `dispatch_task` e `list_tasks`.
- Test: `server/test/delegate-tasks.test.ts`, `server/test/hermes-mode.test.ts` (casos novos)

**Interfaces:**
- `tasks.notify`: `'pending' | 'delivered' | 'dismissed' | 'none' | NULL`. NULL vale para tarefas antigas e para as que ainda não terminaram.
- `Task` ganha `notify: TaskNotify | null`.
- `createTasksService` ganha:
  ```ts
  export type TaskNotify = 'pending' | 'delivered' | 'dismissed' | 'none'
  setNotify(ids: number[], notify: TaskNotify): void
  pendingNotifyFor(fromProjectId: number, fromEngine: string | null): Task[]   // notify='pending', ORDER BY id
  allPendingNotify(): Task[]
  openFrom(fromProjectId: number, fromEngine: string): number                   // queued + in_progress desta origem (para o goal "esperando")
  ```
- `watchTurnEnd(session, timeoutMs: number | undefined, ctx, onEnd)`: sem `timeoutMs` (ou com 0), nenhum relógio é armado.
- `dispatchTask(..., timeoutMs?: number)` e `watchTurn(localId, onComplete, timeoutMs?: number)` ficam sem prazo quando omitido.
- Descrições no Hermes:
  - `dispatch_task` termina com "You will be woken with the result in a Claudinei message when the task ends; you do not need to poll list_tasks."
  - `list_tasks` diz que serve para reler resultados completos ou ver o andamento.

- [ ] **Step 1: Escrever os testes que falham:**
  - `tarefa sem prazo: o turno longo do destino não fecha a tarefa sozinho`: relógio falso com `vi.useFakeTimers()`, 11 minutos, a tarefa segue `in_progress`.
  - `destino que morre continua fechando a tarefa como failed`.
  - `setNotify e pendingNotifyFor por origem e motor`: inclui `fromEngine` nulo.
  - `openFrom conta queued e in_progress da origem`.
  - `hermes: descrição de dispatch_task fala do aviso e cabe em 2000 caracteres`, em `hermes-mode.test.ts`, via `tools/list`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `routes-orchestrator.test.ts`, `manager-restart.test.ts`, `restart-boot.test.ts`, `limit-detect.test.ts` e `hermes-instructions.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(delegar): tarefa sem prazo e estado do aviso na tarefa`.

### Task 2: O árbitro do próximo envio e os ganchos do manager

**Files:**
- Create: `server/src/next-send/arbiter.ts`
- Modify: `server/src/claude/manager.ts`
- Modify: `server/src/index.ts`, `server/src/restart/boot.ts`, `server/src/limit/usage-limit.ts`: só ajustar aos novos formatos dos ganchos.
- Test: `server/test/next-send.test.ts`, `server/test/manager.test.ts` (caso do `onSessionAvailable` atualizado)

**Interfaces:**
- `arbiter.ts`:
  ```ts
  export interface NextSendCtx { projectId: number; engine: string; localId: string }
  /** Devolve true se entregou algo (a sessão deixa de estar livre); false para passar a vez. */
  export interface NextSendProvider { slot: number; name: string; offer(ctx: NextSendCtx): boolean }
  export function createNextSend(deps: {
    manager: Pick<SessionManager, 'isFree'>
    isHeld: (projectId: number, engine: string) => boolean   // aviso aberto esperando o operador
    defer?: (fn: () => void) => void                          // padrão setImmediate
    log?: (msg: string) => void
  }): {
    register(p: NextSendProvider): void                       // mantém a lista ordenada por slot
    onAvailable(ctx: NextSendCtx): void                       // adia com defer, reconfere isFree, consulta em ordem
    kick(projectId: number, engine: string): void             // "talvez haja algo": acha a sessão viva e roda onAvailable
  }
  export type NextSend = ReturnType<typeof createNextSend>
  ```
  Provedores com `slot` ≤ 2 nunca são registrados aqui. Com `isHeld`, só param os de slot ≥ 3. Um provedor que lança é registrado no log e passa a vez.
- Manager:
  - `onSessionAvailable?: (projectId: number, engine: EngineId, localId: string) => void`, ainda por microtask.
  - `onTurnResult?: (projectId, engine, info: { isError: boolean; origin: LimitOrigin; interrupted: boolean; limited: boolean })`.
    - `interrupted`: `subtype === 'interrupted'` ou a sessão está em `interrupting`.
    - `origin`: a origem do turno que terminou, lida antes de qualquer envio novo.
  - `isFree(localId: string): boolean`: viva, `idle`/`needs_attention`, sem `compactingSince` e sem `autoCompacting`.
  - `interceptCommand?: (ctx: NextSendCtx, text: string) => boolean`. Chamado no início de `send` para textos que começam com `/goal`. Com `true`, o manager não envia e não chama `onOperatorMessage`.
- `index.ts`:
  - O `onSessionAvailable` chama `nextSend?.onAvailable(...)` (referência mutável preenchida por `onNextSendReady`, no padrão do `drain`). Até a Task 5, o `drain` passa a ser o provedor do slot 5.
  - `restart.onTurnResult` e `limit.onTurnResult` recebem o `info` novo. Os campos a mais são ignorados por eles.

- [ ] **Step 1: Escrever os testes que falham.** Árbitro com um manager falso, `defer` síncrono:
  - `consulta os provedores em ordem de slot e para no primeiro que entrega`.
  - `com aviso aberto, slots 3 a 6 não são consultados`.
  - `sessão que deixou de estar livre no defer não recebe nada` (compactação começou).
  - `provedor que lança passa a vez e vai ao log`.
  - `kick sem sessão viva não faz nada`.
  - Manager, com o fake CLI:
    - `onSessionAvailable traz motor e localId`;
    - `onTurnResult traz origin e interrupted` (operador, `sendAsClaudinei`, tarefa, Esc);
    - `/goal é interceptado e não conta como mensagem do operador quando tratado`;
    - `isFree falso com autoCompacting`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `manager.test.ts`, `routes-orchestrator.test.ts`, `restart-boot.test.ts`, `limit-*.test.ts` e `triage-wake.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(delegar): árbitro do próximo envio e ganchos do manager`.

### Task 3: Serviço do aviso de resultado (slot 4)

**Files:**
- Create: `server/src/delegate/texts.ts`, `server/src/delegate/task-wake.ts`
- Modify: `server/src/routes/orchestrator.ts`: dep `onTaskEnded?: (taskId: number) => void`, chamada no `onTaskEnd` depois do `setResult`. `failInterrupted` também chama.
- Modify: `server/src/restart/terminal-state.ts` e `server/src/restart/boot.ts`. `TerminalStateDto` ganha `taskResults: { id: number; toProjectName: string; status: 'completed' | 'failed' }[]`, só os `pending`. O `publish` e o `list` do reinício aceitam um `decorate?: (projectId, engine) => Partial<TerminalStateDto>` injetado.
- Test: `server/test/task-wake.test.ts`

**Interfaces:**
- `texts.ts`:
  ```ts
  export const TASK_RESULT_PREFIX = '[Claudinei: task result]'
  export const TASK_RESULT_MAX = 4000
  export function taskResultText(tasks: Array<{ id: number; toProjectName: string; status: 'completed' | 'failed'; result: string | null }>): string
  ```
- `task-wake.ts`:
  ```ts
  export function createTaskWake(deps: {
    db: Db; manager: SessionManager; store: TerminalStateStore
    restart: Pick<RestartService, 'bringUp' | 'publish'>
    nextSend: () => NextSend | undefined
    log?: (msg: string) => void
  }): {
    provider: NextSendProvider                  // slot 4
    onTaskEnded(taskId: number): void           // marca pending (ou none) e tenta entregar segundo as regras
    continueNow(projectId: number, engine: string): boolean   // aviso "A tarefa terminou" → bringUp + entrega; false se nada pendente
    dismiss(projectId: number, engine: string): void          // pending → dismissed; publica
    decorate(projectId: number, engine: string): Pick<TerminalStateDto, 'taskResults'>
    boot(): Promise<void>                       // pendentes da vez anterior voltam às mesmas regras
  }
  ```
  - **Resolução do terminal de origem.** Sem `fromProjectId`: `none`. Com `fromEngine` nulo: o motor da sessão viva mais recente do projeto; sem nenhuma: `none`.
  - **Entrega por estado da sessão de origem:**
    - viva e livre: `nextSend.kick`;
    - trabalhando: espera o `onAvailable`;
    - parada: com `autoResume` do terminal ligado, `bringUp` e `sendAsClaudinei` direto, porque a sessão revivida fica em `starting` e não dispara `onSessionAvailable`; desligado, só publica (o aviso aparece);
    - em limite: segura e publica (a contagem aparece no aviso do limite).
  - O provedor entrega **todas** as pendentes do terminal numa mensagem e marca `delivered`.

- [ ] **Step 1: Escrever os testes que falham.** Fake CLI, dois projetos e `buildApp` montado só com o necessário:
  - `tarefa encaminhada que termina acorda o terminal de origem livre com o resultado`.
  - `origem trabalhando: o aviso sai no fim do turno, não no meio`.
  - `origem parada com retomar ligado: revive e entrega`.
  - `origem parada com retomar desligado: taskResults no DTO e nada enviado; continueNow entrega`.
  - `dismiss tira do DTO e o resultado segue em list_tasks`.
  - `origem em limite: segura; limite limpo → entrega na próxima folga`.
  - `várias pendentes saem numa mensagem só, uma por bloco`.
  - `resultado de 5000 caracteres é cortado em 4000 com o rodapé`.
  - `tarefa sem origem não acorda ninguém; fromEngine nulo usa a sessão viva mais recente`.
  - `motor de origem escondido recebe o aviso mesmo assim`.
  - `boot: pendentes da vez anterior seguem as mesmas regras`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `routes-orchestrator.test.ts`, `restart-*.test.ts` e `terminal-state*.test.ts`.
- [ ] **Step 5: Commit** `feat(delegar): o terminal que delegou é acordado com o resultado`.

### Task 4: Goals: estado, comando, laço (slot 6) e `goal_done`

**Files:**
- Modify: `server/src/db.ts`: colunas `goal_criterion TEXT`, `goal_status TEXT`, `goal_pause_reason TEXT`, `goal_turns INTEGER NOT NULL DEFAULT 0`, `goal_evidence TEXT` e `goal_started_at TEXT` em `terminal_state`.
- Modify: `server/src/restart/terminal-state.ts`: campos na linha, métodos no store e `goal` no DTO.
- Create: `server/src/goal/texts.ts`, `server/src/goal/goal.ts`
- Modify: `server/src/hermes/run-hermes.ts`: ferramenta `goal_done`.
- Modify: `server/src/routes/hermes.ts`: `POST /api/hermes/goal-done`.
- Test: `server/test/goal.test.ts`, `server/test/hermes-mode.test.ts`, `server/test/hermes-instructions.test.ts` (caso novo)

**Interfaces:**
- Store:
  ```ts
  export type GoalStatus = 'active' | 'waiting' | 'paused' | 'cap' | 'done'
  export type GoalPause = 'operator' | 'error' | 'limit' | 'interrupt'
  startGoal(projectId: number, engine: string, criterion: string): void   // turns=0, active, evidence=null
  setGoalStatus(projectId: number, engine: string, status: GoalStatus, pause?: GoalPause | null): void
  bumpGoalTurn(projectId: number, engine: string): number
  finishGoal(projectId: number, engine: string, evidence: string): void
  clearGoal(projectId: number, engine: string): void
  ```
  O DTO ganha `goal: null | { criterion: string; status: GoalStatus; pause: GoalPause | null; turns: number; max: 20; evidence: string | null }`.
- `goal.ts`:
  ```ts
  export function createGoalService(deps: {
    db: Db; manager: SessionManager; store: TerminalStateStore
    restart: Pick<RestartService, 'publish'>
    log?: (msg: string) => void
  }): {
    provider: NextSendProvider                       // slot 6
    command(ctx: NextSendCtx, text: string): boolean // '/goal <c>' | '/goal resume' | '/goal stop'; true = tratado
    onTurnResult(projectId: number, engine: string, info: { isError: boolean; origin: LimitOrigin; interrupted: boolean; limited: boolean }): void
    onOperatorMessage(projectId: number, engine: string): void
    done(projectId: number, engine: string, evidence: string): { ok: true } | { ok: false; error: string }
    onTaskResultDelivered(projectId: number, engine: string): void   // waiting → active
  }
  ```
  - **`/goal <critério>`:** inicia ou substitui. Grava o goal **antes** de mandar a partida pelo `manager.send` com o `GOAL_START` texto, com uma marca interna que impede o próprio `onOperatorMessage` de pausar. O critério vazio, ou acima de 2000 caracteres, recusa com `UserError('goal_invalid')`.
  - **`/goal resume`:** turnos voltam a 0, estado `active`, e a sessão recebe um `kick`.
  - **`/goal stop`:** `clearGoal`.
  - **Contagem:** no fim de turno com goal `active` ou `waiting`, turno de origem `claudinei` ou o turno da partida faz `bumpGoalTurn`. Em 20 sem `done`: `cap`.
  - **Pausas:**
    - `interrupted` pausa com `interrupt`;
    - `limited` pausa com `limit`;
    - `isError` pausa com `error`;
    - `onOperatorMessage` pausa com `operator`.
  - **Limite armado:** um turno sem erro de origem `claudinei` com o goal pausado por `limit` volta a `active` e conta.
  - **O provedor:**
    - só oferece com goal `active`;
    - com `openFrom(...) > 0`, grava `waiting` e passa a vez;
    - senão, manda o continue com o turno n+1 e devolve true.
- Hermes, `goal_done`:
  - entrada: `{ evidence: string }`, de até 4000 caracteres;
  - descrição: só o agente principal chama; só quando o objetivo está inteiramente cumprido; a evidência é concreta (comandos, resultados);
  - chama `POST /api/hermes/goal-done` com `{ projectId, engine, evidence }`;
  - erro 409 `no_active_goal` vira `isError` com texto legível.
- A rota usa `requireProjectAccess`, como `/api/hermes/progress`.

- [ ] **Step 1: Escrever os testes que falham.** Fake CLI, `next-send` real e `defer` síncrono:
  - `/goal inicia, manda a partida e não pausa a si mesmo`.
  - `fim de turno com goal ativo manda o continue com Turn n/20`.
  - `goal_done encerra o laço: nenhum continue depois`.
  - `teto: 20 turnos sem goal_done → cap, sem continue`.
  - `pausas: operador, erro, Esc e limite não mandam continue`.
  - `/goal resume volta a 0 e continua; /goal stop limpa`.
  - `turno de tarefa de outro agente ou de agendamento não conta`.
  - `goal esperando tarefas delegadas não manda continue; o aviso do resultado conta e o laço volta`.
  - `aviso pendente e goal no mesmo fim de turno: sai só o aviso`.
  - `limite armado que retoma reativa o goal e conta o turno`.
  - `goal_done sem goal ativo: erro legível`.
  - Hermes:
    - `goal_done chama a rota com projeto e motor`;
    - `descrição de goal_done ≤ 2000`;
    - `instructions do Hermes idênticas às de antes da trilha` (comparar com `buildInstructions` para a mesma entrada).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `hermes-*.test.ts`, `restart-*.test.ts` e `limit-*.test.ts`.
- [ ] **Step 5: Commit** `feat(goal): /goal com laço até goal_done, teto e pausas`.

### Task 5: Rotas e amarração

**Files:**
- Modify: `server/src/app.ts`
  - cria o `nextSend` e registra os provedores `taskWake.provider` (4), o do `drain` (5) e `goal.provider` (6);
  - passa o `decorate` ao reinício;
  - liga `onTaskEnded`;
  - expõe `onNextSendReady`, `onTaskWakeReady` e `onGoalReady`.
- Modify: `server/src/index.ts`
  - `onSessionAvailable` vai ao `nextSend`;
  - `onTurnResult` e `onOperatorMessage` vão também ao goal;
  - `interceptCommand` vai ao `goal.command`;
  - `startAfterListen` ganha `taskWake.boot()` depois do limite e antes do agendador.
- Modify: `server/src/restart/boot.ts`: `startAfterListen` aceita `taskWake?: { boot(): Promise<void> }`.
- Modify: `server/src/routes/terminals.ts`:
  - `POST /api/projects/:id/terminals/:engine/task-results/continue`: 409 `nothing_to_continue` sem pendentes, 409 `shutting_down` no encerramento;
  - `DELETE /api/projects/:id/terminals/:engine/task-results`.
- Test: `server/test/delegate-routes.test.ts`

**Interfaces:**
- O provedor do slot 5 só chama `drain(projectId)` e devolve `true` se o `drain` entregou uma tarefa. Para isso, o `drain` passa a devolver `boolean`. `OrchestratorHooks.drain` passa a ser `(projectId: number) => boolean`, e os chamadores atuais ignoram o retorno.
- O goal pausa por limite pelo `info.limited` do `onTurnResult`, sem gancho próprio no `onUsageLimit`.
- O `isHeld` do árbitro usa `store.get` + `limitActive`. Retém com interrupção de `holdReason` não nulo, ou com limite ativo.

- [ ] **Step 1: Escrever os testes que falham:**
  - `amarrado: resultado pendente + tarefa na fila → sai só o aviso; a tarefa vai na próxima folga`.
  - `amarrado: delegar e ser acordado entre dois terminais pelo dispatch HTTP`.
  - `rotas de task-results: continue entrega; sem pendentes 409; DELETE dispensa; acesso por projeto 403`.
  - `subida com aviso pendente e goal ativo: a retomada do reinício vai primeiro; aviso e continue só depois do turno dela`.
  - `com retomar desligado, aviso e continue seguram até o Continuar`.
  - `startAfterListen: reinício → limite → aviso de tarefas → agendador`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte inteira do servidor** e `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(delegar): amarração do árbitro, do aviso e do goal`.

### Task 6: Interface: cartões do Claudinei e aviso "A tarefa terminou"

**Files:**
- Modify: `web/src/types.ts`
  - `ChatItem` `claudinei_message.reason` ganha `'task_result' | 'goal' | 'goal_start'`;
  - `TerminalState` ganha `taskResults` e `goal`.
- Modify: `web/src/chat/applyEvent.ts`: reconhece os três selos novos.
- Modify: `web/src/components/MessageBlock.tsx`
  - `task_result`: cartão "Resultado de tarefa" com a lista, cada item com #id, projeto e estado, e o corpo em markdown dobrável;
  - `goal`: cartão "Objetivo · turno n/20";
  - `goal_start`: cartão "Objetivo definido" com o critério.
- Create: `web/src/components/TaskResultNotice.tsx`, montado no `ChatView` com os outros avisos.
- Modify: `web/src/api.ts`: `continueTaskResults` e `dismissTaskResults`.
- Modify: `web/src/components/EngineTabs.tsx`: um motor escondido com `taskResults.length > 0` ganha aba.
- Modify: `web/src/components/UsageLimitNotice.tsx`: "N resultado(s) de tarefa esperando" quando houver.
- Modify: `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts`.
- Test: `web/src/test/delegate-cards.test.tsx`, `web/src/test/applyEvent.test.ts` (casos novos)

- [ ] **Step 1: Escrever os testes que falham:**
  - `selo de resultado vira claudinei_message task_result; no meio da frase segue user_text`.
  - `selos de goal e goal start viram os cartões traduzidos`.
  - `forma ao vivo (content em array de blocos) também é reconhecida`.
  - `TaskResultNotice: só aparece com pendentes e sessão sem processo de pé; Continuar chama a API; × dispensa`.
  - `erro do Continuar aparece no aviso`.
  - `aba de motor escondido com resultado pendente`.
  - `aviso do limite mostra a contagem de resultados esperando`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** Seletores estreitos (`terminalStates[key]`), sem animação, no padrão de `InterruptedNotice`.
- [ ] **Step 4: Rodar e ver passar** a suíte da web e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(delegar): cartões do Claudinei e aviso de resultado na tela`.

### Task 7: Interface do goal: bloco na coluna, aviso de pausa, selo e `/goal`

**Files:**
- Modify: `web/src/components/ProgressColumn.tsx`
  - bloco "Objetivo" no topo quando `goal != null`: critério, "turno n/20", estado (ativo, esperando tarefas, pausado com o motivo, teto, cumprido) e evidência quando cumprido;
  - a coluna mostra o bloco mesmo sem acompanhamento do agente.
- Create: `web/src/components/GoalNotice.tsx`
  - com o goal `paused` ou `cap`: o motivo e **Retomar**, que manda `/goal resume` pelo WebSocket como `send_message`, e **Encerrar** (`/goal stop`);
  - montado no `ChatView`.
- Modify: `web/src/components/Sidebar.tsx`: `GoalCardMarker` memoizado, com o seletor devolvendo só `{turns, status}` de algum motor do projeto. Fica junto dos marcadores de interrupção e de limite, como selo estático "🎯 n/20".
- Modify: `web/src/slash.ts`: `goal` em `BUILTIN_FALLBACK` e em `SLASH_DESCRIPTIONS`, para todos os motores.
- Modify: `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts`; `UX-CONTRACT.md` (seção "Delegar e goals").
- Test: `web/src/test/goal-ui.test.tsx`

- [ ] **Step 1: Escrever os testes que falham:**
  - `bloco Objetivo mostra critério, turno e estado; evidência quando cumprido`.
  - `GoalNotice pausado: Retomar manda /goal resume; Encerrar manda /goal stop`.
  - `selo 🎯 n/20 no cartão; some com goal null; sem animação (sem classe de pulso)`.
  - `mudança de outro terminal não re-renderiza o cartão`, com um teste de Profiler no padrão de `perf-render.test.tsx`.
  - `/goal aparece no autocomplete`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** a suíte da web e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(goal): objetivo na coluna, aviso de pausa e selo na lateral`.

### Task 8: Ensaio de ponta a ponta na instância isolada (porta 9195)

**Files:** nenhum de produção. O roteiro vai em `/tmp/claudinei-e2e-delegar/`.

- [ ] **Step 1: Subir a instância**, com a regra comum das trilhas:
  - `npm run build -w web` antes;
  - `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_PKG_NATIVE -u CLAUDINEI_PKG_WEB`;
  - `CLAUDINEI_PORT=9195`, dados em `/tmp/claudinei-e2e-delegar`, `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs`.
- [ ] **Step 2: Delegar e ser acordado.** Dois terminais, A e B.
  - A delega a B pelo `POST /api/orchestrator/dispatch` com `fromProjectId`/`fromEngine`, com B em `demorada`.
  - Termina o turno de B.
  - Esperado: A recebe a mensagem com o selo `[Claudinei: task result]`, e na tela aparece o cartão "Resultado de tarefa".
  - Repetir com A trabalhando: o aviso só sai no fim do turno de A.
  - Repetir com A parado e "retomar" desligado: aparece o aviso com Continuar.
- [ ] **Step 3: Sem prazo.** Uma tarefa em `demorada` passa de 10 minutos e segue `in_progress` (ajustar o relógio só no teste unitário). No ensaio, basta conferir que nada fecha aos 10 minutos.
- [ ] **Step 4: Goal.**
  - `/goal <critério>` num terminal: os continues saem com "Turn n/20".
  - `goal_done` simulado pelo `POST /api/hermes/goal-done` com o token de serviço: o laço para e o bloco mostra "cumprido".
  - Outro goal até o teto, com relógio real e o fake respondendo rápido: termina em `cap`, com o aviso "Retomar".
  - Opcional: um ensaio com o Claude real (`model: 'haiku'`) e um critério trivial, para ver o `goal_done` chamado pelo próprio agente.
- [ ] **Step 5: Capturas** do cartão, do aviso, do bloco e do selo (Playwright).
- [ ] **Step 6: Parar** pelo PID da porta 9195, conferindo que não é o da 9105. Apagar `/tmp/claudinei-e2e-delegar` e as pastas `~/.claude/projects/-tmp-…` do ensaio.
