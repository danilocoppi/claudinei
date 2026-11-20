# Campo de mensagem e fila editável — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modo Zen (Alt+Z), guardar o prompt (Ctrl+S), colar texto grande como anexo, fila editável do próximo turno (por terminal, no servidor) e o aviso de terminal sem motor instalado.

**Architecture:**
- **Navegador (localStorage):** Zen, os rascunhos guardados e o colar grande, como o `railMode` e os rascunhos de hoje.
- **Servidor:** guarda a fila por **terminal** (projeto + motor), numa tabela nova. Por ser por terminal, ela migra sozinha para uma sessão nova.
- **Quem entrega:** um árbitro do "próximo envio", ligado ao `onSessionAvailable` do manager. Ele consulta uma lista ordenada de fornecedores: aqui, a fila do operador no lugar 3 e as tarefas de outros agentes no lugar 5.
- **Integração:** a trilha paralela (delegar e goals) acrescenta os lugares 4 e 6 sem reescrever o árbitro.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 (servidor); React + zustand + i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-campo-e-fila-design.md` (inclui "Decisões depois da revisão" e "Ordem única do próximo envio").

## Global Constraints

- Mensagem no meio do turno:
  - **Claude e Codex:** Enter continua entrando no turno atual. **Alt+Enter** manda para a fila.
  - **Kimi e OpenCode:** Enter no meio do turno vai para a fila.
  - A preferência do operador vale sempre: mensagem nova é **acréscimo**, nunca cancelamento.
- **Fila:**
  - Até **20 itens** por terminal; cada item tem até **120 000 bytes** (o `MAX_PROMPT_BYTES` do Kimi e do OpenCode).
  - Entrega **um** item por turno.
- **A fila pausa** em quatro casos: erro do turno, limite de uso, interrupção pelo operador e morte real da sessão. A parada do encerramento do serviço não conta. Só **Retomar fila** tira a pausa; mandar mensagem normal não tira.
- **A fila segura** enquanto houver aviso aberto. Vale para os lugares 3–6, inclusive as tarefas de outros agentes.
  - Aviso aberto: terminal com `interruptedAt != null` ou `limitActive(row)` (`server/src/restart/boot.ts`).
  - Pausa e segurar são coisas diferentes: fila pausada não bloqueia as tarefas de outros agentes.
- **Ordem do árbitro:** lugar 3 (fila do operador) antes do lugar 5 (tarefas de outros agentes). Os lugares 1–2 (compactação, retomada do Claudinei) não passam pelo árbitro. Eles ocupam a sessão por conta própria, e o árbitro só entrega a uma sessão livre (`idle` | `needs_attention`).
- **Colar grande:** acima de **10 240 bytes** ou **100 linhas** vira `colado-HHMMSS.txt`. **Ctrl+Shift+V** cola como texto.
- **Ctrl+S:**
  - Guarda até **10** rascunhos por terminal (`projectId:engine`), com o mapa token→caminho dos anexos, em `localStorage['claudinei:stash']`.
  - Com o campo vazio, devolve o último.
  - Sempre `preventDefault`.
- **Zen:** **Alt+Z**, persistido em `localStorage['claudinei:zen']`. Ignorado com o foco no terminal interativo (`.xterm`). Um botão "sair do Zen" fica visível no modo.
- **Uploads:** a rotação passa a ser **por idade**: apaga o que tem mais de **30 dias**, com teto de segurança de **5 000** arquivos.
- **Interface sem GPU** (AGENTS.md): nada de animação contínua nova; usar as variáveis de tema.
- **Textos:** os de tela nas três línguas (pt-BR com acentos, en, es). Comentários de código em português.
- **Testes:** do servidor com Node 24: `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>` e `npx tsc --noEmit`. Da web: `cd web && npx vitest run <arquivo>` e `npx tsc -b`.
- **Ensaio:** só na porta **9196**, dados em `/tmp/claudinei-e2e-campo`. Nunca 9105, 9198 ou 9199.

## Review Focus

1. **Duas sessões livres seguidas.** `idle` logo seguido de `needs_attention`, ou dois `onSessionAvailable` no mesmo tique, entregam **um** item só, não dois. Teste na Task 7.
2. **Envio que falha.** A sessão morreu entre o "livre" e o envio, ou `manager.send` lançou. O item volta para o começo da fila, que pausa com `error`. Nada se perde. Teste na Task 6.
3. **Aviso aberto com a sessão livre.** Um terminal tem o aviso de interrompido ou de limite, e a sessão ociosa recebe um `onSessionAvailable`. Nem a fila nem a tarefa de outro agente são entregues. Quando o aviso sai (× / Continuar), o árbitro é cutucado e entrega. Teste na Task 7.
4. **Encerramento do serviço.** O `stopAll` do encerramento não pausa a fila; depois do boot ela continua. Teste na Task 7.
5. **Ctrl+S ou Alt+Enter com upload em andamento** (`uploading > 0`). Não guarda nem enfileira um texto com token sem caminho. A tecla é ignorada até o upload terminar, como o Enviar já faz. Testes nas Tasks 3 e 8.

---

### Task 1: Uploads por idade e checagem de anexos

**Files:**
- Modify: `server/src/uploads.ts` (`rotateUploads`)
- Modify: `server/src/routes/uploads.ts` (rota nova)
- Test: `server/test/uploads.test.ts`, `server/test/routes-uploads.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // uploads.ts
  export function rotateUploads(dir: string, opts?: { maxAgeMs?: number; hardCap?: number; now?: number }): void
  //   apaga arquivos com mtime < now - maxAgeMs (padrão 30 dias); passando de hardCap (padrão 5000), apaga os mais velhos excedentes
  export function missingUploads(dir: string, paths: string[]): string[]
  //   devolve os caminhos que não existem; caminho fora de `dir` (resolve + startsWith) conta como ausente, sem tocar o disco
  // routes/uploads.ts
  // POST /api/uploads/check  body { paths: string[] } (até 200)  → { missing: string[] }; 400 se não for array de strings
  ```

- [ ] **Step 1: Testes que falham.**
  - `rotação por idade apaga só o que passou de 30 dias`: três arquivos, com `utimesSync` em 31 d, 29 d e agora. Fica com 2.
  - `teto de segurança apaga os mais velhos excedentes`: `hardCap: 3` e 5 arquivos novos. Ficam os 3 mais novos.
  - `missingUploads aponta ausentes e recusa caminho fora da pasta`: `../etc/passwd` está em `missing`.
  - `POST /api/uploads/check devolve os ausentes` e `rejeita corpo inválido com 400`.
  - `cem uploads não apagam o primeiro (era o teto antigo)`.
- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run test/uploads.test.ts test/routes-uploads.test.ts`
- [ ] **Step 3: Implementar.** A rota de upload chama `rotateUploads(deps.uploadsDir)` sem `KEEP`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(campo): uploads vivem 30 dias e checagem de anexos ausentes`

### Task 2: Modo Zen

**Files:**
- Modify: `web/src/store.ts`: `zen` e `toggleZen`, no molde do `railMode` (`:17`, `:373-385`).
- Create: `web/src/useZenShortcut.ts`
- Modify: `web/src/App.tsx`: esconde `Sidebar`, `SidebarResizer` e `MobileTopbar` quando `zen`; monta o atalho e o botão de sair.
- Modify: `web/src/components/ChatView.tsx`: esconde `.chat-header` e `ProgressColumn` quando `zen`.
- Modify: `web/src/keyboard.ts`: adiciona `isTerminalTarget`.
- Modify: `web/src/styles.css` (`.zen-exit`), `web/src/i18n/{pt-BR,en,es}.ts` (`zen.exit`, `zen.hint`).
- Test: `web/src/test/zen.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // store.ts
  zen: boolean; toggleZen(): void     // ZEN_KEY = 'claudinei:zen'; '1' | '0'
  // keyboard.ts
  export function isTerminalTarget(target: EventTarget | null): boolean   // dentro de '.xterm'
  // useZenShortcut.ts
  export function useZenShortcut(): void   // Alt+Z (sem Ctrl/Meta/Shift, !isComposing, !isTerminalTarget) → toggleZen + preventDefault
  ```

- [ ] **Step 1: Testes que falham.**
  - `Alt+Z esconde lateral, cabeçalho e coluna e mostra o botão de sair`.
  - `Alt+Z de novo traz tudo de volta`.
  - `o botão sair do Zen desliga o modo`.
  - `persiste em localStorage claudinei:zen`.
  - `Alt+Z dentro do terminal interativo não faz nada`: alvo dentro de `<div class="xterm"><textarea/></div>`.
  - `avisos e campo continuam visíveis no Zen`: o `ChatInput` e o `InterruptedNotice` seguem montados.
- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run src/test/zen.test.tsx`
- [ ] **Step 3: Implementar.** O botão `.zen-exit` é estático: canto superior direito, `position: fixed`, sem animação.
- [ ] **Step 4: Rodar e ver passar** `zen.test.tsx`, `chatview.test.tsx` e `sidebar-rail.test.tsx`.
- [ ] **Step 5: Commit** `feat(campo): modo Zen esconde a moldura (Alt+Z)`

### Task 3: Guardar o prompt (Ctrl+S)

**Files:**
- Create: `web/src/stash.ts`
- Create: `web/src/components/StashMenu.tsx`
- Modify: `web/src/components/ChatInput.tsx`: Ctrl+S no `onKeyDown` do campo, ícone dos guardados e restauração com anexos.
- Modify: `web/src/api.ts` (`checkUploads`), `web/src/i18n/*` (`stash.*`), `web/src/styles.css`.
- Test: `web/src/test/stash.test.ts`, `web/src/test/chatinput-stash.test.tsx`

**Interfaces:**
- Consumes: `POST /api/uploads/check` (Task 1).
- Produces:
  ```ts
  // stash.ts — STASH_KEY = 'claudinei:stash'; Record<terminalKey, StashEntry[]> (mais novo no fim)
  export interface StashEntry { text: string; attachments: Array<[token: string, path: string]>; savedAt: number }
  export const STASH_MAX = 10
  export const stashKey = (projectId: number, engine: string) => `${projectId}:${engine}`
  export function readStash(key: string): StashEntry[]
  export function pushStash(key: string, entry: StashEntry): void     // passando de 10, sai o mais antigo; cota cheia descarta de outros terminais, como drafts.ts
  export function popStash(key: string): StashEntry | undefined       // tira e devolve o mais novo
  export function takeStash(key: string, index: number): StashEntry | undefined
  // api.ts
  export const checkUploads = (paths: string[]) => Promise<{ missing: string[] }>
  // ChatInput: token ausente vira `[📎 <nome> — <t('stash.missing')>]` e NÃO entra no mapa de anexos (o texto vai como está)
  ```

- [ ] **Step 1: Testes que falham.**
  - `stash.test.ts`:
    - `guarda até 10 e descarta o mais antigo`.
    - `popStash devolve o mais novo e o tira`.
    - `takeStash pelo índice`.
    - `lixo no localStorage vira lista vazia`.
  - `chatinput-stash.test.tsx`:
    - `Ctrl+S com texto guarda e limpa o campo (preventDefault)`.
    - `Ctrl+S com o campo vazio traz o último, com o anexo funcionando no envio`: o `send_message` sai com o caminho no lugar do token.
    - `anexo apagado volta marcado como não disponível e o envio não quebra`: mock de `checkUploads` com `missing`.
    - `Ctrl+S com upload em andamento não faz nada`.
    - `o menu dos guardados mostra a contagem e restaura um item escolhido`.
    - `guardados são do terminal (projeto+motor), não da sessão`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** O ícone (🗂 + contagem) só aparece com a lista não vazia.
- [ ] **Step 4: Rodar e ver passar**, junto com `draft-input.test.tsx` e `chatinput-upload.test.tsx`.
- [ ] **Step 5: Commit** `feat(campo): Ctrl+S guarda o prompt para depois, com anexos`

### Task 4: Colar texto grande vira anexo

**Files:**
- Create: `web/src/paste.ts`
- Modify: `web/src/components/ChatInput.tsx`: `onPaste` e o `keydown` do Ctrl+Shift+V.
- Test: `web/src/test/chatinput-paste.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export const PASTE_MAX_BYTES = 10_240
  export const PASTE_MAX_LINES = 100
  export function isLargePaste(text: string): boolean        // TextEncoder bytes > 10 240 || linhas > 100
  export function pasteFileName(now?: Date): string          // 'colado-HHMMSS.txt'
  ```
- Ctrl+Shift+V: um `keydown` com Ctrl+Shift+V marca uma ref `colarComoTexto` (válida por 1 s ou até o próximo `paste`). Com ela marcada, o `paste` segue o caminho normal de texto. Não há como ler a tecla no próprio evento `paste`.

- [ ] **Step 1: Testes que falham.**
  - `colar 101 linhas vira anexo .txt e token no cursor`: verifica `uploadFile` com `File` `text/plain` e o nome `colado-…`.
  - `colar 10 241 bytes numa linha vira anexo`.
  - `colar texto pequeno entra no campo como hoje`.
  - `Ctrl+Shift+V cola grande como texto`.
  - `colar arquivo continua como hoje`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar**, reusando `attachFiles([file])`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(campo): colar texto grande vira anexo (Ctrl+Shift+V cola como texto)`

### Task 5: Aviso de terminal sem motor instalado

**Files:**
- Modify: `web/src/components/EngineTabs.tsx`. Quando `visible.length === 0`, renderiza `.engine-tabs__none` no lugar das abas. Um botão "editar" abre `<NewProjectModal editProject={project} …/>` direto no componente, com estado local.
- Modify: `web/src/i18n/*` (`session.noEngineInstalled`, `session.noEngineEdit`), `web/src/styles.css`.
- Test: `web/src/test/engine-tabs-list.test.tsx` (casos novos).

- [ ] **Step 1: Testes que falham.**
  - `lista só com motores desinstalados e sem sessão viva mostra o aviso com editar`.
  - `editar abre o formulário do terminal`.
  - `com um motor instalado na lista, o aviso não aparece`.
  - `sessão viva de motor desinstalado mantém a aba e não mostra o aviso`.
- [ ] **Step 2–4:** Rodar e ver falhar, implementar, rodar e ver passar `engine-tabs-*.test.tsx`.
- [ ] **Step 5: Commit** `feat(campo): aviso de terminal sem nenhum motor instalado`

### Task 6: Fila do operador: tabela, repositório e serviço

**Files:**
- Modify: `server/src/db.ts`: tabelas novas, junto das migrações.
- Create: `server/src/queue/operator-queue.ts`
- Modify: `server/src/claude/manager.ts`: `send(localId, text, opts?: { echo?: boolean })`.
- Modify: `server/src/engine/types.ts`: `EngineCapabilities.midTurnInput?: boolean`.
- Modify: `server/src/engine/claude-engine.ts` e `server/src/engine/codex/codex-engine.ts` (`midTurnInput: true`). Kimi e OpenCode omitem o campo, que vale `false`.
- Test: `server/test/operator-queue.test.ts`

**Interfaces:**
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS operator_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    engine TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_opq_terminal ON operator_queue(project_id, engine, position);
  CREATE TABLE IF NOT EXISTS operator_queue_state (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, engine TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, PRIMARY KEY (project_id, engine));
  ```
- Produces:
  ```ts
  export type PauseReason = 'error' | 'limit' | 'interrupted' | 'dead' | 'manual'
  export interface QueueItem { id: number; text: string; createdAt: string }
  export interface QueueDto { projectId: number; engine: string; items: QueueItem[]; paused: boolean; pauseReason: PauseReason | null }
  export const QUEUE_MAX = 20
  export const QUEUE_ITEM_MAX_BYTES = 120_000
  export function createOperatorQueueStore(db: Db): {
    list(projectId: number, engine: string): QueueItem[]
    add(projectId: number, engine: string, text: string): QueueItem   // UserError 'queue_full' | 'queue_item_too_large' | 'queue_item_empty'
    update(id: number, text: string): QueueItem                        // UserError 'queue_item_not_found'
    reorder(projectId: number, engine: string, ids: number[]): void    // ids = permutação exata da fila, senão UserError 'queue_order_mismatch'
    remove(id: number): void
    takeFirst(projectId: number, engine: string): QueueItem | null
    putFirst(projectId: number, engine: string, item: QueueItem): void // devolve à frente (rollback)
    moveToFront(id: number): void
    terminalOf(id: number): { projectId: number; engine: string } | null
    state(projectId: number, engine: string): { paused: boolean; pauseReason: PauseReason | null }
    setPaused(projectId: number, engine: string, reason: PauseReason | null): void
  }
  export type OperatorQueueStore = ReturnType<typeof createOperatorQueueStore>
  export interface SlotContext { projectId: number; engine: string; localId: string }
  export function createOperatorQueueService(deps: {
    store: OperatorQueueStore
    manager: Pick<SessionManager, 'send' | 'interrupt' | 'get' | 'list'>
    broadcast: (msg: object) => void           // { type: 'operator_queue', projectId, engine, queue: QueueDto }
    holds: (projectId: number, engine: string) => boolean
    acceptsMidTurn: (engine: string) => boolean
    liveLocalId: (projectId: number, engine: string) => string | null   // sessão viva do terminal
  }): {
    dto(projectId: number, engine: string): QueueDto
    offer(ctx: SlotContext): boolean          // lugar 3: pausada/vazia → false; tira o 1º, manager.send(localId, text, { echo: true }); falha → putFirst + pausa 'error'
    add(projectId: number, engine: string, text: string): QueueDto   // sessão livre + fila vazia + não pausada + !holds → entrega na hora
    update(id: number, text: string): QueueDto
    reorder(projectId: number, engine: string, ids: number[]): QueueDto
    remove(id: number): QueueDto
    sendNow(id: number): QueueDto             // livre → entrega; trabalhando + acceptsMidTurn → injeta (send); senão moveToFront + marca "interromper para enviar" + manager.interrupt
    pause(projectId: number, engine: string): QueueDto      // reason 'manual'
    resume(projectId: number, engine: string): QueueDto     // tira a pausa e tenta offer se livre
    onTurnResult(projectId: number, engine: string, info: { isError: boolean; interrupted: boolean; limited: boolean }): void
    //   limited → 'limit'; interrupted (sem a marca do sendNow) → 'interrupted'; isError → 'error'; a marca do sendNow é consumida e não pausa
    onSessionDied(projectId: number, engine: string): void  // 'dead'
  }
  export type OperatorQueueService = ReturnType<typeof createOperatorQueueService>
  ```
- `manager.send(localId, text, opts?: { echo?: boolean })`: o `echo` repassa `{ echoToClients: true }` à sessão, para a mensagem da fila aparecer no chat. O resto do `send` fica igual, inclusive `onOperatorMessage`. Esta assinatura é implementada aqui, em `server/src/claude/manager.ts`.

- [ ] **Step 1: Testes que falham** em `operator-queue.test.ts`. Repositório com `openDb(':memory:')`; serviço com um manager falso que registra chamadas.
  - `add respeita 20 itens e 120 000 bytes`.
  - `reorder exige a permutação exata`.
  - `takeFirst e putFirst preservam a ordem`.
  - `apagar o projeto apaga a fila`.
  - `offer entrega um e só um item`: o manager falso troca o status para working.
  - `offer com fila pausada devolve false`.
  - `envio que falha devolve o item à frente e pausa com error`.
  - `add com sessão livre e fila vazia entrega na hora`.
  - `add com holds=true guarda e não entrega`.
  - `sendNow em Claude trabalhando injeta`.
  - `sendNow em Kimi trabalhando interrompe e o result interrompido não pausa`.
  - `interrupção do operador pausa com interrupted`.
  - `turno com erro pausa`.
  - `limite pausa com limit`.
  - `onSessionDied pausa com dead`.
  - `resume tira a pausa e entrega se livre`.
  - `cada mudança faz broadcast operator_queue com o DTO`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, junto com `manager.test.ts` e `engine-registry.test.ts`.
- [ ] **Step 5: Commit** `feat(campo): fila do operador por terminal (repositório e serviço)`

### Task 7: Árbitro do próximo envio, ganchos do manager, rotas e amarração

**Files:**
- Create: `server/src/queue/next-send.ts`
- Modify: `server/src/claude/manager.ts`:
  - `onSessionAvailable` ganha o contexto da sessão;
  - `onTurnResult` ganha `interrupted` e `limited`;
  - gancho `onSessionDied`.
- Modify: `server/src/routes/orchestrator.ts`: `drain(projectId): boolean`, que diz se entregou.
- Create: `server/src/routes/operator-queue.ts`
- Modify: `server/src/app.ts`: cria a fila e o árbitro depois do orchestrator e antes do reinício; embrulha o `broadcast` do reinício para cutucar o árbitro; expõe `onNextSendReady` e `onQueueReady`.
- Modify: `server/src/index.ts`: os ganchos do manager leem as referências, e o `both(...)` passa a aceitar N chamadas.
- Test: `server/test/next-send.test.ts`, `server/test/operator-queue-routes.test.ts`, `server/test/routes-orchestrator.test.ts`, `server/test/manager.test.ts`.

**Interfaces:**
- Consumes: Task 6 (`OperatorQueueService`, `SlotContext`); `limitActive` (`restart/boot.ts`); `createTerminalStateStore` (`restart/terminal-state.ts`).
- Produces:
  ```ts
  // next-send.ts
  export interface NextSendProvider { name: string; slot: number; offer(ctx: SlotContext): boolean }
  export function holdsForNotice(row: TerminalStateRow, now?: number): boolean   // row.interruptedAt != null || limitActive(row, now)
  export function createNextSend(deps: {
    providers: NextSendProvider[]                        // ordenados por slot; integração acrescenta 4 e 6
    holds: (projectId: number, engine: string) => boolean
    isFree: (localId: string) => boolean                 // status idle | needs_attention, sessão viva
    liveLocalId: (projectId: number, engine: string) => string | null
    log?: (m: string) => void
  }): {
    onSessionAvailable(ctx: SlotContext): void           // holds → nada; senão o 1º provider (por slot) que devolver true encerra; cada offer reconfere isFree
    poke(projectId: number, engine: string): void        // acha a sessão viva livre do terminal e roda onSessionAvailable
    register(p: NextSendProvider): void                  // gancho da integração
  }
  export type NextSend = ReturnType<typeof createNextSend>
  // manager.ts Deps
  onSessionAvailable?: (projectId: number, ctx?: { localId: string; engine: EngineId }) => void   // segundo argumento novo
  onTurnResult?: (projectId: number, engine: EngineId, info: { isError: boolean; interrupted: boolean; limited: boolean }) => void
  onSessionDied?: (projectId: number, engine: EngineId) => void   // status 'dead' && !shuttingDown
  // orchestrator.ts: drain(projectId: number): boolean
  ```
- **Rotas** (todas com `requireProjectAccess` e `hasEngine`; erros `UserError` → 400 com `code`):
  - `GET /api/projects/:id/terminals/:engine/queue` → `QueueDto`
  - `POST …/queue` com `{ text }` → `QueueDto` (201)
  - `PATCH …/queue/:itemId` com `{ text }`
  - `PUT …/queue/order` com `{ ids }`
  - `DELETE …/queue/:itemId`
  - `POST …/queue/:itemId/send-now`
  - `POST …/queue/pause`
  - `POST …/queue/resume`
  - Um item de outro terminal na URL responde 404 `queue_item_not_found`.
- **Amarração:**
  - Providers `{ name: 'operator-queue', slot: 3, offer: queue.offer }` e `{ name: 'agent-tasks', slot: 5, offer: (ctx) => orchestrator.drain(ctx.projectId) }`.
  - `onSessionAvailable` sem contexto (testes antigos) cai direto em `drain(projectId)`, como hoje.
  - O `broadcast` do reinício embrulhado chama `nextSend.poke(state.projectId, state.engine)` quando a mensagem é `terminal_state`.

- [ ] **Step 1: Testes que falham.**
  - `next-send.test.ts`, com providers falsos:
    - `entrega pelo menor slot que aceitar`.
    - `com aviso aberto não chama nenhum provider`.
    - `duas sessões livres no mesmo tique entregam uma vez`: o provider marca a sessão como ocupada.
    - `poke depois que o aviso sai entrega`.
    - `register acrescenta um slot entre os existentes`: o slot 4 roda antes do 5.
  - `operator-queue-routes.test.ts`, com o manager real e o `fake-claude.mjs`:
    - `CRUD da fila com acesso por projeto (403 para quem não tem)`.
    - `turno longo + item na fila: entrega quando o turno acaba e ecoa no chat`.
    - `com o terminal interrompido (aviso aberto) nada é entregue; × no aviso entrega`.
    - `stopAll do encerramento não pausa a fila`.
    - `item de outro terminal na URL dá 404`.
  - `routes-orchestrator.test.ts`:
    - `drain devolve true quando entrega e false quando não há nada`.
    - `tarefa de outro agente espera a fila do operador (lugar 3 antes do 5)`.
  - `manager.test.ts`:
    - `onSessionAvailable recebe localId e engine`.
    - `onTurnResult informa interrupted e limited`.
    - `onSessionDied não dispara no encerramento`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte inteira do servidor e o `tsc --noEmit`.** O teste intermitente do orchestrator, se falhar, roda isolado.
- [ ] **Step 5: Commit** `feat(campo): árbitro do próximo envio e rotas da fila`

### Task 8: A fila na interface

**Files:**
- Modify: `web/src/types.ts`: `QueueItem`, `OperatorQueue` e `EngineMeta.midTurnInput?: boolean`.
- Modify: `web/src/store.ts`:
  - `BUILTIN_ENGINES`: `midTurnInput: true` no Claude e no Codex;
  - `queues: Record<string, OperatorQueue>` e `setQueue`;
  - mensagem WS `operator_queue`.
- Create: `web/src/useQueueSync.ts`: lê ao montar e a cada `progressEpoch`.
- Modify: `web/src/api.ts`: `fetchQueue`, `addToQueue`, `editQueueItem`, `reorderQueue`, `removeQueueItem`, `sendQueueItemNow`, `pauseQueue`, `resumeQueue`.
- Create: `web/src/components/QueuePanel.tsx`: montado no `ChatView`, logo acima do `ChatInput`.
- Modify: `web/src/components/ChatInput.tsx`: Alt+Enter, e Enter no Kimi e no OpenCode trabalhando.
- Modify: `web/src/i18n/*` (`queue.*`), `web/src/styles.css`.
- Test: `web/src/test/queue-panel.test.tsx`, `web/src/test/chatinput-queue.test.tsx`

**Interfaces:**
- Consumes: as rotas e a mensagem WS da Task 7.
- Comportamento:
  - O painel lista os itens: texto encurtado numa linha, com ✎ editar (inline), ↑/↓ para reordenar, × remover e "enviar agora".
  - O cabeçalho do painel mostra "fila pausada — <motivo> · Retomar fila" quando pausada. Quando segurando, mostra "esperando o aviso acima". Segurando = `terminalStates[key]` com `interruption` ou `usageLimit` não nulos.
  - Fila vazia e não pausada: o painel não aparece.
  - O texto enfileirado é o mesmo do envio: tokens → caminhos. `!comando` nunca vai para a fila.

- [ ] **Step 1: Testes que falham.**
  - `chatinput-queue.test.tsx`:
    - `Alt+Enter no Claude trabalhando chama addToQueue e limpa o campo`.
    - `Enter no Claude trabalhando continua mandando send_message`.
    - `Enter no Kimi trabalhando vai para a fila`.
    - `Alt+Enter com upload em andamento não faz nada`.
    - `fila pausada no Kimi: Enter entra na fila e o campo avisa fila pausada`.
  - `queue-panel.test.tsx`:
    - `mostra os itens e esconde quando vazia`.
    - `editar, subir, descer, remover e enviar agora chamam a API certa`.
    - `pausada mostra o motivo e Retomar fila`.
    - `segurando por aviso mostra a espera`.
    - `mensagem WS operator_queue atualiza o painel`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte inteira da web e o `tsc -b`.**
- [ ] **Step 5: Commit** `feat(campo): fila editável acima do campo`

### Task 9: Ensaio numa instância isolada (porta 9196)

**Files:** nenhum de produção. Os scripts do ensaio ficam em `/tmp/claudinei-e2e-campo-scripts/`.

- [ ] **Step 1: Subir a instância.** Seguir `/home/coppi/Projects/61-Claudinei/onda-a-regras.md`, com estes ajustes:
  - porta 9196, dados em `/tmp/claudinei-e2e-campo`;
  - `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs` e `CLAUDINEI_KIMI_BIN=<worktree>/server/test/fake-kimi.mjs`;
  - construir a web antes.
- [ ] **Step 2: Fila no Claude.** No terminal Claude:
  1. Mandar `demorada`.
  2. Com Alt+Enter, mandar duas mensagens. O painel mostra 2.
  3. Reordenar; "enviar agora" na segunda. Ela entra no turno: o eco aparece no chat.
  4. Interromper (Esc). A fila pausa com "interrompida".
  5. Retomar fila. O item que sobrou sai no fim do turno seguinte.
  6. Recarregar a página. A fila continua lá.
- [ ] **Step 3: Kimi.** Com o turno longo, Enter vai para a fila. "Enviar agora" interrompe e manda.
- [ ] **Step 4: Aviso segura a fila.**
  1. Num terminal com "Retomar" desligado e um item na fila, mandar `demorada`.
  2. Reiniciar a instância (SIGTERM no PID da 9196).
  3. Depois da subida, o aviso de interrompido aparece e a fila não entrega.
  4. Fechar o aviso com ×. A fila entrega.
- [ ] **Step 5: Campo.**
  1. Ctrl+S guarda um rascunho com anexo e Ctrl+S traz de volta. O envio leva o caminho.
  2. Colar 200 linhas vira `colado-….txt`.
  3. Ctrl+Shift+V cola como texto.
  4. Alt+Z esconde a moldura, e o botão sai do Zen.
  5. Terminal com a lista só de motores desinstalados mostra o aviso com "editar". Para ensaiar, usar uma lista com um id sem binário.
  6. Tirar capturas de tela com o Playwright.
- [ ] **Step 6: Limpar.**
  1. Parar a instância pelo PID da porta 9196, conferindo que não é o PID da 9105.
  2. Apagar `/tmp/claudinei-e2e-campo*` e as pastas `~/.claude/projects/-tmp-claudinei-e2e-campo*`.
  3. Registrar o resultado no relatório da trilha.
