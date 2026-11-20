# Triagem da lista — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fixar, assentar e adiar terminais na lateral, uma faixa "Trabalhando" no topo e desfazer com `Ctrl+Z` por 5 s, com o estado guardado no servidor por usuário.

**Architecture:**
- O servidor guarda o estado de triagem numa tabela `user_triage`, por usuário e projeto. O usuário `0` é a instalação sem autenticação.
- Rotas do usuário logado leem e mudam esse estado, e um WebSocket `triage` leva cada mudança só ao próprio usuário.
- Um "despertador" tira as marcas de assentado e adiado de todos os usuários quando o terminal precisa do operador. Ele é chamado pelo manager (pergunta aberta, turno com erro, sessão morta) e pelo serviço do reinício (aviso de interrompido).
- Na web, uma função pura divide a árvore da lateral em seções. A faixa "Trabalhando" é um componente próprio com seletores estreitos, e o desfazer vive só no navegador.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 (servidor); React + zustand + i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-triagem-da-lista-design.md`. A seção final "O que acorda um assentado ou adiado (decidido pelo operador)" substitui o que estiver escrito antes sobre acordar.

## Global Constraints

- **O que acorda.** Assentado e adiado acordam **só** com: pergunta aberta, falha do turno (resultado com erro que não seja interrupção pedida pelo operador; sessão `dead`), aviso de trabalho interrompido do reinício com motivo diferente de `queued`, ou aviso de limite de uso.
  - Turno que só terminou (`needs_attention`) **não** acorda.
  - `working` **não** acorda.
  - Agendamento e tarefa encaminhada **não** acordam.
- **Assentar ou adiar marca o terminal como lido.** Isso zera o `unread` local e envia `mark_read` para cada sessão viva do projeto.
- **Opções de adiar:** **1 h**, **até amanhã às 9:00** e **até segunda às 9:00**, todas no fuso do navegador e enviadas como horário absoluto. "Amanhã às 9 h" escolhido entre 0 h e 5 h significa o mesmo dia às 9 h.
- **Desfazer:** cada ação do operador vale **5 s**. `Ctrl+Z` é ignorado quando o foco está num campo (`isForeignField` de `web/src/keyboard.ts`). O botão "Desfazer" do aviso faz o mesmo.
- **Combinações:**
  - Fixar e assentar se excluem: assentar tira o pin.
  - Assentado e adiado se excluem: a ação nova substitui a anterior.
  - Adiar mantém o pin, e o cartão some dos Fixados até voltar.
- **Faixa Trabalhando:**
  - Entra quem tem sessão `working`, está compactando (`compactingSince`) ou está `in_terminal` processando, inclusive os assentados. Adiados não entram.
  - Cada linha mostra ícone, nome, motor e estado, **sem rostinho**.
  - O clique abre o chat.
  - A faixa some quando vazia e pode ser recolhida; a escolha fica em `localStorage`.
- **AGENTS.md:** os rostinhos e as bolinhas mantêm a animação, e a interface roda sem GPU. Mudar o status de uma sessão **não pode remontar cartões**: só ação do operador, ou um assentado que acorda, move cartão de seção. Nenhuma animação nova.
- **Lateral estreita (trilho):** mostra os Fixados no topo e os terminais da faixa Trabalhando como ícones. Assentados e Adiados não aparecem no trilho.
- **Arrastar:** só nos setores e grupos, como hoje. Dentro de Fixados vale a ordem global (`sortOrder`); cartões escondidos não ocupam posição.
- **Rota antiga da ⭐:** `PATCH /api/projects/:id/favorite` passa a fixar ou desfixar **para o usuário que clicou**. A coluna `projects.favorite` fica no banco e deixa de ser usada pela interface.
- **Textos:** pt-BR, en e es, com as mesmas chaves nas três línguas.
- **Testes:**
  - Servidor (Node 24): `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>`.
  - Web: `cd web && npx vitest run <arquivo>`; `npx tsc -b`.
- **Ensaio:** só na instância isolada desta trilha, na **porta 9196** e com dados em `/tmp/claudinei-e2e-triagem`. Nunca nas portas 9105, 9198 ou 9199, e nunca no `claudinei.service`.

## Review Focus

1. **Um adiamento vence com a página aberta.** O cartão volta sozinho na hora, sem recarregar. Teste na Task 3 (`nextExpiry`) e na Task 4 (relógio falso).
2. **Usuário sem acesso ao projeto.** Ele não vê o estado de triagem do projeto (o GET filtra pelo acesso) e não consegue mudá-lo (403). Teste na Task 1.
3. **Dois usuários no mesmo projeto.** A ação de um não chega ao outro pelo WebSocket, nem para o admin. O despertar, porém, vale para todos. Teste nas Tasks 1 e 2.
4. **`Ctrl+Z` com o cursor no chat, no terminal ou na busca.** Desfaz o texto, não a triagem. Teste na Task 5.
5. **Assentado que começa a trabalhar.** Aparece na faixa Trabalhando e continua em Assentados, sem acordar. Teste na Task 3.

---

### Task 1: Tabela, migração, rotas e WebSocket por usuário

**Files:**
- Modify: `server/src/db.ts`: tabela nova e migração única, junto das outras.
- Create: `server/src/triage/store.ts`
- Create: `server/src/routes/triage.ts`
- Modify: `server/src/routes/projects.ts:163-172`: a rota da ⭐ passa a fixar para o usuário.
- Modify: `server/src/routes/ws.ts:39-51`: `canSee` trata a mensagem `triage`.
- Modify: `server/src/app.ts`: cria o store e registra as rotas.
- Test: `server/test/triage-store.test.ts`, `server/test/triage-routes.test.ts`. Atualizar `server/test/projects-favorites.test.ts` para o comportamento novo da rota da ⭐.

**Interfaces:**
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS user_triage (
    user_id INTEGER NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pinned_at TEXT, settled_at TEXT, snoozed_until TEXT,
    PRIMARY KEY (user_id, project_id))
  ```
  Sem FK para `users`, porque o usuário `0` não existe lá, como em `user_prefs`.
- Migração única, marcada em `settings` com a chave `triage_favorites_migrated`: para cada usuário, e para o usuário `0`, fixar os projetos com `favorite = 1` a que ele tem acesso. Admin e usuário `0` têm acesso a todos; os outros, aos de `user_projects`.
- Produces:
  ```ts
  export interface TriageDto { projectId: number; pinned: boolean; settled: boolean; snoozedUntil: string | null } // snoozedUntil vencido → null
  export type WakeReason = 'question' | 'failed' | 'dead' | 'interrupted' | 'usage_limit'
  export function createTriageStore(db: Db): {
    list(userId: number): TriageDto[]                    // só linhas com algo aplicado
    get(userId: number, projectId: number): TriageDto
    update(userId: number, projectId: number, p: { pinned?: boolean; settled?: boolean; snoozedUntil?: string | null }): TriageDto
    wakeProject(projectId: number): number[]             // tira settled/snoozed de todos; devolve os userIds afetados
  }
  export type TriageStore = ReturnType<typeof createTriageStore>
  export function migrateFavoritesToPins(db: Db): void
  ```
- Regras de `update`, nesta ordem:
  - `settled: true` zera o pin e o adiamento.
  - `snoozedUntil` não nulo zera o `settled`.
  - `pinned: true` zera o `settled`.
- Rotas:
  - `GET /api/triage` → `TriageDto[]` do usuário, filtrado por `canAccessProject`.
  - `PATCH /api/projects/:id/triage` → `TriageDto`.
    - 400 se nenhum campo vier, se um campo tiver o tipo errado, ou se `snoozedUntil` não for uma data ISO futura.
    - 403 sem acesso. Token de serviço → 403 com a mensagem `token de serviço não tem triagem`.
  - Id de armazenamento, como em `routes/prefs.ts`: `authUser` ausente → `0`; usuário → `id`; serviço → `null`.
- WebSocket: `{ type: 'triage', userId: number, item: TriageDto }`. Em `canSee`, **antes** do atalho de admin: `msg.type === 'triage'` só passa para o cliente cujo id de armazenamento é igual a `msg.userId`, e ninguém mais o vê, nem o admin.

- [ ] **Step 1: Escrever os testes que falham.**
  - `triage-store.test.ts`:
    - `sem linha, nada aplicado`.
    - `assentar tira o pin e o adiamento`.
    - `adiar tira o assentado e mantém o pin`.
    - `fixar tira o assentado`.
    - `snoozedUntil vencido é lido como null`.
    - `wakeProject limpa settled e snoozed de todos os usuários, mantém o pin e devolve os afetados`.
    - `apagar o projeto apaga a triagem`.
    - `migração: favorite=1 vira pin para admin, para o usuário 0 e para quem tem acesso; quem não tem acesso não ganha`.
    - `migração roda uma vez só`: rodar de novo depois de desfixar não refixa.
  - `triage-routes.test.ts`, no padrão de `auth-rbac.test.ts`:
    - `PATCH grava e o GET devolve`.
    - `400 sem campos`.
    - `400 com snoozedUntil no passado`.
    - `403 sem acesso e o GET não lista o projeto`.
    - `token de serviço recebe 403`.
    - `WS triage chega só ao próprio usuário (nem ao admin)`.
    - `rota da ⭐ fixa para quem clicou e não para os outros`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** Datas em ISO UTC, com `new Date().toISOString()`.
- [ ] **Step 4: Rodar e ver passar** os arquivos novos, `projects-favorites.test.ts`, `projects.test.ts`, `auth-ws.test.ts` e `db.test.ts`.
- [ ] **Step 5: Commit** `feat(triagem): estado de triagem por usuário, rotas e WS`.

### Task 2: O despertador

**Files:**
- Create: `server/src/triage/wake.ts`
- Modify: `server/src/claude/manager.ts`: dep nova `onNeedsOperator`, chamada no handler de `status` (~:326) e no de `event` (~:382).
- Modify: `server/src/restart/boot.ts:102-106`: `publish` avisa quando o aviso fica retido.
- Modify: `server/src/app.ts` e `server/src/index.ts`: amarração com referência mutável, como `onRestartReady` e o `drain`.
- Test: `server/test/triage-wake.test.ts`

**Interfaces:**
- Consumes: `createTriageStore`, `WakeReason` (Task 1).
- Produces:
  ```ts
  export function createTriageWaker(deps: { store: TriageStore; broadcast: (msg: object) => void }): {
    wake(projectId: number, reason: WakeReason): void   // wakeProject + broadcast { type:'triage', userId, item } por afetado; não faz nada se ninguém foi afetado
  }
  export type TriageWaker = ReturnType<typeof createTriageWaker>
  // manager Deps:
  onNeedsOperator?: (projectId: number, reason: 'question' | 'failed' | 'dead') => void
  // createRestartService deps (opcional):
  onHeld?: (projectId: number) => void   // publish com interruption.reason !== 'queued'
  ```
- Quando o manager chama `onNeedsOperator`, sempre em try/catch como os outros ganchos:
  - `question`: no `status`, quando `session.pendingQuestion` passa de ausente a presente. Guarde o último valor por `localId`, para não chamar de novo a cada status.
  - `failed`: no `result` com `isError` e `subtype !== 'interrupted'`.
  - `dead`: no `status === 'dead'`, fora do encerramento (`!isShuttingDown()`).
- O `usage_limit` fica pronto no tipo para o projeto 6 chamar `waker.wake(projectId, 'usage_limit')`. Esta trilha não o chama.

- [ ] **Step 1: Escrever os testes que falham.** Com o `fake-claude.mjs`, no padrão de `server/test/manager-restart.test.ts`:
  - `pergunta aberta acorda o assentado e o adiado` (`faz-pergunta`).
  - `turno com erro acorda`.
  - `sessão morta acorda` (`crash`).
  - `turno normal não acorda` (o `needs_attention` não basta).
  - `working não acorda` (`demorada`).
  - `morte no encerramento não acorda` (com `beginShutdown`).
  - `aviso retido do reinício acorda; queued não`, usando `createRestartService` com o `onHeld` espião.
  - `o pin sobrevive ao despertar`.
  - `o broadcast vai uma vez por usuário afetado`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** este arquivo, `manager-restart.test.ts`, `restart-boot.test.ts`, `manager.test.ts` e `ask-user-question.test.ts`.
- [ ] **Step 5: Commit** `feat(triagem): terminal assentado ou adiado volta quando precisa do operador`.

### Task 3: Camada de dados da web e divisão em seções

**Files:**
- Modify: `web/src/types.ts` (`TriageItem`, igual ao `TriageDto`).
- Modify: `web/src/api.ts`: `fetchTriage(): Promise<TriageItem[]>`, `setTriage(projectId, p): Promise<TriageItem>`. `setProjectFavorite` sai de uso na lateral.
- Modify: `web/src/store.ts`:
  - `triage: Record<number, TriageItem>` e `setTriageItem(item)`;
  - a mensagem WS `triage`;
  - limpar em `setAuth('locked')`.
- Create: `web/src/useTriageSync.ts`. Lê `fetchTriage` quando o app fica pronto e a cada `progressEpoch`, no padrão de `web/src/useTerminalStatesSync.ts`. Montado em `App.tsx`.
- Create: `web/src/triageSections.ts`
- Test: `web/src/test/triage-sections.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TriageState = 'pinned' | 'settled' | 'snoozed' | 'none'
  export function triageStateOf(item: TriageItem | undefined, now: number): TriageState      // snoozed vencido → pinned/none
  export function splitSections(entries: Entry[], triage: Record<number, TriageItem>, now: number): {
    pinned: Project[]   // na ordem global (sortOrder), na mesma passagem
    tree: Entry[]       // a árvore sem fixados, assentados e adiados; contêiner vazio some
    snoozed: Project[]  // ordem: volta mais cedo primeiro
    settled: Project[]
  }
  export function isWorking(projectId: number, sessions: Record<string, SessionInfo>): boolean // working | compactingSince | in_terminal processando
  export function nextExpiry(triage: Record<number, TriageItem>, now: number): number | null   // menor snoozedUntil futuro (ms)
  export function snoozeUntil(choice: '1h' | 'tomorrow' | 'monday', now: Date): Date
  ```
- Para saber se o `in_terminal` está processando, use a mesma fonte que o `faceStateOf` usa hoje (`AgentFace.tsx`).
- Os filtros "só ativos" e "só fixados" e a busca valem para as quatro seções. Aplicar `filterEntries` antes de `splitSections`, com `favoritesOnly` lendo o pin: `filterEntries` ganha o parâmetro `isPinned: (id: number) => boolean` no lugar de `p.favorite`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `splitSections tira fixados, assentados e adiados da árvore e esvazia o grupo que sobrou vazio`.
  - `adiado fixado fica só em Adiados até vencer`.
  - `adiado vencido volta aos Fixados`.
  - `ordem de Fixados segue o sortOrder global`.
  - `snoozeUntil`:
    - 1 h;
    - amanhã às 9:00;
    - às 02:00 vira hoje às 9:00;
    - segunda às 9:00, numa sexta;
    - segunda às 9:00 numa segunda às 10:00 vira a próxima segunda.
  - `nextExpiry ignora vencidos e devolve o menor`.
  - `isWorking: working, compactando e in_terminal processando sim; idle e needs_attention não`.
  - `assentado trabalhando continua em settled (não acorda no cliente)`.
  - `só fixados usa o pin, não projects.favorite`.
  - `mensagem WS triage atualiza o store`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** este arquivo, `sidebar-entries.test.ts` e `sidebar-search.test.tsx`.
- [ ] **Step 5: Commit** `feat(triagem): estado de triagem na web e divisão em seções`.

### Task 4: As seções na lateral, a faixa Trabalhando e o trilho

**Files:**
- Create: `web/src/components/WorkingStrip.tsx`
- Modify: `web/src/components/Sidebar.tsx`
  - Seções Fixados (topo, depois da faixa), Adiados e Assentados (fim, recolhidas por padrão, com `localStorage`).
  - A ⭐ fixa pelo `setTriage`.
  - A chave "só favoritos" vira "só fixados".
  - A busca abre Adiados e Assentados.
  - O trilho ganha Fixados no topo e os ícones da faixa.
  - O relógio de `nextExpiry`.
- Modify: `web/src/styles.css`: classes novas com variáveis de tema, sem animação.
- Modify: `web/src/i18n/{pt-BR,en,es}.ts`
- Test: `web/src/test/sidebar-triage.test.tsx`. Atualizar `web/src/test/sidebar-favorites.test.tsx`.

**Interfaces:**
- Consumes: Task 3.
- `WorkingStrip` é um `memo` sem props, que lê do store só o mínimo para isso: a lista de `[projectId, engine, statusKey]` dos terminais trabalhando, com `useShallow` ou comparação por string. Status de terminais fora da faixa não renderizam a faixa.
- Cartões:
  - continuam com `key={p.id}`, montados pela mesma `renderCard`;
  - cada seção é um contêiner próprio e estável, sempre montado na mesma posição, mesmo vazio, com `display:none`;
  - a mudança de status de sessão não troca nenhum cartão de seção.
- Adiado mostra no cartão "volta às HH:MM", ou "volta seg. 9:00".

- [ ] **Step 1: Escrever os testes que falham:**
  - `seções na ordem: Trabalhando, Fixados, árvore, Adiados, Assentados`.
  - `a ⭐ fixa e o cartão vai para Fixados`.
  - `Adiados e Assentados começam recolhidos e a busca os abre`.
  - `faixa some vazia e lista assentado trabalhando, não adiado`.
  - `clique na linha da faixa abre o chat`.
  - `trilho: fixados no topo, ícones da faixa, sem assentados/adiados`.
  - `adiado volta sozinho ao vencer` (relógio falso: avançar até o `snoozedUntil` e o cartão volta à árvore).
  - **`mudar o status de uma sessão não remonta cartões`**: guardar o nó do DOM de dois cartões, mudar o status de uma sessão de `idle` para `working` e de volta, e esperar os **mesmos nós** (`toBe`).
  - **`a faixa não renderiza com status de quem está fora dela`**: `Profiler` em volta da `WorkingStrip`, contando commits ao mudar o status de um terminal ocioso para ocioso e lido; esperado 0.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte da web e o `tsc -b`.**
- [ ] **Step 5: Commit** `feat(triagem): seções Fixados, Adiados, Assentados e faixa Trabalhando`.

### Task 5: Ações no menu, marcar como lido e desfazer

**Files:**
- Modify: `web/src/components/TerminalMenu.tsx`: **Fixar** / **Desafixar**, **Assentar** / **Tirar dos assentados**, **Adiar ▸** (1 h, amanhã 9:00, segunda 9:00, cancelar o adiamento).
- Create: `web/src/triageActions.ts`
- Create: `web/src/components/UndoToast.tsx`, montado no `App`.
- Modify: `web/src/store.ts`: `undo: { label: string; projectId: number; before: TriageItem; expiresAt: number } | null`.
- Modify: i18n nas três línguas e `UX-CONTRACT.md` (seção "Triagem da lista", na raiz do repositório).
- Test: `web/src/test/triage-actions.test.tsx`

**Interfaces:**
- Consumes: Tasks 3 e 4, `isForeignField` (`web/src/keyboard.ts`), `WsContext`.
- Produces:
  ```ts
  export async function applyTriage(projectId: number, patch: { pinned?: boolean; settled?: boolean; snoozedUntil?: string | null }, label: string, ws: { send(m: object): void } | null): Promise<void>
  //   guarda o estado anterior em `undo` (5 s), chama setTriage, aplica a resposta;
  //   se settled:true ou snoozedUntil != null → zera unread local das sessões do projeto e manda mark_read de cada sessão viva
  export async function undoTriage(): Promise<void>   // restaura `before` (pinned/settled/snoozedUntil) e limpa `undo`
  ```
- `UndoToast` mostra o rótulo e o botão **Desfazer**, e some em 5 s.
- Listener global de `keydown`: `Ctrl+Z` ou `Cmd+Z` com `undo` vigente e `!isForeignField(e.target, null)` → `preventDefault` + `undoTriage`.
- Erro na rota: o estado local volta e aparece um aviso, como o `favoriteSaveError` de hoje.

- [ ] **Step 1: Escrever os testes que falham:**
  - `menu mostra Fixar/Assentar/Adiar e chama setTriage com o horário absoluto`.
  - `assentar marca como lido (unread zerado e mark_read enviado por sessão viva)`.
  - `Desfazer no aviso restaura o estado anterior`.
  - `Ctrl+Z desfaz em até 5 s; depois de 5 s não faz nada`.
  - `Ctrl+Z com foco no campo do chat, na busca ou no terminal não desfaz a triagem`.
  - `falha da rota volta o estado e mostra o aviso`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte da web, o `tsc -b` e a suíte do servidor uma vez.**
- [ ] **Step 5: Commit** `feat(triagem): fixar, assentar e adiar pelo menu, com desfazer`.

### Task 6: Ensaio de ponta a ponta numa instância isolada (porta 9196)

**Files:** nenhum de produção. Os scripts do ensaio ficam em `/tmp/claudinei-e2e-triagem-scripts/`.

- [ ] **Step 1: Subir a instância isolada da worktree na porta 9196**, com dados em `/tmp/claudinei-e2e-triagem`, conforme a memória `verificar-e2e-sem-reiniciar`.
  - Usar `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_PKG_NATIVE -u CLAUDINEI_PKG_WEB`.
  - Usar `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs` e o Node 24.
  - Gerar `npm run build -w web` antes.
  - Parar a instância só pelo PID da porta 9196, conferindo que não é o da 9105. Nunca usar `pkill -f`.
- [ ] **Step 2: Pela API e por capturas com Playwright,** em `/home/coppi/Projects/57-FXNCredible/new-frontend/node_modules/playwright/index.mjs`, com o Chromium em `/home/coppi/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`. Esperado:
  - fixar, assentar e adiar três terminais;
  - o assentado que recebe `faz-pergunta` volta à árvore;
  - um turno `demorada` aparece na faixa e não acorda o assentado;
  - um `crash` acorda o adiado;
  - `Ctrl+Z` desfaz;
  - o trilho mostra os Fixados.
- [ ] **Step 3: Limpar:** apagar `/tmp/claudinei-e2e-triagem*` e `~/.claude/projects/-tmp-claudinei-e2e-triagem*`, e registrar o resultado no relatório.
