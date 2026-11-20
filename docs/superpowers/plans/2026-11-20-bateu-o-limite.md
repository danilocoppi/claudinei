# Bateu o limite — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando o Claude bate no limite de uso, o terminal mostra um aviso com "Continuar quando reabrir", "Adiar até reabrir" e "Continuar agora"; uma retomada armada (por clique ou pelo interruptor do terminal, desligado por padrão) manda uma mensagem fixa do Claudinei quando a janela reabre.

**Architecture:** A sessão do Claude detecta o limite (o `rate_limit_event` rejeitado e o texto do erro) e o manager o repassa com a origem do turno. Um serviço novo, `server/src/limit/usage-limit.ts`, guarda o estado nas colunas `limit_*` de `terminal_state` (projeto 1). Ele arma um relógio no servidor, rearmado na subida, e na reabertura retoma em lotes reaproveitando o `bringUp` do serviço de reinício. A interface ganha um aviso próprio, uma marca no cartão da lateral e um interruptor no ⚙.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 (servidor); React, zustand e i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-bateu-o-limite-design.md`. Valem também as decisões anexadas ao fim do desenho.

## Global Constraints

- **Motor:** só o Claude é detectado nesta versão.
- **Interruptor:** "Continuar sozinho quando o limite reabrir" é por terminal (projeto + motor) e vem **desligado** (`auto_resume_limit INTEGER NOT NULL DEFAULT 0`).
- **Folga:** a retomada dispara **60 s** depois do `resetsAt`.
- **Teto:** **uma tentativa automática por janela** (`limit_tries`). A segunda só com clique, e `limit_tries` zera quando um turno termina sem erro.
- **Lotes:** **3** terminais por lote, com **5000 ms** de espera entre lotes, como no projeto 1.
- **Texto ao agente** (fixo, em inglês, verbatim): `[Claudinei: resume after usage limit]: The usage limit window reopened. Continue where you left off; check the current state of the files before redoing anything.`
- **Texto de falha:**
  - para tarefa encaminhada, `ask_agent` e agendamento: `limite de uso do Claude — a janela reabre às HH:MM`, com a hora local do servidor em 24 h;
  - sem horário conhecido: `limite de uso do Claude`.
- **Agendamento** que bate no limite vira `error` com `countFailure: false` e não tenta de novo na reabertura.
- **Horário desconhecido ou já passado:** não arma retomada nem adia. Só o aviso, com "Continuar agora" e ×.
- **Origem do turno:** `operator` | `schedule` | `task` | `claudinei`. O interruptor só arma sozinho quando a origem é `operator` ou `claudinei`.
- **Turno sem erro:** qualquer turno que termina sem erro limpa o estado de limite e desarma o relógio.
- **Mensagem do operador** pelo campo também limpa o estado.
- **Reinício e limite juntos:** a marca do reinício é absorvida pelo limite. Nunca saem duas mensagens de retomada na mesma janela.
- **Interface sem GPU** (AGENTS.md): o aviso e a marca do cartão não têm animação. O texto ao operador vem do i18n em pt-BR, en e es.
- **Testes:**
  - servidor: `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>`;
  - web: `cd web && npx vitest run <arquivo>`.
- **Ensaio** só na porta **9195**, com dados em `/tmp/claudinei-e2e-limite`. Nunca nas portas 9105, 9198 ou 9199. Reiniciar o `claudinei.service` exige autorização expressa (AGENTS.md).

### O texto real do limite (conferido nos transcripts locais, só a frase)

O CLI grava um `assistant` sintético com `isApiErrorMessage: true`, `error: 'rate_limit'` e `apiErrorStatus: 429`. O texto tem uma destas formas:

- `You've hit your session limit · resets 3:40pm (America/Sao_Paulo)`
- `You've hit your weekly limit · resets Nov 16, 9pm (America/Sao_Paulo)`
- `Usage limit reached` / `usage limit reached`

A detecção casa `/You've hit your [a-z ]*limit|usage limit reached/i`, ou um `raw.error === 'rate_limit'`. O horário vem do `rate_limit_event`; o texto do "resets" não é interpretado.

## Review Focus

1. **Segundos e milissegundos.** O `resetsAt` do `rate_limit_info` vem em **epoch segundos**, e um relógio armado em ms × 1000 nunca dispara. Teste na Task 4, com um `now` falso.
2. **A retomada bate no limite de novo.** O aviso volta em `none` e nada é rearmado sozinho, mesmo com o interruptor ligado (`limit_tries` ≥ 1). Teste na Task 4.
3. **Serviço reiniciado com uma retomada armada.** Na subida, uma retomada armada que já passou da hora dispara nos lotes, e uma futura rearma o relógio. Teste na Task 4.
4. **Limite detectado só pelo texto, sem `rate_limit_event`.** O horário cai para o `lastRejectedResetsAt()` do uso. Se nem ele existe, `resetsAt` fica `null`, e armar ou adiar responde 409 `reset_unknown`. Testes nas Tasks 2 e 5.
5. **Tarefa encaminhada e agendamento no mesmo turno limitado.** Fecham na hora com o texto de falha, e a execução do agendamento não conta falha seguida. Testes na Task 2.

---

### Task 1: Colunas `limit_*` em `terminal_state` e o DTO

**Files:**
- Modify: `server/src/db.ts`: `ALTER TABLE terminal_state ADD COLUMN` para cada coluna, com try/catch como as demais.
- Modify: `server/src/restart/terminal-state.ts`
- Test: `server/test/limit-state.test.ts`

**Interfaces:**
- Colunas novas:
  - `limit_hit_at TEXT`
  - `limit_resets_at INTEGER`, em epoch segundos
  - `limit_action TEXT NOT NULL DEFAULT 'none'`
  - `limit_origin TEXT`
  - `limit_tries INTEGER NOT NULL DEFAULT 0`
  - `auto_resume_limit INTEGER NOT NULL DEFAULT 0`
- Produces:
  ```ts
  export type LimitAction = 'none' | 'armed' | 'snoozed'
  export type LimitOrigin = 'operator' | 'schedule' | 'task' | 'claudinei'
  // TerminalStateRow ganha:
  autoResumeLimit: boolean; limitHitAt: string | null; limitResetsAt: number | null
  limitAction: LimitAction; limitOrigin: LimitOrigin | null; limitTries: number
  // TerminalStateDto ganha:
  autoResumeLimit: boolean
  usageLimit: null | { hitAt: string; resetsAt: number | null; action: LimitAction; origin: LimitOrigin }
  // store ganha:
  recordUsageLimit(projectId: number, engine: string, p: { resetsAt: number | null; origin: LimitOrigin }): TerminalStateRow  // hit_at=now, action='none'
  setLimitAction(projectId: number, engine: string, action: LimitAction): void
  takeLimit(projectId: number, engine: string): TerminalStateRow | null   // transação: devolve e limpa hit/resets/action/origin; null se não havia
  clearLimit(projectId: number, engine: string): void
  bumpLimitTries(projectId: number, engine: string): void
  resetLimitTries(projectId: number, engine: string): void
  listArmed(): TerminalStateRow[]
  setPrefs(projectId, engine, p: { autostart?: boolean; autoResume?: boolean; autoResumeLimit?: boolean })   // estende a existente
  ```
- Regra do `usageLimit` no `toDto`: preenchido sempre que `limitHitAt != null`. `limitAction` inválido no banco é lido como `none`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `terminal sem linha: sem limite e interruptor do limite desligado`.
  - `recordUsageLimit grava hora, reabertura e origem sem tocar no reinício`: os campos de interrupção e `resumeCount` não mudam.
  - `takeLimit devolve uma vez só`.
  - `listArmed só devolve os armados`.
  - `setPrefs com autoResumeLimit não mexe nos outros interruptores`.
  - `toDto: usageLimit null sem limite; com limite traz resetsAt em segundos`.
  - `limit_tries sobrevive a recordUsageLimit e zera com resetLimitTries`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `restart-state.test.ts` e `restart-routes.test.ts`, que usam o DTO.
- [ ] **Step 5: Commit** `feat(limite): estado do limite de uso por terminal`.

### Task 2: Detecção na sessão do Claude, origem no manager e fechamento de quem espera

**Files:**
- Create: `server/src/limit/texts.ts`
- Modify: `server/src/usage.ts`: exportar `rateLimitWindows`, que é o `windowsOf` renomeado, e acrescentar `lastRejectedResetsAt()` ao `UsageService`.
- Modify: `server/src/claude/session.ts`: `detectUsageLimit`, ao lado do `detectAuthExpired`.
- Modify: `server/src/claude/manager.ts`
- Modify: `server/src/schedules/scheduler.ts`: o catch passa a reconhecer o texto do limite.
- Modify: `server/test/fake-claude.mjs`: modos `limite` e `limite-sem-evento`.
- Test: `server/test/limit-detect.test.ts`

**Interfaces:**
- `server/src/limit/texts.ts`:
  ```ts
  export const LIMIT_RESUME_PREFIX = '[Claudinei: resume after usage limit]'
  export const LIMIT_RESUME_TEXT = `${LIMIT_RESUME_PREFIX}: The usage limit window reopened. Continue where you left off; check the current state of the files before redoing anything.`
  export const USAGE_LIMIT_FAIL_PREFIX = 'limite de uso do Claude'
  export function usageLimitFailText(resetsAt: number | null): string   // "limite de uso do Claude — a janela reabre às 15:00" | "limite de uso do Claude"
  export const LIMIT_TEXT_RE = /You've hit your [a-z ]*limit|usage limit reached/i
  ```
- `usage.ts`:
  - `export function rateLimitWindows(info: unknown)`, com o mesmo retorno do `windowsOf` atual.
  - `lastRejectedResetsAt(): number | null`: o maior `resetsAt`, em segundos e ainda no futuro, entre as janelas cuja severidade é `critical`.
- `ClaudeSession`:
  - `get usageLimit(): { resetsAt: number | null } | undefined`.
  - Um `rate_limit_event` com alguma janela `rejected` guarda o maior `resetsAt` como pendente.
  - Um `assistant` com `isApiErrorMessage` (ou `raw.error === 'rate_limit'`), ou um `result` com `isError`, cujo texto casa `LIMIT_TEXT_RE`, liga o limite usando o horário pendente.
  - Um `result` com `isError` e horário pendente também liga o limite.
  - Tudo zera no `send`, como o `authExpiredFlag`.
- `EngineSession` (`engine/types.ts`): `readonly usageLimit?: { resetsAt: number | null }`.
- Manager:
  - Deps novas:
    - `onUsageLimit?(projectId: number, engine: EngineId, p: { localId: string; resetsAt: number | null; origin: LimitOrigin }): void`
    - `lastRejectedResetsAt?: () => number | null`
  - `onTurnResult` passa a ser `(projectId, engine, info: { isError: boolean })`. Atualizar o chamador de hoje, o `restart.onTurnResult`, que ignora o `info`.
  - Cada entrada viva guarda `origin: LimitOrigin`, a origem da última mensagem: `send` é `operator`, `sendAsClaudinei` é `claudinei`, `dispatchTask` e `askAgent` são `task`, `sendAndWait` é `schedule`.
  - Num `result` com `session.usageLimit`, chamar `onUsageLimit` **antes** de `onTurnResult`. O `resetsAt` é o da sessão ou, se `null`, o de `deps.lastRejectedResetsAt?.()`.
  - `TurnEnd` de `result` ganha `limited?: { resetsAt: number | null }`, lido de `session.usageLimit` no momento do result.
  - Com o turno limitado:
    - `waitForResult` rejeita com `usageLimitFailText(resetsAt)`;
    - `watchTask` fecha `failed` com o mesmo texto.
- Scheduler: no catch, `message.startsWith(USAGE_LIMIT_FAIL_PREFIX)` grava `finishRun(run.id, { status: 'error', error: message, countFailure: false })`.
- Modos do fake:
  - `limite` emite `rate_limit_event` com `rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: <agora+60 s>, utilization: 1 }`, depois `assistant` com `isApiErrorMessage: true` e o texto `You've hit your session limit · resets 3:40pm (America/Sao_Paulo)`, depois `result` com `is_error: true` e o mesmo texto.
  - `limite-sem-evento` emite o mesmo, sem o `rate_limit_event`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `limite com evento: onUsageLimit recebe resetsAt do evento e origem operator`.
  - `limite só pelo texto: resetsAt vem de lastRejectedResetsAt`.
  - `limite só pelo texto e sem horário conhecido: resetsAt null`.
  - `origem: tarefa encaminhada → task; sendAsClaudinei → claudinei; agendamento → schedule`.
  - `tarefa encaminhada que bate no limite fecha failed com o texto do limite e a hora`.
  - `ask_agent recebe o texto do limite como erro`.
  - `agendamento que bate no limite: error sem contar falha seguida` (no padrão do teste do `RESTART_FAIL_TEXT` em `scheduler.test.ts`).
  - `turno comum não liga o limite; o limite zera no send seguinte`.
  - `onTurnResult recebe isError`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `manager-restart.test.ts`, `routes-orchestrator.test.ts`, `scheduler.test.ts`, `usage.test.ts`, `restart-boot.test.ts`, e depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(limite): detecção do limite do Claude e fechamento de quem esperava`.

### Task 3: Reinício: absorver a marca e expor o `bringUp`

**Files:**
- Modify: `server/src/restart/boot.ts`
- Test: `server/test/restart-boot.test.ts` (casos novos)

**Interfaces:**
- `planBoot(rows, latestLocalId, now = Date.now())`: uma interrupção com limite ativo é **pulada**, e não vira `resume`, `idle` nem `hold`. Limite ativo é `limitHitAt != null` e `limitResetsAt == null` ou `limitResetsAt * 1000 > now`. A retomada fica com o serviço do limite. A marca é absorvida na subida pelo `boot()`, com `clearInterruption`, e as tarefas anotadas fecham como no `dismiss`.
- O retorno de `createRestartService` ganha:
  - `bringUp(projectId: number, engine: string, preferred: string | null): string`, a função interna de hoje, agora exposta;
  - `absorbInterruption(projectId: number, engine: string): void`, que é `dropInterruption` + `publish` e não faz nada durante o encerramento;
  - `publish(projectId: number, engine: string): TerminalStateDto`, exposta para o serviço do limite publicar no mesmo formato.

- [ ] **Step 1: Escrever os testes que falham:**
  - `planBoot pula interrupção com limite futuro`.
  - `planBoot retoma normalmente se o limite já reabriu`.
  - `boot absorve a marca do terminal limitado e fecha as tarefas anotadas`.
  - `absorbInterruption não faz nada durante o encerramento`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** os arquivos `restart-*.test.ts`.
- [ ] **Step 5: Commit** `feat(limite): o reinício cede ao limite de uso`.

### Task 4: Serviço do limite: estado, relógio, lotes e retomada

**Files:**
- Create: `server/src/limit/usage-limit.ts`
- Test: `server/test/limit-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1 a 3.
- Produces:
  ```ts
  export function createUsageLimitService(deps: {
    manager: SessionManager; store: TerminalStateStore
    restart: Pick<RestartService, 'bringUp' | 'absorbInterruption' | 'publish'>
    now?: () => number; graceMs?: number                     // 60_000
    setTimer?: (fn: () => void, ms: number) => { clear(): void }
    batchSize?: number; gapMs?: number; sleep?: (ms: number) => Promise<void>
    log?: (msg: string) => void
  }): {
    onUsageLimit(projectId: number, engine: string, p: { localId: string; resetsAt: number | null; origin: LimitOrigin }): void
    arm(projectId: number, engine: string): void        // UserError 'no_usage_limit' | 'reset_unknown'
    snooze(projectId: number, engine: string): void     // idem
    cancel(projectId: number, engine: string): void     // armed/snoozed → none; 'no_usage_limit'
    continueNow(projectId: number, engine: string): boolean   // manual; UserError 'session_busy' se trabalhando
    onOperatorMessage(projectId: number, engine: string): void   // clearLimit + desarma + publish
    onTurnResult(projectId: number, engine: string, info: { isError: boolean }): void  // sem erro: clearLimit + resetLimitTries + desarma + publish
    boot(): Promise<void>                                // rearma; vencidos disparam em lotes
    dispose(): void
  }
  export type UsageLimitService = ReturnType<typeof createUsageLimitService>
  ```
- Regras:
  - **`onUsageLimit`**, nesta ordem:
    1. `restart.absorbInterruption`;
    2. `recordUsageLimit`;
    3. se `autoResumeLimit`, origem `operator` ou `claudinei`, `limitTries === 0` e `resetsAt` no futuro: `setLimitAction('armed')` e arma o relógio;
    4. `publish`.
  - **Relógio:** um único `setTimer` para o próximo vencimento (`resetsAt * 1000 + graceMs`), rearmado a cada mudança.
  - **Ao vencer:** junta todos os armados vencidos e os processa em lotes de `batchSize`, com `sleep(gapMs)` entre eles. Cada um vai por `resumeAfterLimit(projectId, engine, { auto: true })`.
  - **`resumeAfterLimit`** (interno, usado também pelo `continueNow`):
    1. Durante o encerramento, devolve `false`.
    2. Com a sessão viva `working` ou compactando:
       - no automático, volta a `none` (o aviso continua) e publica;
       - no manual, lança `session_busy`.
    3. `restart.bringUp`.
    4. `takeLimit`; se der `null`, devolve `false`.
    5. `bumpLimitTries` só no automático.
    6. `manager.sendAsClaudinei(localId, LIMIT_RESUME_TEXT)`.
    7. Se o envio falhar, `recordUsageLimit` de novo com `none`, `publish` e relança.
  - **`snoozed` vence:** `clearLimit` e `publish`, sem enviar nada.
  - **`boot`:** `listArmed()` mais os `snoozed` vencidos. Os vencidos são processados na hora, em lotes. Os futuros armam o relógio.

- [ ] **Step 1: Escrever os testes que falham** (com o manager do fake, `now` e `setTimer` falsos e `sleep` que registra):
  - `limite sem interruptor: aviso em none, nada armado`.
  - `interruptor ligado e origem operator: arma sozinho para resetsAt+60s`; o timer pedido tem ms = `(resetsAt*1000 + 60000) - now`.
  - `interruptor ligado e origem schedule ou task: não arma`.
  - `armar e vencer: manda LIMIT_RESUME_TEXT uma vez, limit_tries=1, estado limpo`.
  - `retomada que bate no limite de novo: volta a none e não rearma` (Review Focus 2).
  - `quatro armados vencendo juntos: lotes de 3, sleep(5000) uma vez`.
  - `boot: armado vencido dispara; armado futuro rearma; adiado vencido só limpa` (Review Focus 3).
  - `arm/snooze sem resetsAt ou com resetsAt passado: reset_unknown` (Review Focus 4).
  - `continueNow com sessão trabalhando: session_busy; parada: revive e manda`.
  - `turno sem erro limpa e desarma; mensagem do operador limpa e desarma`.
  - `limite com marca do reinício: a marca é absorvida`.
  - `durante o encerramento o relógio não envia`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(limite): retomada armada na reabertura da janela, em lotes`.

### Task 5: Rotas e amarração

**Files:**
- Modify: `server/src/routes/terminals.ts`
- Modify: `server/src/app.ts`: cria o serviço junto do de reinício e o expõe por `onLimitReady`.
- Modify: `server/src/index.ts`
- Modify: `server/src/restart/boot.ts`: `startAfterListen` aceita `limit?: Pick<UsageLimitService, 'boot'>`, roda `limit.boot()` depois de `restart.boot()` e antes do agendador, e registra o erro sem subir.
- Test: `server/test/limit-routes.test.ts`

**Interfaces:**
- `PATCH /api/projects/:id/terminals/:engine/restart` passa a aceitar `autoResumeLimit` booleano. A validação continua: ao menos um booleano.
- `POST /api/projects/:id/terminals/:engine/limit` com corpo `{ action: 'arm' | 'snooze' | 'cancel' | 'continue' }` responde `TerminalStateDto`.
  - Respostas 409 com `no_usage_limit`, `reset_unknown`, `session_busy`, `shutting_down`, e 400 para uma ação inválida.
  - Para o envio que falha, o mesmo mapeamento do `continue` de hoje.
- `index.ts`:
  - `onUsageLimit` vai ao serviço;
  - `onTurnResult` vai ao reinício e ao limite;
  - `onOperatorMessage` vai aos dois;
  - `lastRejectedResetsAt` vem do `usage`;
  - `startAfterListen({ restart, limit, scheduler, … })`;
  - no SIGTERM, `limit.dispose()` depois do `captureShutdown`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `PATCH com autoResumeLimit grava e devolve o DTO`.
  - `limit arm/snooze/cancel/continue com os 409 de cada caso`.
  - `usuário sem acesso recebe 403` (padrão de `restart-routes.test.ts`).
  - `startAfterListen: limit.boot depois do restart.boot e antes do agendador; falha do limit.boot não impede o agendador`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte inteira do servidor e `npx tsc --noEmit`.** O teste intermitente do orchestrator, se falhar, deve ser rodado sozinho.
- [ ] **Step 5: Commit** `feat(limite): rotas e amarração do limite de uso`.

### Task 6: Interface: aviso, marca do cartão, interruptor e mensagem do Claudinei

**Files:**
- Modify: `web/src/types.ts`
  - `TerminalState` ganha `autoResumeLimit` e `usageLimit`, iguais ao DTO.
  - `ChatItem` `claudinei_message` ganha `reason: 'restart' | 'limit'`.
- Modify: `web/src/api.ts`
  - `setTerminalRestart` aceita `autoResumeLimit`.
  - Nova `usageLimitAction(projectId: number, engine: string, action: 'arm' | 'snooze' | 'cancel' | 'continue'): Promise<TerminalState>`.
- Modify: `web/src/chat/applyEvent.ts`: o prefixo `[Claudinei: resume after usage limit]:` vira `claudinei_message` com `reason: 'limit'`; o do reinício ganha `reason: 'restart'`.
- Modify: `web/src/components/MessageBlock.tsx`: o texto do cartão depende do `reason` (`chat.claudineiResume` ou `chat.claudineiLimitResume`).
- Create: `web/src/components/UsageLimitNotice.tsx`, com `UsageLimitNotice` e `UsageLimitCardMarker`.
- Modify: `web/src/components/ChatView.tsx`: o aviso vai logo abaixo do `InterruptedNotice`.
- Modify: `web/src/components/Sidebar.tsx`: a marca vai ao lado da `InterruptedCardMarker`.
- Modify: `web/src/components/SessionControls.tsx`: o interruptor `controls.autoResumeLimit`, só para o Claude.
- Modify: `web/src/i18n/{pt-BR,en,es}.ts`; `UX-CONTRACT.md` (seção "Bateu o limite").
- Test: `web/src/test/usage-limit-notice.test.tsx`, `web/src/test/applyEvent.test.ts` (casos novos).

**Interfaces / textos (pt-BR):**
- Aviso em `none`: "O Claude bateu no limite de uso. A janela reabre às 15:00 (daqui a 2 h 10 min)." Sem horário, só a primeira frase.
  - Com horário: botões **Continuar quando reabrir**, **Adiar até reabrir**, **Continuar agora** e ×.
  - Sem horário: só **Continuar agora** e ×. O × manda `cancel`.
- Aviso em `armed`: "Retomada armada para 15:01", com **Cancelar** e **Continuar agora**.
- Em `snoozed` o aviso não aparece. A marca estática do cartão diz "limite até 15:00".
- A marca do cartão aparece com `usageLimit` em `none` ou `snoozed`. Em `armed`, aparece também, com o texto "retoma às 15:01".
- O seletor da marca devolve **só uma string ou null**, sem redesenhar a lateral a cada mudança (o mesmo padrão da `InterruptedCardMarker`). Sem animação.
- Hora local em 24 h no pt-BR e no es, e no formato do idioma no en.

- [ ] **Step 1: Escrever os testes que falham:**
  - `applyEvent: prefixo do limite vira claudinei_message reason limit; o do reinício reason restart` (inclusive no formato do eco ao vivo, com `content` em lista).
  - `cartão do Claudinei do limite mostra o texto traduzido`.
  - `aviso com horário: três botões e ×; cada um chama usageLimitAction com a ação certa`.
  - `aviso sem horário: só Continuar agora e ×`.
  - `armado: mostra a hora e Cancelar`.
  - `snoozed: sem aviso, marca no cartão com a hora`.
  - `interruptor só no Claude; chama setTerminalRestart com autoResumeLimit`.
  - `erro da ação aparece no aviso` (409 `session_busy` traduzido).
  - `marca não redesenha a lateral em mudanças sem relação` (`Profiler`, padrão de `restart-notice.test.tsx`).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar `npx vitest run && npx tsc -b`** na web.
- [ ] **Step 5: Commit** `feat(limite): aviso de limite, marca do cartão e interruptor`.

### Task 7: Ensaio de ponta a ponta na instância isolada (porta 9195)

**Files:** nenhum de produção. O roteiro do ensaio fica em `/tmp/claudinei-e2e-limite-scripts/`.

- [ ] **Step 1: Subir a instância isolada na porta 9195**, no molde da memória `verificar-e2e-sem-reiniciar`:
  - `npm run build -w web`;
  - `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_PKG_NATIVE -u CLAUDINEI_PKG_WEB`;
  - `CLAUDINEI_PORT=9195`, `CLAUDINEI_DB`, `UPLOADS`, `SCHEDULES`, `SPEECH` e `PROGRESS` dentro de `/tmp/claudinei-e2e-limite`;
  - `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs`;
  - Node 24, `setsid`;
  - parar sempre pelo PID da porta 9195, nunca com `pkill -f`.
- [ ] **Step 2: Limite com relógio curto.** Num terminal, mandar `limite`. Esperado:
  - o aviso aparece com a hora (o fake põe `resetsAt` a 60 s);
  - clicar em Continuar quando reabrir;
  - em cerca de 2 min chega o cartão "Claudinei" e o turno termina;
  - o estado fica limpo.
- [ ] **Step 3: Interruptor ligado** e `limite` de novo. Esperado: o aviso já aparece armado e a retomada acontece sozinha. Mandar `limite` mais uma vez durante a retomada: o aviso volta sem rearmar.
- [ ] **Step 4: Adiar até reabrir.** Esperado: o aviso some, a marca aparece no cartão e, depois do horário, a marca some sem nenhuma mensagem enviada.
- [ ] **Step 5: Reinício com retomada armada.**
  - Armar, mandar SIGTERM **à instância da 9195**, subir de novo dentro do prazo e conferir que a retomada sai no horário.
  - Repetir subindo depois do horário: ela sai logo na subida.
- [ ] **Step 6: Agendamento e tarefa encaminhada.** Uma execução de agendamento com `limite` fica `error`, sem falha seguida. Uma tarefa encaminhada com `limite` fecha `failed` com o texto e a hora.
- [ ] **Step 7: Capturas de tela** (Playwright, Chromium) do aviso, do estado armado e da marca. Depois, parar a instância e apagar `/tmp/claudinei-e2e-limite`, o roteiro e as pastas `~/.claude/projects/-tmp-claudinei-e2e-limite*` que houver.
