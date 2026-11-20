# Motores por terminal — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada terminal tem a sua lista de motores. Só eles aparecem no cabeçalho e nas listas de escolha daquele terminal. Os terminais existentes migram com os motores que já usaram.

**Architecture:**
- **Servidor:** uma coluna nova `projects.engines`, com uma lista JSON de ids de motor. Ela é preenchida uma única vez, na migração, a partir de `sessions` e `project_threads`. Um módulo puro, `server/src/terminal-engines.ts`, concentra a lista: ler, ordenar, padrão e migração. O servidor a usa em três lugares:
  - nas rotas de criar e editar terminal;
  - no "iniciar com o Claudinei" (`restart/boot.ts`);
  - no agendamento sem motor fixo (`schedules/scheduler.ts`).
- **Interface:** um módulo puro, `web/src/terminalEngines.ts`, decide quais abas aparecem e o que entra nas listas de escolha. `EngineTabs`, `StartSessionModal`, `EnginePickerMenu`, `ScheduleEditor`, `NewProjectModal` e o cartão da lateral usam esse módulo.

**Tech Stack:** Node 24, TypeScript, Fastify, better-sqlite3 (servidor); React, zustand, i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-motores-por-terminal-design.md` (inclui as "Decisões depois da revisão do desenho").

## Global Constraints

- A lista fica em `projects.engines`: um JSON de ids, em ordem canônica. A ordem é Claude, Codex, Kimi, OpenCode (`claude`, `codex`, `kimi`, `opencode`), e ids desconhecidos vêm depois, na ordem gravada.
- Migração: os motores com linha em `sessions` **ou** em `project_threads` para o projeto. Se não houver nenhum, a lista é `["claude"]`. A migração roda **uma vez só**, na adição da coluna.
- Pelo menos um motor: o formulário não salva sem nenhum, e o servidor recusa uma lista sem nenhum id conhecido.
- Terminal novo: `["claude"]`. Se o Claude não estiver instalado, entra o primeiro motor instalado na ordem canônica. Um terminal temporário nasce com o motor escolhido ao criá-lo.
- Um motor recém-instalado não entra sozinho em nenhuma lista.
- Um id desconhecido é ignorado na exibição e preservado no banco: o formulário o devolve ao salvar.
- Quem tem acesso ao terminal pode mudar a lista. O controle é o mesmo de `PATCH /api/projects/:id/heads-up`.
- Testes do servidor rodam com Node 24: `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>`. Testes da web: `cd web && npx vitest run <arquivo>`.
- Textos da interface vão para o i18n em pt-BR, en e es, com as mesmas chaves nas três línguas.
- Nada de animação contínua nova, porque a interface precisa rodar sem GPU (AGENTS.md).
- O ensaio usa a porta **9197** e o diretório de dados `/tmp/claudinei-e2e-motores`. Nunca usar 9105, 9198 ou 9199, e nunca reiniciar o `claudinei.service`.

## Review Focus

1. **Migração que roda de novo.** Um banco já migrado, cuja lista o operador editou, passa por `openDb` outra vez. Esperado: a lista dele fica intocada. Teste na Task 1.
2. **Recriação de `projects` por `migrarPathNaoUnico`.** Um banco antigo, com UNIQUE em `path`, migra. Esperado: `engines` sobrevive à recriação da tabela. Teste na Task 1.
3. **JSON quebrado na coluna** (por exemplo `"x"` ou `[]`). Esperado: o terminal é lido como `["claude"]`, sem derrubar a listagem. Teste na Task 1.
4. **Conversa aberta de um motor escondido** (por link ou notificação). Esperado: a aba dela aparece enquanto estiver na tela. Teste na Task 3.
5. **Motor listado mas não instalado.** Esperado: sem aba, a menos que tenha sessão viva. No "+" e no formulário ele aparece com o selo "não instalada". Teste na Task 3.

---

### Task 1: Coluna `projects.engines`, migração e rotas

**Files:**
- Create: `server/src/terminal-engines.ts`
- Modify: `server/src/db.ts`. Adicionar a coluna e chamar a migração logo depois do `ALTER` do `heads_up` (por volta da linha 177), **antes** de `migrarPathNaoUnico`.
- Modify: `server/src/projects.ts`. O `Project` ganha `engines`, `create` aceita `engines` e entra o método novo `setEngines`.
- Modify: `server/src/routes/projects.ts`. Mudam `POST /api/projects` e `POST /api/projects/scratch`, e entra a rota nova `PATCH /api/projects/:id/engines`.
- Test: `server/test/terminal-engines.test.ts` e `server/test/routes-projects-engines.test.ts`.

**Interfaces:**
- Produces (`server/src/terminal-engines.ts`):
  ```ts
  export const CANONICAL_ENGINE_ORDER: readonly string[]   // ['claude','codex','kimi','opencode']
  export const ENGINE_ID_RE: RegExp                        // /^[a-z0-9-]{1,32}$/
  export function parseEngines(raw: unknown): string[] | null      // JSON string → lista válida não vazia; senão null
  export function sortEngines(ids: string[]): string[]              // sem repetição; canônicos primeiro, desconhecidos depois na ordem dada
  export function enginesOf(db: Db, projectId: number): string[]    // parseEngines(coluna) ?? ['claude']
  export function backfillProjectEngines(db: Db): number            // preenche todos os projetos; devolve quantos
  export function defaultEngines(isAvailable: (id: string) => boolean): string[]  // ['claude'] ou o 1º instalado canônico
  export function validateEnginesInput(v: unknown, isKnown: (id: string) => boolean): string[] | null // lista ordenada ou null (vazia, formato inválido, nenhum conhecido)
  ```
- Produces (`projects.ts`):
  - `Project.engines: string[]`, lido com `parseEngines(r.engines) ?? ['claude']`.
  - `create(input: { name; path; color?; icon?; engines?: string[] })`, que grava `JSON.stringify(sortEngines(engines ?? ['claude']))`.
  - `setEngines(id: number, engines: string[]): Project | undefined`.
- Produces (rotas):
  - `PATCH /api/projects/:id/engines`, com corpo `{ engines: string[] }`. Devolve o `Project`. Erros:
    - 400 `fail('engines_required', ...)` quando `validateEnginesInput` devolve null;
    - 403 por `requireProjectAccess`;
    - 404 `project_not_found`.
  - `POST /api/projects` e `POST /api/projects/scratch` aceitam um `engines` opcional, validado do mesmo jeito (400 `engines_required`).
    - Sem `engines`, o valor é `defaultEngines((id) => binAvailableCached(getEngine(id).bin()))`.
    - `hasEngine` serve de `isKnown`.

- [ ] **Step 1: Escrever os testes que falham** (`terminal-engines.test.ts`):
  - `sortEngines põe os canônicos primeiro e mantém os desconhecidos`: `sortEngines(['xyz','codex','claude','codex'])` dá `['claude','codex','xyz']`.
  - `parseEngines recusa lixo`: devolve `null` para `'"x"'`, `'[]'`, `'nao-json'`, `null` e `'[1]'`. `'["kimi"]'` dá `['kimi']`.
  - `backfill: sessões de Claude e Codex dão os dois`: o projeto com linhas em `sessions` dos dois motores fica com `['claude','codex']`.
  - `backfill: só project_threads de Kimi dá o Kimi`.
  - `backfill: terminal sem nada fica com o Claude`.
  - `migração roda uma vez só`: abrir com `openDb`, chamar `setEngines(p,['codex'])`, fechar, abrir de novo com `openDb`, e `enginesOf` continua `['codex']`.
  - `engines sobrevive à recriação de projects`: no padrão de `migrations-path-shared.test.ts` (`reintroduzirUnique`), a lista gravada antes continua igual depois de `openDb`.
  - `coluna com JSON quebrado é lida como Claude`: com `UPDATE projects SET engines='[]'`, `createProjectsService(db).list()` não lança e dá `engines` igual a `['claude']`.
  - `defaultEngines`: com tudo instalado dá `['claude']`. Sem o Claude dá `['codex']`. Sem nenhum instalado dá `['claude']`.
- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run test/terminal-engines.test.ts`. Esperado: FAIL, módulo inexistente.
- [ ] **Step 3: Implementar.**
  - Em `db.ts`: `try { db.exec('ALTER TABLE projects ADD COLUMN engines TEXT'); backfillProjectEngines(db) } catch { /* já existe */ }`. O backfill fica dentro do mesmo `try`, então só roda quando a coluna acaba de nascer.
  - `backfillProjectEngines` faz um `SELECT DISTINCT engine` da união de `sessions` e `project_threads` por projeto, e grava `sortEngines(...)` ou `['claude']`. Tudo numa transação.
- [ ] **Step 4: Escrever os testes de rota que falham** (`routes-projects-engines.test.ts`, no padrão de `heads-up-routes.test.ts`):
  - `PATCH grava a lista ordenada e devolve o projeto`: enviar `['codex','claude']` devolve `engines` igual a `['claude','codex']`.
  - `PATCH com lista vazia dá 400 engines_required`.
  - `PATCH só com id desconhecido dá 400`.
  - `PATCH preserva id desconhecido junto de um conhecido`: `['claude','futuro']` fica `['claude','futuro']`.
  - `usuário sem acesso recebe 403 e a lista não muda`, no padrão de `auth-rbac.test.ts`.
  - `POST /api/projects sem engines usa o padrão` e `POST com engines grava a lista`.
  - `POST /api/projects/scratch com engines ['codex'] nasce com o Codex`.
- [ ] **Step 5: Implementar as rotas** e rodar os dois arquivos, mais `projects.test.ts`, `routes-projects.test.ts`, `db.test.ts` e `migrations-path-shared.test.ts`. Esperado: PASS.
- [ ] **Step 6: Commit** `feat(motores): lista de motores do terminal no banco, migração e rotas`.

### Task 2: "Iniciar com o Claudinei" e agendamento sem motor respeitam a lista

**Files:**
- Modify: `server/src/restart/boot.ts`. Muda `planBoot` e a chamada dele em `boot()` (por volta da linha 227).
- Modify: `server/src/schedules/scheduler.ts`. Muda `resolveSession`.
- Test: `server/test/restart-boot.test.ts` e `server/test/scheduler.test.ts` (casos novos).

**Interfaces:**
- Consumes: `enginesOf(db, projectId)` (Task 1).
- Produces:
  - `planBoot(rows, latestLocalId, isListed: (projectId: number, engine: string) => boolean = () => true): BootAction[]`.
  - Com `isListed` falso:
    - uma linha **não interrompida** com `autostart` não gera `idle`;
    - um `hold` gera `alsoIdle: false`;
    - um terminal **interrompido** segue a regra de sempre, inclusive `resume`, porque o trabalho estava rodando.
  - `boot()` passa `(p, e) => enginesOf(db, p).includes(e)`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `planBoot`, com o título `motor fora da lista não sobe sozinho`: uma linha `{autostart:true, interruptedAt:null}` com `isListed` falso dá `[]`.
  - `planBoot`, com o título `motor fora da lista interrompido ainda retoma`: com `autoResume`, interrompido e `isListed` falso, a saída é `kind 'resume'`.
  - `planBoot`, com o título `hold de motor fora da lista não sobe parado`: a saída tem `alsoIdle: false`.
  - `scheduler`, com o título `agendamento sem motor só usa motores da lista`:
    1. O projeto tem lista `['codex']`, uma sessão `stopped` de Claude mais recente e uma `stopped` de Codex mais antiga.
    2. Disparar o agendamento sem motor revive a do **Codex**.
  - `scheduler`, com o título `agendamento sem motor e sem sessão listada começa no primeiro da lista`: com lista `['kimi','codex']`, `manager.start` é chamado com `engine: 'codex'`. A lista é ordenada canonicamente, então o primeiro é o Codex.
  - `scheduler`, com o título `agendamento preso a motor escondido continua rodando`: com lista `['claude']` e `s.engine = 'codex'`, a sessão usada é a do Codex.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
  - Em `resolveSession`, quando `!s.engine`, `mine` é filtrado por `enginesOf(db, s.projectId)`. Sem sessão para reviver, a chamada é `manager.start(project, { engine: listed[0], ... })`.
  - `projectOf` devolve a linha crua: usar `createProjectsService(db).get(id)` para o `Project`, ou manter `projectOf` para o `start`, que hoje recebe a linha crua.
- [ ] **Step 4: Rodar os dois arquivos e ver passar**, mais `restart-routes.test.ts` como regressão.
- [ ] **Step 5: Commit** `feat(motores): iniciar com o Claudinei e agendamento sem motor seguem a lista`.

### Task 3: Regras puras da interface e abas do cabeçalho

**Files:**
- Modify: `web/src/types.ts`. O `Project` ganha `engines?: string[]`.
- Modify: `web/src/api.ts`. Entra `setProjectEngines(id: number, engines: string[]): Promise<Project>` (PATCH), e `createProject` e `createScratchProject` aceitam `engines?: string[]`.
- Create: `web/src/terminalEngines.ts`
- Modify: `web/src/engineSession.ts`. `primarySessionOf` ganha o parâmetro opcional `listed?: string[]`.
- Modify: `web/src/components/EngineTabs.tsx`. As abas passam por `tabEngines`, e entra o botão "+" com o menu dos escondidos.
- Modify: `web/src/i18n/pt-BR.ts`, `en.ts` e `es.ts`, com as chaves `chat.addEngine` e `chat.addEngineHint`.
- Test: `web/src/test/terminal-engines.test.ts` e `web/src/test/engine-tabs-list.test.tsx`.

**Interfaces:**
- Produces (`web/src/terminalEngines.ts`):
  ```ts
  export function listedOf(project: Pick<Project, 'engines'> | undefined): string[]   // engines válido e não vazio, senão ['claude']
  export function tabEngines(a: {
    engines: EngineMeta[]; listed: string[]; projectId: number
    sessions: Record<string, SessionInfo>; activeLocalId: string | null
    interrupted: (engine: string) => boolean
  }): EngineMeta[]
  //   aparece: (listado E available !== false) OU sessão viva OU é o motor da sessão ativa OU interrupted(engine)
  //   ordem: a de `engines` (store); ids de `listed` que não existem em `engines` são ignorados
  export function pickableEngines(engines: EngineMeta[], listed: string[], keep?: string | null): EngineMeta[]  // listados (+ keep), na ordem do store
  export function hiddenEngines(engines: EngineMeta[], listed: string[]): EngineMeta[]                          // os não listados, na ordem do store
  ```
- Produces (`engineSession.ts`): `primarySessionOf(projectId, sessions, listed?)`.
  - Sem `listed`, nada muda.
  - Com `listed`, quando a melhor sessão não está viva, a preferida é a mais recente de um motor listado. Se não houver nenhuma, cai na regra atual.
- Produces (`EngineTabs`): o "+" chama `setProjectEngines(projectId, [...listedComDesconhecidos, id])` e grava a resposta em `store.projects` por `setProjects`. O "+" é escondido quando `hiddenEngines` está vazio.
- O `interrupted(engine)` vem de `store.terminalStates[\`${projectId}:${engine}\`]?.interruption != null`.

- [ ] **Step 1: Escrever os testes puros que falham** (`terminal-engines.test.ts`):
  - `tabEngines mostra só os listados instalados`: com a lista `['claude']` e os quatro instalados, a saída é só `['claude']`.
  - `motor fora da lista com sessão viva ganha aba`.
  - `motor listado não instalado sem sessão não ganha aba`.
  - `conversa aberta de motor escondido ganha aba`: o `activeLocalId` é uma sessão `stopped` do Kimi, que está fora da lista, e o Kimi aparece.
  - `motor escondido com aviso de interrompido ganha aba`.
  - `listedOf trata lista ausente ou vazia como Claude`.
  - `pickableEngines mantém o motor do agendamento existente` (`keep`).
  - `primarySessionOf com lista prefere a sessão parada de motor listado`: com o Claude `stopped` mais recente fora da lista e o Codex `stopped` listado, a saída é o Codex.
  - `primarySessionOf com lista não muda quando há sessão viva`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** `terminalEngines.ts`, o parâmetro de `primarySessionOf`, os tipos e a api.
- [ ] **Step 4: Escrever os testes de componente que falham** (`engine-tabs-list.test.tsx`, no padrão de `engine-tabs-stop.test.tsx`):
  - `cabeçalho de terminal com lista ['claude'] mostra uma aba`.
  - `o + lista os escondidos com selo de não instalada` (motor `available:false`).
  - `escolher no + chama setProjectEngines com a lista mais o motor e a aba aparece` (mock de `api`).
  - `sem escondidos, o + não aparece`.
- [ ] **Step 5: Implementar o "+"** em `EngineTabs`, no estilo dos menus `sess-pop`. Ele não tem animação. Rodar os testes novos e `engine-tabs-stop.test.tsx` e `engine-tabs-overflow.test.ts`. Esperado: PASS.
- [ ] **Step 6: Commit** `feat(motores): abas do cabeçalho seguem a lista do terminal, com o +`.

### Task 4: Listas de escolha, formulário e cartão da lateral

**Files:**
- Modify: `web/src/components/StartSessionModal.tsx`.
  - Com um `project` existente, os motores oferecidos são `pickableEngines(engines, listedOf(project))`.
  - Em rascunho (terminal temporário), todos os motores são oferecidos, e `create` passa a ser `create(engineId: string) => Promise<Project>`.
- Modify: `web/src/components/Sidebar.tsx`.
  - `createScratch(name, engineId)` envia `engines: [engineId]`.
  - O `EnginePickerMenu` recebe `pickableEngines(engines, listedOf(projeto))`.
  - O `sessionOf` do cartão usa `primarySessionOf(id, sessions, listedOf(projeto))`.
- Modify: `web/src/components/ScheduleEditor.tsx`. O `<select>` de motor mostra `pickableEngines(engines, listedOf(projeto), editing?.engine)`, e a opção "manter o atual" continua.
- Modify: `web/src/components/NewProjectModal.tsx`. Entram caixas de marcar dos motores:
  - Na criação, vêm pré-marcadas com o padrão: `['claude']`, ou o primeiro instalado.
  - Na edição, vêm com a lista do terminal.
  - Os não instalados levam o selo "não instalada".
  - O botão de salvar fica desabilitado sem nenhum motor marcado.
  - Ao salvar, a lista enviada leva de volta os ids desconhecidos que já estavam na lista. Na edição, isso é `setProjectEngines`; na criação, é `engines` no `createProject`.
- Modify: os três arquivos de i18n, com as chaves `project.engines`, `project.enginesHint` e `project.enginesRequired`.
- Test: `start-session-modal.test.tsx`, `new-project-modal.test.tsx`, `schedules-view.test.tsx` (ou um `schedule-editor-engines.test.tsx` novo) e `sidebar.test.tsx`, com casos novos.

**Interfaces:**
- Consumes: `listedOf`, `pickableEngines` e `primarySessionOf(…, listed)` (Task 3); `setProjectEngines` e `createProject({ engines })` (Task 3); as rotas da Task 1.

- [ ] **Step 1: Escrever os testes que falham:**
  - `iniciar sessão oferece só os motores do terminal`: com a lista `['codex']`, só o Codex aparece no seletor.
  - `terminal temporário cria com o motor escolhido`: escolher o Kimi no rascunho chama `create('kimi')`, e o Sidebar envia `engines: ['kimi']` ao `createScratchProject`.
  - `menu de motor do cartão oferece só os listados`.
  - `editor de agendamento lista só os motores do terminal e mantém o do agendamento existente`: com a lista `['claude']` e um agendamento de Codex, o select tem "manter o atual", Claude e Codex.
  - `formulário de edição mostra as caixas com a lista e salva com setProjectEngines`.
  - `formulário não salva sem motor` (o botão fica desabilitado).
  - `formulário preserva id desconhecido ao salvar`: com a lista `['claude','futuro']` e o Codex desmarcado, o envio é `['claude','futuro']`.
  - `cartão abre a sessão parada do motor listado`: clicar no cartão abre a do Codex, e não a do Claude escondido.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte inteira da web e o `tsc`.** `npx vitest run && npx tsc -b`. Esperado: verde.
- [ ] **Step 5: Commit** `feat(motores): listas de escolha, formulário e cartão seguem a lista do terminal`.

### Task 5: Ensaio numa instância isolada (porta 9197)

**Files:** nenhum de produção. Os scripts do ensaio ficam em `/tmp/claudinei-e2e-motores-scripts/`.

- [ ] **Step 1: Preparar uma cópia do banco de produção.**
  - Copiar `~/.claudinei/claudinei.db` com `VACUUM INTO` para `/tmp/claudinei-e2e-motores/claudinei.db`, usando o `better-sqlite3` de `server/` com Node 24.
  - Na cópia, rodar `UPDATE schedules SET enabled=0` para nenhum agendamento disparar.
  - Na cópia, rodar `UPDATE terminal_state SET autostart=0, auto_resume=0`.
- [ ] **Step 2: Subir a instância.**
  - Rodar `npm run build -w web` antes.
  - Variáveis: `CLAUDINEI_PORT=9197`, mais `CLAUDINEI_DB`, `_UPLOADS`, `_SCHEDULES`, `_SPEECH` e `_PROGRESS`, todos em `/tmp/claudinei-e2e-motores`.
  - Remover do ambiente: `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_PKG_NATIVE -u CLAUDINEI_PKG_WEB`.
  - Comando: `node --import tsx src/index.ts`, rodado em `server/` com Node 24 e `setsid`.
  - Criar a conta por `POST /api/auth/setup`.
- [ ] **Step 3: Conferir a migração.**
  - `GET /api/projects` traz `engines` em todos os terminais.
  - Pelo menos um terminal sabidamente só de Claude fica com `['claude']`.
  - Um terminal que já usou o Codex fica com `['claude','codex']`.
  - Anotar a contagem por tamanho de lista.
- [ ] **Step 4: Conferir a tela.** Com Playwright (`/home/coppi/Projects/57-FXNCredible/new-frontend/node_modules/playwright/index.mjs` e o Chromium `/home/coppi/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`), tirar capturas de:
  - o cabeçalho de um terminal só de Claude, com uma aba e o "+";
  - o menu do "+";
  - o formulário de edição com as caixas.

  Acrescentar um motor pelo "+" e confirmar que a aba aparece.
- [ ] **Step 5: Encerrar e limpar.**
  - Parar **pelo PID da porta 9197**, conferindo que não é o PID da 9105. Nunca usar `pkill -f`.
  - Apagar `/tmp/claudinei-e2e-motores*`.
  - Registrar os resultados no relatório.
