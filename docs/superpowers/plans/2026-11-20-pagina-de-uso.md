# Página de uso — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma página só para o administrador (Ctrl+U e "Ver detalhes" no cartão Uso) mostra quais terminais e modelos gastam mais tokens e quanto o cache economiza. Os dados vêm de um índice incremental dos históricos locais do Claude e do Codex.

**Architecture:** Um módulo novo, `server/src/usage-index/`, tem quatro partes:
- leitores puros de linha (Claude, Codex);
- um repositório SQLite: arquivos lidos, uso agregado por hora × motor × modelo × pasta, e as chaves já contadas do Claude;
- um indexador que roda em segundo plano, em fatias, depois do `listen` e a cada 10 min;
- uma consulta que casa a pasta com o terminal e monta o relatório do período.

Uma rota admin entrega o relatório, e a visão nova `usage` da web o desenha com barras em CSS.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 (servidor), React + zustand + i18next (web), vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-pagina-de-uso-design.md`

## Global Constraints

- Só **tokens**: nada de custo em dinheiro nem tabela de preços.
- v1 lê **Claude e Codex**; Kimi e OpenCode ficam de fora.
- **Nunca ler nem guardar texto de mensagem.** O leitor faz um filtro barato antes do `JSON.parse` e guarda só números, modelo, pasta e horário.
- **Nunca contar duas vezes.** A chave do Claude é `message.id` + `requestId` (sem `requestId`, só `message.id`), e a deduplicação vale **entre arquivos**. Linhas com `isApiErrorMessage` ou modelo `<synthetic>` não contam.
- No Codex:
  - soma-se o `last_token_usage` de cada `token_count`;
  - a repetição é ignorada quando o `total_token_usage` não mudou;
  - entrada = `input_tokens − cached_input_tokens`.
- Subagentes do Claude são lidos **recursivamente** em `subagents/` (inclusive `subagents/workflows/wf_*/`) e contam para o modelo deles.
- Arquivo que sumiu: os números já indexados **ficam**. Arquivo menor que o salvo ou com mtime anterior: apaga o que veio dele e relê do zero.
- Indexador:
  - roda depois do `listen` e a cada **10 min**;
  - lê em fatias de **20 MB ou 200 ms**, cedendo o laço de eventos entre elas;
  - nunca roda em paralelo consigo mesmo e nunca bloqueia a subida nem as rotas.
- Períodos: **24 h, 7 dias, 30 dias, 90 dias**.
- "Gasto" (para ordenar) = entrada + saída + escrito no cache.
- Economia do cache = lido do cache ÷ (entrada + lido do cache + escrito no cache).
- Pasta → terminal: vence a pasta igual ou a mais específica que contém o `cwd`; sem casamento, vai para o balde "Fora do Claudinei". Pasta compartilhada mostra os terminais juntos.
- Só administrador (mesma regra de `/api/usage`): 403 para os demais.
- Ctrl+U segue a regra do Ctrl+Space (`isForeignField` em `web/src/keyboard.ts`):
  - com o foco no terminal ou num campo de texto, Ctrl+U não faz nada na página;
  - fora disso, abre a página com `preventDefault`.
- Sem GPU (AGENTS.md): barras em CSS com variáveis de tema, sem animação, sem biblioteca de gráficos. No celular, blocos empilhados.
- Textos da interface no i18n em três línguas (pt-BR, en, es), com as mesmas chaves.
- Testes:
  - servidor com Node 24: `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>`;
  - web: `cd web && npx vitest run <arquivo>`;
  - sempre com históricos falsos gerados no teste, nunca o `~/.claude` real.
- Ensaio só na instância isolada desta trilha: porta **9194**, dados em `/tmp/claudinei-e2e-uso`. Nunca 9105, 9198 nem 9199. Reiniciar o `claudinei.service` exige autorização expressa (AGENTS.md).

## Review Focus

1. **Um arquivo de 100+ MB na primeira passada** precisa ser lido em várias fatias, com o laço de eventos livre entre elas, e não engolido de uma vez. Teste na Task 3.
2. **Linha malformada ou JSON quebrado no meio do arquivo** é pulada, e o resto do arquivo continua contando. Teste na Task 2.
3. **Pasta `~/.codex` (ou `~/.claude/projects`) inexistente.** O indexador termina a passada sem erro e a página mostra só o outro motor. Teste na Task 3.
4. **Pastas com prefixo parecido** (`/a/proj` e `/a/proj2`): o casamento é por fronteira de diretório, e `/a/proj2/x` vai para `proj2`. Teste na Task 4.
5. **Serviço parando no meio de uma passada.** `stop()` interrompe entre fatias, e o banco fica coerente porque o offset de um arquivo é gravado na **mesma transação** que as linhas daquela fatia. Teste na Task 3.

---

### Task 1: Repositório do índice (tabelas e escrita)

**Files:**
- Create: `server/src/usage-index/store.ts`
- Test: `server/test/usage-index-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UsageEngine = 'claude' | 'codex'
  export interface UsageRow {        // um pedido já lido
    hour: string                     // UTC, 'YYYY-MM-DDTHH'
    engine: UsageEngine; model: string; cwd: string
    input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number
  }
  export interface FileState {
    path: string; engine: UsageEngine; size: number; mtimeMs: number; offset: number
    parser: string | null            // JSON do estado do leitor do Codex (modelo/cwd/último total); null no Claude
  }
  export function createUsageIndexStore(db: Db): {
    file(path: string): FileState | undefined
    /**
     * Numa transação só: para cada hit com `key`, registra a chave para `state.path` e descarta o
     * hit se a chave já tinha sido contada (em qualquer arquivo); soma os hits que sobraram em
     * `usage_hourly` e grava o novo estado do arquivo. Devolve quantos hits foram contados.
     */
    commitSlice(state: FileState, hits: Array<{ key?: string; row: UsageRow }>): number
    /** Arquivo reescrito: apaga as linhas e as chaves que vieram dele e o estado salvo. */
    resetFile(path: string): void
    fileCount(): number
  }
  export type UsageIndexStore = ReturnType<typeof createUsageIndexStore>
  ```
- Schema, criado no próprio `createUsageIndexStore`, no padrão de `engine-usage.ts`:
  ```sql
  CREATE TABLE IF NOT EXISTS usage_files (path TEXT PRIMARY KEY, engine TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, offset INTEGER NOT NULL, parser TEXT);
  CREATE TABLE IF NOT EXISTS usage_hourly (file TEXT NOT NULL, hour TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (file, hour, engine, model, cwd));
  CREATE INDEX IF NOT EXISTS idx_usage_hourly_hour ON usage_hourly(hour);
  CREATE TABLE IF NOT EXISTS usage_seen (key TEXT PRIMARY KEY, file TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_usage_seen_file ON usage_seen(file);
  ```
  As linhas guardam o arquivo de origem para que o arquivo reescrito possa ser desfeito. A consulta da Task 4 agrega ignorando `file`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `commitSlice soma na mesma hora/motor/modelo/pasta`: duas fatias com a mesma hora, motor, modelo e pasta, sem `key`, somam `input`.
  - `commitSlice grava linhas e offset juntos`: depois de um `commitSlice` que lança no meio (linha com `hour` nulo forçando erro de NOT NULL), nem as linhas, nem as chaves, nem o offset mudam.
  - `chave já contada é descartada, mesmo vinda de outro arquivo`: `commitSlice` de `a.jsonl` com a chave `m1:r1` devolve 1; depois, o de `b.jsonl` com a mesma chave devolve 0 e o total não muda.
  - `resetFile apaga o que veio do arquivo e mantém o resto`: as linhas e chaves de `a` somem, as de `b` ficam, e `file('a')` passa a ser `undefined`.
- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run test/usage-index-store.test.ts` deve dar FAIL, porque o módulo ainda não existe.
- [ ] **Step 3: Implementar `createUsageIndexStore(db)`** em `server/src/usage-index/store.ts`. `commitSlice` usa `db.transaction`, com upsert somando colunas em `usage_hourly` e `INSERT OR REPLACE` em `usage_files`. A chave é registrada com `INSERT OR IGNORE` em `usage_seen`, e o hit conta só se `changes === 1`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(uso): repositório do índice de uso`.

### Task 2: Leitores de linha (Claude e Codex)

**Files:**
- Create: `server/src/usage-index/readers.ts`
- Test: `server/test/usage-index-readers.test.ts`

**Interfaces:**
- Consumes: `UsageRow`, `UsageEngine` (Task 1).
- Produces:
  ```ts
  export interface ClaudeHit { key: string; row: UsageRow }
  /** null para linha que não interessa, malformada, de erro de API ou `<synthetic>`. */
  export function readClaudeLine(line: string): ClaudeHit | null
  export interface CodexParser { feed(line: string): UsageRow | null; state(): string }
  /** `saved` é o `FileState.parser` de uma leitura anterior do mesmo arquivo. */
  export function createCodexParser(saved?: string | null): CodexParser
  export function hourOf(timestamp: string): string | null   // 'YYYY-MM-DDTHH' em UTC
  ```
- Filtros baratos antes do `JSON.parse`:
  - Claude: a linha contém `"type":"assistant"`.
  - Codex: contém `"turn_context"` ou `"token_count"`.

- [ ] **Step 1: Escrever os testes que falham.** Todos usam linhas montadas no teste com `JSON.stringify` e campos reais, com textos de mensagem fictícios.
  - `Claude: linha assistant vira uma linha de uso com a chave id+requestId`: espera `key === 'msg_1:req_1'`, `row.engine === 'claude'`, `row.model === 'claude-opus-5-5'`, `row.cwd === '/p/a'`, `row.input === 10`, `row.cacheRead === 200`, `row.cacheWrite === 30`, `row.output === 5` e `row.hour === '2026-11-20T05'`.
  - `Claude: sem requestId a chave é só o id`.
  - `Claude: isApiErrorMessage e <synthetic> não contam` (devolvem `null`).
  - `Claude: linha user, linha malformada e JSON cortado devolvem null sem lançar`.
  - `Codex: token_count usa o modelo e a pasta do último turn_context`.
  - `Codex: entrada sem o cache`: `input_tokens: 100, cached_input_tokens: 60` resulta em `row.input === 40` e `row.cacheRead === 60`. `cache_write_input_tokens` vai para `cacheWrite` e `reasoning_output_tokens` para `reasoning`.
  - `Codex: total acumulado repetido é ignorado`: o segundo `token_count` com o mesmo `total_token_usage` devolve `null`.
  - `Codex: o estado sobrevive entre leituras`: `createCodexParser(p.state())` continua sabendo o modelo, a pasta e o último total.
  - `Codex: token_count sem turn_context antes vira modelo 'desconhecido' e pasta ''`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** `readClaudeLine`, `createCodexParser` e `hourOf` em `readers.ts`. O estado do Codex é `{ model, cwd, lastTotal }` serializado.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(uso): leitores de uso do Claude e do Codex`.

### Task 3: Indexador incremental em fatias

**Files:**
- Create: `server/src/usage-index/indexer.ts`
- Test: `server/test/usage-index-indexer.test.ts`

**Interfaces:**
- Consumes: Task 1 (`createUsageIndexStore`, `FileState`), Task 2 (`readClaudeLine`, `createCodexParser`).
- Produces:
  ```ts
  export interface IndexStatus { running: boolean; filesDone: number; filesTotal: number; lastPassAt: string | null }
  export function createUsageIndexer(deps: {
    store: UsageIndexStore
    claudeProjectsDir: string          // `${config.claudeConfigDir}/projects`
    codexSessionsDir: string           // sessionsRoot() de engine/codex/rollout.ts
    sliceBytes?: number                // padrão 20 * 1024 * 1024
    sliceMs?: number                   // padrão 200
    yieldNow?: () => Promise<void>     // padrão: new Promise(r => setImmediate(r))
    log?: (msg: string) => void
  }): {
    runPass(): Promise<void>           // uma passada completa; se já houver uma rodando, devolve a mesma promessa
    start(intervalMs?: number): void   // passada já e depois a cada intervalMs (padrão 600_000)
    stop(): Promise<void>              // para o relógio, interrompe a passada na próxima fatia e espera ela sair
    status(): IndexStatus
  }
  ```
- Descoberta dos arquivos:
  - Claude: `<claudeProjectsDir>/*/*.jsonl`, mais todo `*.jsonl` sob `<claudeProjectsDir>/*/<sessão>/subagents/`, recursivamente.
  - Codex: todo `*.jsonl` sob `codexSessionsDir`, recursivamente.
  - Pasta inexistente: lista vazia, sem erro.
- Leitura de um arquivo:
  1. Compara o `stat` com o `FileState`. Se o tamanho for menor que o `offset` ou o mtime anterior ao salvo, chama `resetFile` e relê do zero.
  2. Lê do `offset` em diante, em pedaços. Só conta linhas terminadas em `\n`: a última linha incompleta fica para a próxima passada, e o `offset` para antes dela.
  3. Grava com `commitSlice` a cada fatia (`sliceBytes` lidos ou `sliceMs` passados) e chama `yieldNow()` entre fatias.
  4. No Claude, cada linha vira um hit `{ key, row }`; no Codex, `{ row }`, sem chave. A deduplicação acontece no `commitSlice` da Task 1, na mesma transação que grava as linhas e o offset.

- [ ] **Step 1: Escrever os testes que falham.** Usam um diretório temporário com históricos falsos escritos pelo teste.
  - `primeira passada conta Claude e Codex`.
  - `arquivo que cresce: só o novo é lido` (os totais somam exatamente o acréscimo).
  - `arquivo reescrito menor: relê do zero sem somar em dobro`.
  - `arquivo apagado: os números ficam`.
  - `linha cortada no fim espera completar`: a primeira passada não conta a linha e, depois de completar o arquivo, a segunda conta uma vez.
  - `mesma resposta em dois arquivos de subagente conta uma vez`.
  - `subagents/workflows/wf_x/agent.jsonl é lido`.
  - `pasta do Codex inexistente não falha` (Review Focus 3).
  - `arquivo maior que a fatia é lido em várias fatias e cede o laço`: com `sliceBytes: 1024` e um arquivo de cerca de 50 KB, um `yieldNow` espião é chamado mais de 10 vezes, e um `setImmediate` agendado antes de `runPass()` roda antes de ela terminar (Review Focus 1).
  - `stop no meio deixa o banco coerente`: com um `yieldNow` que chama `stop()` na terceira fatia, depois de `await stop()` a soma no banco é igual à das linhas até o `offset` salvo. Uma nova passada completa chega ao total certo, sem dobrar (Review Focus 5).
  - `duas chamadas de runPass ao mesmo tempo fazem uma passada só`.
  - `status mostra filesDone/filesTotal durante a passada`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar `createUsageIndexer`** com `fs.promises.open` + `read` em pedaços de até 1 MB dentro da fatia, e decodificação UTF-8 que respeita a fronteira de linha. Cada fatia vira um único `commitSlice`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(uso): indexador incremental em fatias`.

### Task 4: Consulta do relatório

**Files:**
- Create: `server/src/usage-index/report.ts`
- Test: `server/test/usage-index-report.test.ts`

**Interfaces:**
- Consumes: as tabelas da Task 1 e `Project` (`server/src/projects.ts`).
- Produces:
  ```ts
  export type UsagePeriod = '24h' | '7d' | '30d' | '90d'
  export interface UsageTotals { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; spent: number }
  export interface UsageReport {
    period: UsagePeriod
    totals: UsageTotals
    cachePct: number                       // 0..100, uma casa decimal; 0 sem entrada
    terminals: Array<{
      projectIds: number[]                 // vazio = "Fora do Claudinei"; vários = pasta compartilhada
      names: string[]
      path: string | null
      byEngine: Record<string, UsageTotals>
      totals: UsageTotals
    }>                                     // ordenado por totals.spent desc
    models: Array<{ model: string; engine: string; totals: UsageTotals }>   // por spent desc
    series: Array<{ bucket: string; spent: number; cacheRead: number }>     // horas (24h) ou dias locais
    oldestHour: string | null              // hora mais antiga indexada
  }
  export function matchProject(cwd: string, projects: Pick<Project, 'id' | 'name' | 'path'>[]): Pick<Project, 'id' | 'name' | 'path'>[]
  export function buildUsageReport(db: Db, opts: { period: UsagePeriod; now: Date; tzOffsetMin: number; projects: Pick<Project, 'id' | 'name' | 'path'>[] }): UsageReport
  ```
- `spent` = input + output + cacheWrite. `cachePct` = cacheRead ÷ (input + cacheRead + cacheWrite) × 100.
- `matchProject` devolve todos os projetos da pasta vencedora (casamento por fronteira de `/`, a mais longa vence) ou `[]`.
- `tzOffsetMin` é o valor de `Date.getTimezoneOffset()` do navegador; serve para agrupar a série por dia local nos períodos de 7, 30 e 90 dias.

- [ ] **Step 1: Escrever os testes que falham.** Inserem em `usage_hourly` pelo `commitSlice` da Task 1.
  - `totais e percentual do cache do período`: input 100, cacheRead 300, cacheWrite 100 dão `cachePct === 60` e `spent === input+output+cacheWrite`.
  - `24h exclui o que é mais velho`.
  - `terminais ordenados por gasto, com divisão por motor`.
  - `pasta mais específica vence`: `/a` e `/a/b` com `cwd` `/a/b/c` vão para `/a/b`.
  - `prefixo parecido não casa`: `/a/proj2/x` não vai para `/a/proj` (Review Focus 4).
  - `pasta compartilhada junta os terminais`: `projectIds` tem os dois ids e `names` os dois nomes.
  - `sem casamento vai para Fora do Claudinei` (`projectIds: []`).
  - `modelos ordenados por gasto`.
  - `série por dia local`: com `tzOffsetMin: 180`, uma linha às 02 h UTC conta no dia anterior.
  - `período sem dados devolve listas vazias e cachePct 0`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** Um `SELECT … GROUP BY hour, engine, model, cwd` filtrado por `hour >= início do período`; o casamento com os projetos e a montagem do relatório ficam em memória.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(uso): relatório por terminal, modelo e período`.

### Task 5: Rota e amarração no servidor

**Files:**
- Create: `server/src/routes/usage-report.ts`
- Modify:
  - `server/src/app.ts`: dep opcional `usageIndexer?` e o registro da rota;
  - `server/src/index.ts`: criar o store e o indexador, `start()` depois do `listen`, `await stop()` no SIGINT/SIGTERM antes do `app.close()`.
- Test: `server/test/usage-report-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4. `sessionsRoot()` vem de `server/src/engine/codex/rollout.ts` e `config.claudeConfigDir` de `server/src/config.ts`.
- Produces: `GET /api/usage/report?period=24h|7d|30d|90d&tz=<minutos>` devolve `UsageReport & { index: IndexStatus }`.
  - Período inválido dá 400. `tz` ausente ou fora de −840..840 vale 0.
  - Não administrador recebe 403, com `requireAdmin` de `server/src/auth/guards.ts`.
  - A rota lê os projetos com `createProjectsService(db).list()` e nunca dispara uma passada.
- Ordem no `index.ts`: `usageIndexer.start()` logo depois de `startAfterListen(...)`, sem `await`. Uma passada que lança é registrada no log e não derruba o servidor.

- [ ] **Step 1: Escrever os testes que falham:**
  - `admin recebe o relatório com index`: com um indexador falso cujo `status()` dá `running: true`, a resposta traz `index.running === true` e as listas.
  - `não admin recebe 403`, no padrão de `server/test/auth-rbac.test.ts` (`anaCookie`).
  - `período inválido dá 400`.
  - `a rota responde enquanto uma passada roda`: um indexador real em fixture grande, com `sliceBytes` pequeno, e uma chamada `inject` durante `runPass()` que responde antes de ela terminar.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar a rota e a amarração.**
- [ ] **Step 4: Rodar a suíte inteira do servidor.** `npx vitest run` deve dar verde; o teste intermitente conhecido do orchestrator passa quando rodado isolado. Rodar também `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(uso): rota do relatório e indexador na subida`.

### Task 6: A página na web

**Files:**
- Modify:
  - `web/src/api.ts`: tipos `UsageReport`, `UsageTotals`, `IndexStatus` iguais aos do servidor, e `fetchUsageReport(period, tz)`;
  - `web/src/store.ts`: `view` ganha `'usage'` e entra `openUsage()`;
  - `web/src/App.tsx`: visão `usage` lazy, título da topbar e o hook do atalho montado só para administrador;
  - `web/src/components/UsageCard.tsx`: botão "Ver detalhes";
  - `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts`: chaves `usagePage.*`;
  - `web/src/styles.css`.
- Create:
  - `web/src/components/UsagePage.tsx`;
  - `web/src/useUsageShortcut.ts` (`isUsageShortcut(e)` e `useUsageShortcut(enabled)`).
- Test: `web/src/test/usage-page.test.tsx`

**Interfaces:**
- Consumes: a rota da Task 5.
- Atalho: `isUsageShortcut(e)` é verdadeiro para Ctrl+U sem Alt, Meta ou Shift (`e.key` `u`/`U` ou `e.code === 'KeyU'`).
  - O listener fica em `window`, no `keydown`.
  - Com `isForeignField(e.target, null)`, retorna sem fazer nada. O xterm usa um textarea, então o terminal cai nessa regra.
  - Fora disso, `preventDefault()` + `openUsage()`.
- Página:
  - seletor de período 24 h / 7 d / 30 d / 90 d (padrão 7 d);
  - bloco de totais com o texto "X% da entrada veio do cache";
  - "Terminais que mais gastam", com barra em CSS proporcional ao maior, divisão por motor, e clique que abre o terminal (`openChat` da sessão mais recente do projeto; sem sessão, abre o dashboard filtrado — escolha de quem constrói);
  - "Modelos que mais gastam";
  - série por hora ou por dia;
  - aviso "indexando… X de Y arquivos" quando `index.running`, que recarrega o relatório a cada 5 s só enquanto a passada roda;
  - aviso fixo do histórico do Claude quando o período é 90 d ou `oldestHour` é posterior ao início do período.
  - Textos em pt-BR:
    - `usagePage.cacheShare`: "{{pct}}% da entrada veio do cache";
    - `usagePage.outside`: "Fora do Claudinei";
    - `usagePage.indexing`: "Indexando… {{done}} de {{total}} arquivos";
    - `usagePage.claudeRetention`: "O Claude apaga históricos com mais de ~30 dias; os números mais antigos são os que o Claudinei já tinha indexado."

- [ ] **Step 1: Escrever os testes que falham.** Usam um `fetch` espião, no padrão de `web/src/test/usage-card.test.tsx`.
  - `mostra totais, percentual do cache e as duas listas ordenadas`.
  - `trocar o período refaz a busca com o período novo`.
  - `aviso de indexando aparece com running e some quando termina`.
  - `Ctrl+U fora de campo abre a página e chama preventDefault`.
  - `Ctrl+U com foco num textarea (o do terminal) não faz nada e não chama preventDefault`.
  - `Ctrl+Shift+U não abre`.
  - `não administrador não tem o atalho`: o hook fica desligado e Ctrl+U não muda a visão.
  - `Ver detalhes no cartão Uso abre a página`.
  - `balde Fora do Claudinei usa o texto traduzido`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** As barras são `div` com `width` em %, nas variáveis de tema, sem `transition` nem `animation`; no celular, blocos empilhados (media query existente).
- [ ] **Step 4: Rodar a suíte da web e o `tsc`.** `npx vitest run && npx tsc -b` deve dar verde.
- [ ] **Step 5: Commit** `feat(uso): página de uso com Ctrl+U`.

### Task 7: Ensaio na instância isolada (porta 9194)

**Files:** nenhum de produção. Scripts em `/tmp/claudinei-e2e-uso-scripts/`, separados dos dados.

- [ ] **Step 1: Construir a web e subir a instância.**
  - `npm run build -w web`.
  - Subir com `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_PKG_NATIVE -u CLAUDINEI_PKG_WEB`.
  - Variáveis: `CLAUDINEI_PORT=9194` e `CLAUDINEI_DB`, `CLAUDINEI_UPLOADS`, `CLAUDINEI_SCHEDULES`, `CLAUDINEI_SPEECH`, `CLAUDINEI_PROGRESS` sob `/tmp/claudinei-e2e-uso`.
  - Comando: `node --import tsx src/index.ts` com Node 24, via `setsid`.
  - `CLAUDE_CONFIG_DIR` e `CODEX_HOME` ficam **sem mudança**: o indexador lê os históricos reais. Ele só lê; nenhum arquivo deles é escrito.
  - Criar a conta por `POST /api/auth/setup` e alguns projetos com caminhos reais de `~/Projects/...`, para o casamento.
- [ ] **Step 2: Medir a primeira passada.** Enquanto `index.running` for true, amostrar `ps -o %cpu,rss -p <pid da 9194>` a cada 10 s, e registrar o tempo total e o pico de CPU e de memória. A cada 30 s, um `GET /api/usage/report?period=24h` precisa responder em menos de 1 s.
- [ ] **Step 3: Conferir os números, imprimindo só agregados, nunca texto de mensagem.**
  - Codex: num rollout do dia, a soma do índice bate com o último `total_token_usage` do arquivo, descontado o cache conforme a regra.
  - Claude: num transcript, a soma deduplicada por um script à parte (`message.id` + `requestId`) bate com o índice.
- [ ] **Step 4: Segunda passada.** Ela deve levar segundos, e um arquivo que cresceu só acrescenta.
- [ ] **Step 5: Ver a página no Chromium headless** (Playwright em `/home/coppi/Projects/57-FXNCredible/new-frontend/node_modules/playwright/index.mjs`, Chromium `/home/coppi/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`).
  - Ctrl+U abre a página.
  - Ctrl+U com foco num campo não abre.
  - Fazer capturas para o relatório.
- [ ] **Step 6: Limpar.**
  - Parar a instância pelo PID da porta 9194, nunca com `pkill -f`, e conferir que não é o PID da 9105.
  - Apagar `/tmp/claudinei-e2e-uso` e os scripts.
  - Registrar as medições no relatório ao operador.
