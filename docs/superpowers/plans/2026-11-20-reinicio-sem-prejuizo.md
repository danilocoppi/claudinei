# Reinício sem prejuízo — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Depois de um reinício do serviço, os terminais marcados sobem sozinhos e o trabalho interrompido é retomado (ou oferecido com um botão Continuar), sem perder tarefas encaminhadas nem travar agendamentos.

**Architecture:** Um módulo novo `server/src/restart/` guarda, por terminal (projeto + motor), os dois interruptores e a marca de interrupção numa tabela `terminal_state`. A marca é gravada no SIGINT/SIGTERM (antes do `stopAll`) e, numa queda, deduzida na subida a partir das sessões persistidas como `working`. Depois do `listen`, um executor decide o que fazer com cada terminal (função pura) e revive em lotes. Para a tarefa encaminhada, cria-se um novo ouvinte no turno retomado. A interface recebe o estado por REST e WebSocket.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 (servidor), React + zustand + i18next (web), vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-reinicio-sem-prejuizo-design.md`

## Global Constraints

- Os dois interruptores começam **desligados** em todos os terminais, existentes e novos (colunas `DEFAULT 0`).
- O teto é de **3 retomadas automáticas seguidas** sem o turno terminar.
- Os lotes da subida têm **3 terminais**, com **5000 ms** de espera entre lotes. Primeiro as retomadas, depois as subidas paradas.
- Texto do fechamento de tarefa ou execução interrompida: `interrompida pelo reinício do Claudinei`.
- Reiniciar o `claudinei.service` continua exigindo autorização expressa (AGENTS.md). Os ensaios rodam numa instância isolada na porta 9199, nunca no serviço instalado.
- Interface sem GPU (AGENTS.md): o aviso não tem animação contínua.
- Testes do servidor com Node 24: `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>`. Testes da web: `cd web && npx vitest run <arquivo>`.
- O texto mostrado ao operador sai do i18n, nas três línguas (pt-BR, en, es). O texto que vai ao agente fica em inglês, como as regras do Hermes.

## Review Focus

1. **Dois reinícios seguidos.** O serviço reinicia de novo enquanto a subida ainda está nos lotes. Os terminais que ainda não foram retomados continuam interrompidos e são tratados na subida seguinte. A marca só sai quando a mensagem de retomada é de fato enviada. Teste na Task 4.
2. **Reviver falha.** A pasta do projeto pode ter sumido, ou o motor pode recusar. O executor registra o erro, marca o terminal com `hold_reason='failed'`, fecha as tarefas dele como interrompidas e segue com os demais. Teste na Task 4.
3. **Continuar e retomada automática ao mesmo tempo.** O operador clica em Continuar no instante em que o lote ia retomar o mesmo terminal. Sai uma única mensagem de retomada. Os dois caminhos passam por `resumeTerminal`, que limpa a marca antes de enviar e desiste se ela já não existir. Teste na Task 4.
4. **Iniciar com o Claudinei sem sessão anterior.** O terminal nunca teve sessão, ou a linha foi podada. Ele sobe com `manager.start(project, { engine, continueLatest: true })`. Teste na Task 4.
5. **Agendamento atrasado no mesmo terminal.** Um disparo perdido roda no primeiro tick do agendador. Para ele não cair por cima de uma retomada em curso, o agendador só liga depois de `restart.boot()` terminar. Teste na Task 5.

---

### Task 1: Tabela `terminal_state` e o seu repositório

**Files:**
- Modify: `server/src/db.ts`: tabela nova e coluna `sessions.pending_question`, junto das demais migrações.
- Create: `server/src/restart/terminal-state.ts`
- Test: `server/test/restart-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  import type { Question } from '../claude/session.js'
  export type HoldReason = 'off' | 'question' | 'limit' | 'failed'
  export interface TerminalStateRow {
    projectId: number; engine: string
    autostart: boolean; autoResume: boolean
    interruptedAt: string | null; interruptedLocalId: string | null
    lostQuestion: Question[] | null; resumeCount: number
    holdReason: HoldReason | null   // null + interruptedAt = na fila para retomar
  }
  export interface TerminalStateDto {
    projectId: number; engine: string; autostart: boolean; autoResume: boolean
    interruption: null | { at: string; reason: HoldReason | 'queued'; question?: Question[] }
  }
  export const RESTART_FAIL_TEXT = 'interrompida pelo reinício do Claudinei'
  export function createTerminalStateStore(db: Db): {
    get(projectId: number, engine: string): TerminalStateRow      // linha ausente = padrão (tudo desligado)
    list(): TerminalStateRow[]                                     // só linhas existentes
    setPrefs(projectId: number, engine: string, p: { autostart?: boolean; autoResume?: boolean }): TerminalStateRow
    markInterrupted(projectId: number, engine: string, localId: string, question: Question[] | null): void
    setHold(projectId: number, engine: string, reason: HoldReason): void
    takeInterruption(projectId: number, engine: string): TerminalStateRow | null  // limpa a marca e devolve o que havia; null se não havia
    clearInterruption(projectId: number, engine: string): void
    bumpResume(projectId: number, engine: string): void
    resetResume(projectId: number, engine: string): void
  }
  export function toDto(row: TerminalStateRow): TerminalStateDto
  export type TerminalStateStore = ReturnType<typeof createTerminalStateStore>
  export function captureCrashed(db: Db): number   // sessões persistidas como 'working' → interrompidas; devolve quantas
  ```
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS terminal_state (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    autostart INTEGER NOT NULL DEFAULT 0,
    auto_resume INTEGER NOT NULL DEFAULT 0,
    interrupted_at TEXT, interrupted_local_id TEXT, lost_question TEXT,
    resume_count INTEGER NOT NULL DEFAULT 0, hold_reason TEXT,
    PRIMARY KEY (project_id, engine))
  ```
  Mais `ALTER TABLE sessions ADD COLUMN pending_question TEXT`, com try/catch como as outras.

- [ ] **Step 1: Escrever os testes que falham.** Em `restart-state.test.ts`, com `openDb(':memory:')` e um projeto inserido:
  - `get de terminal sem linha devolve tudo desligado`: `autostart === false`, `autoResume === false`, `interruptedAt === null`, `resumeCount === 0`.
  - `setPrefs grava só o que veio`: `setPrefs(p,'claude',{autostart:true})` e depois `{autoResume:true}` deixa os dois `true`.
  - `markInterrupted preserva prefs e contador`: depois de `bumpResume` e `markInterrupted(p,'claude','L1',[q])`, a linha tem `interruptedLocalId === 'L1'`, `lostQuestion` igual a `[q]`, `resumeCount === 1` e `holdReason === null`.
  - `takeInterruption devolve uma vez só`: a primeira chamada devolve a linha com `interruptedAt`; a segunda devolve `null`.
  - `toDto dá reason queued sem hold e o hold quando há`.
  - `captureCrashed marca sessões working com a pergunta gravada`: uma linha `sessions` com `status='working'` e `pending_question='[{"question":"Q?",...}]'` vira interrupção com `lostQuestion[0].question === 'Q?'`. Uma linha `idle` não vira. O retorno é `1`.
  - `apagar o projeto apaga o estado` (cascade).
- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run test/restart-state.test.ts`. Esperado: FAIL, módulo inexistente.
- [ ] **Step 3: Implementar** o schema em `db.ts` e `terminal-state.ts`. Os booleanos são INTEGER 0/1, `lost_question` é JSON, e um JSON inválido é lido como `null`. `markInterrupted` usa `INSERT … ON CONFLICT(project_id, engine) DO UPDATE` para gravar `interrupted_at=datetime('now')` e zerar `hold_reason`. `takeInterruption` roda numa transação.
- [ ] **Step 4: Rodar e ver passar** o arquivo e `test/db.test.ts`.
- [ ] **Step 5: Commit** `feat(reinicio): estado por terminal (interruptores e marca de interrupção)`.

### Task 2: Manager: pergunta gravada, encerramento sem falhar tarefas, ganchos

**Files:**
- Modify: `server/src/claude/manager.ts`
- Test: `server/test/manager-restart.test.ts`, com o `fake-claude.mjs` no padrão de `routes-orchestrator.test.ts`.

**Interfaces:**
- Consumes: `RESTART_FAIL_TEXT` (Task 1).
- Produces (novos membros do `SessionManager` e de `Deps`):
  ```ts
  // Deps
  onTurnResult?: (projectId: number, engine: EngineId) => void      // todo evento result
  onOperatorMessage?: (projectId: number, engine: EngineId) => void // manager.send (o que o operador digita)
  // SessionManager
  beginShutdown(): void
  isShuttingDown(): boolean
  sendAsClaudinei(localId: string, text: string): void              // session.send(text, { echoToClients: true }); não dispara onOperatorMessage
  watchTurn(localId: string, onComplete: (status: 'completed' | 'failed', result: string) => void, timeoutMs?: number): boolean  // false se a sessão não está viva
  ```
- O `dispatchTask` passa a usar `watchTurn` internamente: o ouvinte de result, status e prazo é extraído para uma função do módulo. A assinatura pública não muda.

- [ ] **Step 1: Escrever os testes que falham:**
  - `pergunta pendente vai ao banco e sai quando respondida`: depois de `faz-pergunta`, `sessions.pending_question` contém o texto da pergunta. Depois de `answerQuestion`, fica `NULL`.
  - `no encerramento, a tarefa encaminhada não fecha como falha`: com o alvo rodando `demorada`, chamar `beginShutdown()` e depois `stopAll()`. O `onComplete` do `dispatchTask` não foi chamado.
  - `no encerramento, quem espera o turno recebe o texto do reinício`: `sendAndWait(id, 'demorada')` seguido de `beginShutdown()` e `stopAll()` rejeita com uma mensagem que contém `RESTART_FAIL_TEXT`.
  - `watchTurn fecha com o result do turno`: `watchTurn(id, cb)`, depois `sendAsClaudinei(id, 'oi')`, e `cb` recebe `('completed', <resultText>)`.
  - `sendAsClaudinei não conta como mensagem do operador; send conta`: com espiões nos dois ganchos, `send` chama `onOperatorMessage(projectId,'claude')` e `sendAsClaudinei` não chama.
  - `onTurnResult dispara a cada result`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar:**
  - No handler de `status` do `wire`, gravar `pending_question = JSON.stringify(session.pendingQuestion.questions)` ou `NULL`. Fazer isso só fora do encerramento: com `shuttingDown` ligado, a coluna fica como está.
  - Em `waitForResult` e no ouvinte da tarefa, uma flag `shuttingDown` do manager decide o fim. Ligada, o `stopped` rejeita com `RESTART_FAIL_TEXT` em `waitForResult`. No ouvinte da tarefa, só limpa os ouvintes, sem chamar `onComplete`.
  - Os ganchos são chamados com try/catch, como o `onEngineUsage`.
- [ ] **Step 4: Rodar e ver passar** este arquivo, `manager.test.ts`, `routes-orchestrator.test.ts`, `ask-user-question.test.ts` e `scheduler.test.ts`.
- [ ] **Step 5: Commit** `feat(reinicio): manager guarda a pergunta e não derruba tarefas no encerramento`.

### Task 3: Captura no encerramento e varredura de tarefas e agendamentos

**Files:**
- Create: `server/src/restart/capture.ts`
- Modify: `server/src/routes/orchestrator.ts`: `registerOrchestratorRoutes` devolve também `reattach` e `failInterrupted`.
- Modify: `server/src/schedules/store.ts`: `closeInterruptedRuns(): number`.
- Modify: `server/src/tasks.ts`: `inProgressFor` e `listInProgress`.
- Test: `server/test/restart-capture.test.ts`

**Interfaces:**
- Consumes: `createTerminalStateStore` (Task 1); `beginShutdown`, `watchTurn` e `list()` do manager (Task 2).
- Produces:
  ```ts
  // capture.ts
  export function captureShutdown(manager: SessionManager, store: TerminalStateStore): number
  //   beginShutdown(); cada sessão viva com status 'working' (compactando inclusive) → markInterrupted(projectId, engine, localId, pendingQuestion?.questions ?? null)
  // orchestrator.ts — retorno passa a ser
  { drain(projectId: number): void
    reattach(taskId: number, localId: string): boolean          // watchTurn com o mesmo onComplete do drain (setResult + broadcast + drain na falha)
    failInterrupted(taskId: number): void }                     // setResult(id,'failed',RESTART_FAIL_TEXT) + broadcast
  // tasks.ts
  inProgressFor(toProjectId: number, toEngine: string): Task[]
  listInProgress(): Task[]
  // schedules/store.ts
  closeInterruptedRuns(): number  // status 'running' → 'error', error=RESTART_FAIL_TEXT, finished_at=now
  ```
  O `buildApp` repassa o objeto inteiro: `onOrchestratorReady` passa a receber `{ drain, reattach, failInterrupted }`. O `index.ts` e os testes que usam `onOrchestratorReady: (d) => { drain = d }` mudam para `(o) => { drain = o.drain }`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `captureShutdown marca só quem estava trabalhando`: uma sessão em `demorada` e outra ociosa. Depois da chamada, o store tem só a primeira interrompida, `manager.isShuttingDown() === true` e o retorno é `1`.
  - `captureShutdown leva a pergunta aberta`: com a sessão em `faz-pergunta`, `lostQuestion[0].question` é igual ao da pergunta.
  - `closeInterruptedRuns destrava o agendamento`: uma run `running` passa a `error` com `RESTART_FAIL_TEXT`, e `hasRunning(scheduleId) === false`.
  - `reattach fecha a tarefa como concluída no fim do turno`: tarefa `in_progress`, `reattach(id, localId)` e depois `sendAsClaudinei(localId,'oi')`. A tarefa termina `completed` com o resultado.
  - `failInterrupted fecha como falha com o texto do reinício`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** este arquivo, `routes-orchestrator.test.ts`, `schedules-store.test.ts` e `tasks.test.ts`.
- [ ] **Step 5: Commit** `feat(reinicio): captura no encerramento; tarefas religáveis; agendamento destravado`.

### Task 4: Decisão e execução da subida

**Files:**
- Create: `server/src/restart/boot.ts`
- Test: `server/test/restart-boot.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export const RESUME_PREFIX = '[Claudinei: resume after restart]'
  export const RESUME_TEXT = `${RESUME_PREFIX}: The Claudinei service restarted in the middle of your turn. Continue where you left off; check the current state of the files before redoing anything.`
  export const MAX_AUTO_RESUMES = 3
  export type BootAction =
    | { kind: 'resume'; projectId: number; engine: string; localId: string }
    | { kind: 'idle'; projectId: number; engine: string; localId: string | null }   // null = sem sessão anterior → start
    | { kind: 'hold'; projectId: number; engine: string; reason: HoldReason; alsoIdle: boolean; localId: string | null }
  export function planBoot(rows: TerminalStateRow[], latestLocalId: (projectId: number, engine: string) => string | null): BootAction[]
  export function createRestartService(deps: {
    db: Db; manager: SessionManager; store: TerminalStateStore
    orchestrator: () => { reattach(taskId: number, localId: string): boolean; failInterrupted(taskId: number): void } | undefined
    broadcast: (msg: object) => void          // { type: 'terminal_state', state: TerminalStateDto }
    batchSize?: number; gapMs?: number; sleep?: (ms: number) => Promise<void>
  }): {
    boot(): Promise<void>
    resumeTerminal(projectId: number, engine: string): boolean   // Continuar e retomada automática: o mesmo caminho
    dismiss(projectId: number, engine: string): void
    onOperatorMessage(projectId: number, engine: string): void   // clearInterruption + resetResume + broadcast
    onTurnResult(projectId: number, engine: string): void        // resetResume
    setPrefs(projectId: number, engine: string, p: { autostart?: boolean; autoResume?: boolean }): TerminalStateDto
    list(): TerminalStateDto[]
  }
  ```
- Regra de `planBoot`, um terminal por linha, na ordem do desenho:
  - Interrompido com `lostQuestion`: `hold` com `'question'`.
  - Interrompido, com `autoResume` e `resumeCount >= 3`: `hold` com `'limit'`.
  - Interrompido, com `autoResume` e `resumeCount < 3`: `resume`.
  - Interrompido, sem `autoResume`: `hold` com `'off'`.
  - Não interrompido e com `autostart`: `idle`.
  - No `hold`, `alsoIdle` recebe o valor de `autostart`.
  - A saída vem ordenada: todos os `resume`, depois `idle` e `hold` com `alsoIdle`. Um `hold` sem subida não ocupa lote.
- `boot()` faz, nesta ordem:
  1. `closeInterruptedRuns()`.
  2. `planBoot`, com `setHold` imediato em todo `hold`.
  3. `failInterrupted` em toda tarefa `in_progress` cujo terminal não é `resume`.
  4. Os lotes, com `sleep(gapMs)` entre eles.
  - Num `resume`: `revive(localId)`, depois `resumeTerminal`.
  - Num `idle`: `revive(localId)` ou `start(project, { engine, continueLatest: true })`.
  - Erro no `revive`/`start`: `setHold(...,'failed')`, falhar as tarefas do terminal e seguir.
  - Cada mudança de estado faz broadcast do DTO.
- `resumeTerminal`:
  1. `takeInterruption`; se der `null`, devolve `false`.
  2. Se a sessão do terminal não está viva, revive a `interruptedLocalId`.
  3. `bumpResume` só na retomada automática; o Continuar zera o contador.
  4. `sendAsClaudinei(localId, RESUME_TEXT)`.
  5. Para cada tarefa `inProgressFor(projectId, engine)`, `reattach`.
  6. Broadcast.

- [ ] **Step 1: Escrever os testes que falham.** `planBoot` puro:
  - Um teste por caso da regra.
  - `retomar ligado e contador 2 retoma; 3 segura`.
  - `ordem: resume antes de idle`.
  - `hold sem autostart não sobe`.

  Executor com o manager do fake e `sleep` falso que registra as chamadas:
  - `boot retoma e manda a mensagem do Claudinei`: o eco no broadcast traz `RESUME_PREFIX`, e `resumeCount` passa a 1.
  - `boot em lotes de 3`: 7 terminais `idle` dão `sleep` chamado 2 vezes com 5000.
  - `continuar e lote juntos mandam uma mensagem só`: `resumeTerminal` chamado duas vezes devolve `true` e depois `false`.
  - `reviver que falha vira hold failed e falha a tarefa`: projeto com a pasta removida e uma tarefa `in_progress` resultam em `holdReason === 'failed'` e tarefa `failed`.
  - `boot interrompido no meio deixa o resto marcado`: `sleep` que rejeita depois do primeiro lote; os terminais do segundo lote seguem com `interruptedAt`.
  - `autostart sem sessão anterior chama start`.
  - `onOperatorMessage limpa o aviso e zera o contador`.
  - `onTurnResult zera o contador`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(reinicio): decisão e retomada na subida, em lotes`.

### Task 5: Rotas, WebSocket e amarração no `index.ts`

**Files:**
- Create: `server/src/routes/terminals.ts`
- Modify: `server/src/app.ts`: registrar as rotas e expor o serviço de reinício por `onRestartReady`.
- Modify: `server/src/index.ts`
- Test: `server/test/restart-routes.test.ts`

**Interfaces:**
- Consumes: `createRestartService` (Task 4).
- Produces as rotas (todas com `requireProjectAccess`, e `engine` validado com `hasEngine`):
  - `GET /api/terminals/state` → `TerminalStateDto[]`, filtrado por `canAccessProject`.
  - `PATCH /api/projects/:id/terminals/:engine/restart` com corpo `{ autostart?: boolean; autoResume?: boolean }` → `TerminalStateDto`. Responde 400 se nenhum booleano vier.
  - `POST /api/projects/:id/terminals/:engine/continue` → `{ ok: true }`, ou 409 `nothing_to_continue`.
  - `DELETE /api/projects/:id/terminals/:engine/interruption` → `{ ok: true }`.
  - Mensagem de WebSocket `{ type: 'terminal_state', state: TerminalStateDto }`.
- Ordem no `index.ts`:
  1. `captureCrashed(db)` **antes** de `createSessionManager`.
  2. Os ganchos `onTurnResult` e `onOperatorMessage` do manager leem uma referência mutável preenchida por `onRestartReady`, no mesmo padrão do `drain`.
  3. Depois do `listen`: `await restart.boot()` e só então `scheduler?.start()`.
  4. No SIGINT/SIGTERM: `captureShutdown(manager, store)` **antes** de `scheduler?.stop()` e de `manager.stopAll()`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `PATCH grava e devolve o DTO`.
  - `PATCH sem booleano dá 400`.
  - `engine inválido dá 400`.
  - `usuário sem acesso ao projeto recebe 403 e não vê o terminal no GET`, no padrão de `auth-rbac.test.ts`.
  - `continue sem interrupção dá 409`.
  - `continue com interrupção revive e manda a mensagem`.
  - `DELETE limpa e faz broadcast terminal_state`.
  - `agendador liga só depois do boot`, como teste de unidade da função de arranque extraída, se o `index.ts` não for testável direto. Extrair `startAfterListen({ restart, scheduler })` para `restart/boot.ts`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte inteira do servidor.** `npx vitest run`: tudo verde, exceto o flaky conhecido do orchestrator (memória `teste-flaky-orchestrator`), que deve passar quando rodado isolado.
- [ ] **Step 5: Commit** `feat(reinicio): rotas e amarração da subida e do encerramento`.

### Task 6: Interface: interruptores, aviso e a mensagem do Claudinei

**Files:**
- Modify: `web/src/types.ts` (`TerminalState`, igual ao DTO; `ChatItem` ganha `{ kind: 'claudinei_message'; text: string; fromSubagent?: boolean; parentId?: string }`)
- Modify: `web/src/api.ts`: `fetchTerminalStates()`, `setTerminalRestart(projectId, engine, p)`, `continueTerminal(projectId, engine)`, `dismissInterruption(projectId, engine)`.
- Modify: `web/src/store.ts`
  - `terminalStates: Record<string, TerminalState>` e `setTerminalState(s)`, com chave `${projectId}:${engine}`.
  - Mensagem WS `terminal_state`.
  - Leitura inicial e a cada `progressEpoch`, a época de reconexão, num hook `useTerminalStatesSync()` montado no `App`.
- Modify: `web/src/chat/applyEvent.ts`: o prefixo `[Claudinei: resume after restart]:` vira `claudinei_message`, no mesmo molde do `[Task from …]`.
- Modify: `web/src/components/MessageBlock.tsx`: o cartão `claudinei_message` mostra só `t('chat.claudineiResume')`, com o selo "Claudinei" no estilo do `msg-bubble--task`.
- Modify: `web/src/components/SessionControls.tsx`: dois interruptores, `controls.autostart` e `controls.autoResume`, com dica, em todas as engines, logo abaixo do de avisos.
- Create: `web/src/components/InterruptedNotice.tsx`, montado no `ChatView` logo acima do `ChatInput`.
- Modify: `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts`; `web/UX-CONTRACT.md` (seção "Reinício sem prejuízo").
- Test: `web/src/test/restart-notice.test.tsx`, `web/src/test/applyEvent.test.ts` (casos novos).

**Interfaces:**
- Consumes: as rotas e a mensagem WS da Task 5; `RESUME_PREFIX` (Task 4), copiado como string no front.
- Aviso por `reason`:
  - `queued`: "Retomando o trabalho interrompido…", sem botões.
  - `off`: "O trabalho foi interrompido pelo reinício do Claudinei."
  - `question`: o mesmo texto, mais "A pergunta abaixo se perdeu" e a lista das perguntas (`question` de cada uma).
  - `limit`: "Retomado 3 vezes sem concluir; esperando você."
  - `failed`: "Não foi possível retomar sozinho."
  - Todos, menos `queued`, mostram **Continuar** e um × de fechar.

- [ ] **Step 1: Escrever os testes que falham:**
  - `applyEvent: prefixo do Claudinei vira claudinei_message`, e o mesmo texto no meio da frase segue `user_text`.
  - `cartão do Claudinei mostra o texto traduzido, não o inglês`.
  - `interruptores chamam setTerminalRestart com o motor da aba` (mock de `api`).
  - `aviso off mostra Continuar e chama continueTerminal`.
  - `aviso question lista a pergunta perdida`.
  - `aviso queued não tem botões`.
  - `× chama dismissInterruption`.
  - `mensagem WS terminal_state atualiza o store e o aviso some quando interruption vira null`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** As classes CSS seguem as variáveis de tema e o padrão de `.progress__stale` e `ReauthBanner`, sem animação.
- [ ] **Step 4: Rodar a suíte da web e o `tsc`.** `npx vitest run && npx tsc -b`: verde.
- [ ] **Step 5: Commit** `feat(reinicio): interruptores no ⚙, aviso de interrompido e mensagem do Claudinei`.

### Task 7: Ensaio de ponta a ponta numa instância isolada

**Files:** nenhum de produção. O roteiro do ensaio vai em `/tmp/claudinei-e2e/`.

- [ ] **Step 1: Subir a instância isolada na 9199**, conforme a memória `verificar-e2e-sem-reiniciar`:
  - dados em `/tmp/claudinei-e2e`;
  - `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_PKG_NATIVE -u CLAUDINEI_PKG_WEB`;
  - `node --import tsx src/index.ts`, com Node 24.
- [ ] **Step 2: Retomada com o Claude real.** Num terminal com "retomar" ligado, pedir uma tarefa de cerca de 2 minutos. Mandar SIGTERM **ao PID da porta 9199**, e subir de novo. Esperado:
  - o chat mostra o cartão do Claudinei;
  - o agente continua;
  - `resume_count` volta a 0 no fim do turno.
- [ ] **Step 3: Com "retomar" desligado.** Repetir o passo 2. Esperado: o aviso com Continuar aparece, e o clique retoma.
- [ ] **Step 4: Queda brusca e agendamento.** Repetir com SIGKILL durante uma execução de agendamento. Esperado:
  - a execução aparece como erro "interrompida pelo reinício do Claudinei";
  - o disparo seguinte do agendamento roda, e não sai como `skipped`.
- [ ] **Step 5: Tarefa encaminhada.** Encaminhar uma tarefa entre dois terminais da instância e reiniciar no meio. Esperado: a tarefa fecha `completed` depois da retomada.
- [ ] **Step 6: Parar a instância** pelo PID da porta, nunca com `pkill -f`, e registrar o resultado no relatório ao operador.
