# Conversa virtualizada e busca na conversa — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Só as mensagens perto da tela existem na página, rolar para cima carrega a conversa até o começo, e Ctrl+F busca a conversa inteira do terminal no servidor, levando à ocorrência com a dobra aberta.

**Architecture:**
- **Servidor:** lê o histórico de trás para a frente a partir de um byte e devolve cada evento com a posição (byte) da sua linha. A rota de histórico fica paginada por byte, e uma rota nova de busca varre uma janela de bytes por pedido.
- **Web:** cada `ChatItem` ganha uma chave estável derivada da posição. Com essa chave:
  - o refetch do fim de turno reaproveita os objetos que não mudaram;
  - as páginas antigas entram pelo topo;
  - o estado das dobras vai para o store.
- **Lista:** passa a ser o `react-virtuoso`. A barra de busca chama a rota em fatias até o começo, o teto ou o cancelamento.

**Tech Stack:** Node 24 + TypeScript + Fastify (servidor); React + zustand + i18next + react-virtuoso (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-conversa-e-busca-design.md`. As "Decisões depois da revisão do desenho", no fim do spec, prevalecem sobre o texto anterior: posição por byte, rota `{ events, before, atStart }`, busca em fatias, Ctrl+F no campo de mensagem e regra do OpenCode.

## Global Constraints

- **Posição** = byte de início da linha do evento no arquivo da engine. É estável porque os históricos só crescem no fim. Nada de "ordinal desde o começo" e nada de `total`.
- **Rota de histórico:** `GET /api/sessions/:localId/history?before=<byte>&limit=<n>` responde `{ events, before, atStart }`. Não há formato antigo a manter: o único consumidor é `web/src/api.ts`.
- **Tamanhos:** primeira carga de ~300 eventos (`HISTORY_EVENT_LIMIT = 300`); página de **200** ao subir; teto de **500** ocorrências por busca ("500+ — refine a busca").
- **Busca:** roda ao apertar Enter, em fatias de **8 MB** por pedido. Uma "rodada" vai até **64 MB** varridos; passou disso sem chegar ao começo, oferece "buscar mais para trás". É cancelável (Esc ou nova busca) e não usa índice nenhum.
- **Comparação:** sem distinção de maiúsculas nem de acentos ("reinicio" acha "reinício").
- **O que a busca cobre:**
  - **Padrão:** só o que aparece sem abrir ferramentas: mensagens do operador, respostas do agente, cartões de tarefa, agendamento e Claudinei, e o resumo da compactação. Mensagem de subagente conta.
  - **Com "incluir ferramentas":** acrescenta entradas e saídas de ferramentas e o raciocínio do agente.
  - Texto injetado pelo motor (`fromEngine`) nunca conta.
- **Ctrl+F:** abre a busca do Claudinei com o foco no chat, no campo de mensagem ou em nada. Em outro campo de texto, num modal ou no terminal interativo, fica o Ctrl+F do navegador. Com a barra aberta, um novo Ctrl+F não é interceptado. Esc fecha.
- **OpenCode, primeira versão:** só o trecho que o leitor dele já devolve hoje, com posições sintéticas (índice) e `atStart: true`. A busca dele cobre esse trecho.
- **Sem GPU (AGENTS.md, `/home/coppi/Projects/61-Claudinei/claudinei/AGENTS.md`):**
  - nada de animação contínua;
  - a barra de busca fica no topo da coluna do chat, sem animação;
  - nenhuma regra troca `content-visibility` por foco, hover ou clique (o teste-guarda continua);
  - rostinhos e bolinhas intocados.
- **Testes:**
  - servidor com Node 24: `cd server && PATH=/usr/local/n/versions/node/24.15.0/bin:$PATH npx vitest run <arquivo>` e `npx tsc --noEmit`;
  - web: `cd web && npx vitest run <arquivo>` e `npx tsc -b`.
- **Dependência nova:** `npm install react-virtuoso -w web`, na raiz do worktree. O `node_modules` do worktree é um symlink para o da `main`, então a instalação cai lá também; isso é aceitável. Commitar `web/package.json` e `package-lock.json`.
- **Textos de tela:** nas três línguas (pt-BR com acentos, en, es). Comentários de código em português.
- **Ensaio:**
  - instância isolada na porta **9197**, dados em `/tmp/claudinei-e2e-conversa`;
  - nunca 9105, 9198 ou 9199; parar pelo PID da própria porta, nunca `pkill -f`.

## Review Focus

1. **Corte de página no meio de uma ferramenta.** Às vezes o `tool_use` cai na página antiga e o `tool_result` na mais nova. Hoje `applyEvent` descarta o resultado sem chamada, e o cartão ficaria sem resultado para sempre. O esperado é que, ao carregar a página antiga, o cartão apareça com o resultado. Teste na Task 3.
2. **Refetch do fim de turno com páginas antigas carregadas.** O operador subiu até o começo, e o turno termina. O refetch traz só o fim, e as mensagens antigas não podem sumir. Teste na Task 3.
3. **Dobra aberta num item do turno ao vivo.** O item ainda tem chave provisória quando o histórico confirma. O operador abriu um grupo de ações enquanto o agente trabalhava, e a dobra continua aberta depois da confirmação. Teste na Task 4.
4. **Ctrl+F onde não é do chat.** Na busca da lateral, num modal, no editor de arquivo ou no terminal interativo, fica o Ctrl+F do navegador. Teste na Task 6.
5. **Busca durante o streaming.** Os eventos novos que chegam não desalinham as ocorrências já achadas (chave por posição), e ir a uma ocorrência não tira o "grudado no fim" de quem não pediu. Teste na Task 6.

---

### Task 1: Leitura posicionada de trás para a frente e página de histórico por engine

**Files:**
- Modify: `server/src/tail.ts`. Adicionar `readLinesBefore` e `readPositionedTail`; `parseFromTail` continua igual.
- Create: `server/src/history-page.ts`, com tipos e a ponte por engine.
- Modify: `server/src/history.ts` (Claude), `server/src/engine/codex/rollout.ts`, `server/src/engine/kimi/kimi-history.ts`. Cada um ganha um parser de linhas posicionadas que reaproveita o parser de texto atual por linha. No Codex, o estado `preTokens` vale para a janela inteira.
- Modify: `server/src/engine/types.ts`, com `readHistoryPage?` opcional em `Engine`; `server/src/engine/claude-engine.ts`, `codex/codex-engine.ts` e `kimi/kimi-engine.ts` implementam.
- Test: `server/test/history-page.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  // tail.ts
  export interface PositionedLine { text: string; pos: number }
  export function readLinesBefore(file: string, before: number | undefined, maxBytes: number):
    Promise<{ lines: PositionedLine[]; start: number; atStart: boolean }>
  export function readPositionedTail<T>(file: string, parseLines: (lines: PositionedLine[]) => T[],
    opts: { before?: number; minItems: number; maxBytes?: number; firstChunkBytes?: number }):
    Promise<{ items: T[]; start: number; atStart: boolean }>
  // history-page.ts
  export type PositionedEvent = AgentEvent & { pos: number }
  export interface HistoryPage { events: PositionedEvent[]; start: number; atStart: boolean }
  export interface HistoryPageOptions { before?: number; minItems: number; maxBytes?: number; firstChunkBytes?: number }
  export function readPage(engine: Engine, projectPath: string, id: string, opts: HistoryPageOptions): Promise<HistoryPage>
  //  usa engine.readHistoryPage se existir; senão (OpenCode) readHistory com pos = índice, start 0, atStart true
  // types.ts — Engine
  readHistoryPage?(projectPath: string, engineSessionId: string, opts: HistoryPageOptions): Promise<HistoryPage>
  ```
- **Regras:**
  - A janela de `readLinesBefore` é `[max(0, before − maxBytes), before)`, com `before` ausente = tamanho do arquivo.
  - Se a janela não começa no byte 0, a primeira linha, partida, é descartada, e `start` é o byte depois dela.
  - `pos` é absoluto.
  - `readPositionedTail` cresce a janela 4× como `parseFromTail`, até `minItems` itens, `maxBytes` (padrão 256 MB) ou o começo.

- [ ] **Step 1: Testes que falham** (arquivos sintéticos em tmpdir):
  - `readLinesBefore devolve posições absolutas e descarta a linha partida`: um arquivo de 3 linhas conhecidas, `before` no meio da 3ª. As linhas são a 1ª e a 2ª, com `pos` iguais aos bytes reais, e `atStart` é `true`.
  - `páginas sucessivas cobrem o arquivo sem repetir nem pular`: 1000 linhas e páginas de `minItems: 200` encadeando `before = start`. A união dos `pos` é igual a todos os inícios de linha, e a última página tem `atStart`.
  - `Claude: readHistoryPage dá pos de cada evento e o mesmo conteúdo do readHistory` (transcript sintético).
  - `Codex: compact_boundary mantém pre_tokens dentro da janela`.
  - `Kimi: turn.prompt vira evento com pos`.
  - `OpenCode sem readHistoryPage: readPage numera por índice e atStart true` (engine falsa).
  - `UTF-8 multibyte na borda da janela não vira lixo`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, junto de `history-tail.test.ts`, `codex-rollout.test.ts` e `kimi-history.test.ts`.
- [ ] **Step 5: Commit** `feat(conversa): leitura do histórico em páginas por posição`.

### Task 2: Rotas de histórico paginado e de busca

**Files:**
- Modify: `server/src/routes/sessions.ts`, com a rota de histórico no formato novo, inclusive no caminho de prévia sem `engineSessionId`.
- Create: `server/src/history-search.ts`, com a extração do texto pesquisável e a varredura de uma fatia.
- Create: `server/src/routes/history-search.ts`, registrado onde `sessions.ts` é registrado e com o mesmo controle de acesso (`requireProjectAccess`).
- Test: `server/test/history-routes.test.ts`, `server/test/history-search.test.ts`. Ajustar o teste de teto em `server/test/routes-sessions.test.ts:410` para o formato novo.

**Interfaces:**
- Consumes: `readPage`, `PositionedEvent` (Task 1).
- Produces:
  ```ts
  // rota: GET /api/sessions/:localId/history?before=<int>=0>&limit=<1..500>
  //   → { events: PositionedEvent[]; before: number; atStart: boolean }
  //   sem limit: HISTORY_EVENT_LIMIT (300); os eventos são os ÚLTIMOS `limit` da janela lida;
  //   `before` = pos do primeiro evento devolvido (ou start da janela se vier vazia)
  // history-search.ts
  export type SearchField = 'text' | 'thinking' | 'tool_input' | 'tool_output'
  export interface SearchHit { pos: number; toolUseId?: string; field: SearchField; snippet: string }
  export function normalizeForSearch(s: string): string   // NFD, sem \p{M}, toLowerCase
  export function searchableTexts(evt: AgentEvent, tools: boolean): { field: SearchField; text: string; toolUseId?: string }[]
  export function searchEvents(events: PositionedEvent[], q: string, tools: boolean): SearchHit[]  // da mais nova para a mais antiga
  // rota: GET /api/sessions/:localId/search?q=<2..200 chars>&tools=0|1&before=<int>
  //   → { hits: SearchHit[]; before: number; atStart: boolean }   (uma fatia de 8 MB por pedido)
  ```
- **Regras de `searchableTexts`:**
  - usuário com `fromEngine` → nada;
  - texto de usuário (inclui `[Task from …]`, agendamento, Claudinei e o resumo da compactação) → `text`;
  - texto do assistente → `text`;
  - `thinking`, `tool_use.input` (JSON) e `tool_result` → só com `tools`;
  - `tool_result` leva `toolUseId`;
  - `snippet` tem até 120 caracteres em volta da ocorrência.
- `q` inválido → 400.

- [ ] **Step 1: Testes que falham:**
  - `histórico sem parâmetros devolve os últimos 300 com before e atStart false num arquivo maior`.
  - `before encadeado chega ao começo com atStart true`.
  - `limit fora de 1..500 e before negativo dão 400`.
  - `prévia sem engineSessionId usa o mesmo formato`.
  - `normalizeForSearch iguala acento e caixa`: `'Reinício'` e `'reinicio'` normalizam igual.
  - `busca padrão ignora ferramentas, raciocínio e fromEngine; com tools=1 acha neles`.
  - `cartão de tarefa e resumo da compactação contam como texto`.
  - `fatia devolve before para continuar e atStart no fim`: arquivo de 20 MB sintético, com três pedidos encadeados.
  - `hit de tool_result traz toolUseId`.
  - `sem acesso ao projeto, 403` (padrão de `auth-rbac.test.ts`).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** Ler a fatia com `readPage(..., { before, minItems: Infinity, maxBytes: 8 MB, firstChunkBytes: 8 MB })`.
- [ ] **Step 4: Rodar e ver passar**, mais a suíte inteira do servidor uma vez.
- [ ] **Step 5: Commit** `feat(conversa): histórico paginado e busca na conversa no servidor`.

### Task 3: Chaves estáveis, refetch sem reconstruir e páginas antigas no topo

**Files:**
- Modify: `web/src/types.ts`: `ClaudeEvent` ganha `pos?: number` nos tipos com conteúdo, e `ChatItem` ganha `key?: string` em todas as variantes.
- Modify: `web/src/chat/applyEvent.ts`, onde as chaves nascem.
  - Com `pos`: o 1º item do evento é `p<pos>` e os seguintes `p<pos>.1`, `p<pos>.2`…
  - Sem `pos`, ao vivo: `l<n>` de um contador do módulo.
  - O resultado de ferramenta mantém a chave do `tool_call`.
  - Trocar o `next.map` do `tool_result` por `findLastIndex` mais uma cópia só daquele item: o reduce de milhares de eventos não pode ser quadrático.
- Create: `web/src/chat/reconcile.ts`.
- Modify: `web/src/store.ts`:
  - `addLocalUserText` usa a chave `l<n>`;
  - `setHistory` passa a ser `setHistoryTail`;
  - entram `prependHistory`, `historyCursor` e `orphanResults`.
- Modify: `web/src/api.ts`, com `fetchHistory(localId, before?, limit?)` devolvendo `{ events, before, atStart }`.
- Modify: `web/src/components/ChatView.tsx`, só no efeito de carga. Sai o `mergeEngineFlags` por comprimento, e entra `setHistoryTail`.
- Test: `web/src/test/history-pages.test.ts`, `web/src/test/perf-render.test.tsx` (caso novo).

**Interfaces:**
- Produces:
  ```ts
  // reconcile.ts
  export function itemsEqual(a: ChatItem, b: ChatItem): boolean          // rasa, campo a campo
  export function reconcileByKey(prev: ChatItem[], next: ChatItem[]): { items: ChatItem[]; renamed: Record<string, string> }
  //  reaproveita o objeto de prev quando a chave casa e itemsEqual; itens ao vivo (l…) do fim de prev
  //  casam com os confirmados (p…) do fim de next por kind+texto, e entram em `renamed` (velha → nova)
  export function reducePage(events: ClaudeEvent[]): { items: ChatItem[]; orphanResults: Record<string, { result: string; isError: boolean }> }
  // store
  historyCursor: Record<string, { before: number; atStart: boolean }>
  setHistoryTail(localId: string, page: { events: ClaudeEvent[]; before: number; atStart: boolean }): void
  //  acha a 1ª chave da página nova nos itens atuais: mantém o prefixo anterior + reconcileByKey do resto;
  //  sem interseção, substitui tudo e reinicia o cursor; aplica `renamed` às dobras (Task 4)
  prependHistory(localId: string, page: { events: ClaudeEvent[]; before: number; atStart: boolean }): void
  //  reducePage, descarta chaves já presentes, preenche tool_call sem resultado com orphanResults guardados, põe no topo
  ```

- [ ] **Step 1: Testes que falham:**
  - `applyEvent dá p<pos> e p<pos>.1 a um evento com texto e tool_use`.
  - `evento ao vivo ganha l<n> e o tool_result mantém a chave do tool_call`.
  - `reconcileByKey reaproveita o mesmo objeto quando nada mudou`: `toBe`, não `toEqual`.
  - `refetch do fim mantém as páginas antigas carregadas` (Review Focus 2).
  - `página antiga com o tool_use preenche o resultado que chegou antes, órfão` (Review Focus 1).
  - `prependHistory não duplica chaves`.
  - `reduce de 5000 eventos com tool_result fica abaixo de 200 ms` (orçamento folgado; pega o quadrático).
  - Em `perf-render.test.tsx`: `o refetch do fim de turno não re-renderiza blocos que não mudaram`. O `<Profiler>` conta zero commits nos `MessageBlock` antigos.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, com `applyEvent.test.ts`, `scheduled-message.test.tsx` e `restart-notice.test.tsx`.
- [ ] **Step 5: Commit** `feat(conversa): chaves estáveis, refetch sem reconstruir e páginas antigas`.

### Task 4: Estado das dobras no store

**Files:**
- Create: `web/src/chat/folds.ts`.
- Modify: `web/src/store.ts`, com o slice `folds` e a migração por `renamed`.
- Modify: `web/src/components/MessageBlock.tsx`. Os `useState` de dobra nas linhas ~158 (resumo da compactação), ~193, ~280 e ~316 ("mostrar tudo") passam a `useFold`. Os menus das linhas ~575 e ~630 ficam como estão.
- Modify: `web/src/components/ActionGroup.tsx` (~18), `web/src/components/ToolCallCard.tsx` (~30).
- Test: `web/src/test/folds.test.tsx`.

**Interfaces:**
- Consumes: `ChatItem.key`, `renamed` (Task 3).
- Produces:
  ```ts
  export type FoldName = 'group' | 'tool' | 'more' | 'summary'
  export function foldId(itemKey: string, name: FoldName): string          // `${itemKey}:${name}`
  export function useFold(localId: string, itemKey: string | undefined, name: FoldName): [boolean, (open: boolean) => void]
  //  sem itemKey (item legado): cai no estado local, como hoje
  // store
  folds: Record<string, Record<string, true>>          // localId → foldId → aberto
  setFold(localId: string, id: string, open: boolean): void
  renameFolds(localId: string, renamed: Record<string, string>): void
  ```
- O grupo de ações usa a chave do 1º item do grupo. O seletor é estreito, `(s) => !!s.folds[localId]?.[id]`, para que abrir uma dobra não re-renderize as outras.

- [ ] **Step 1: Testes que falham:**
  - `dobra aberta sobrevive a desmontar e montar o bloco`.
  - `abrir um grupo não re-renderiza os outros MessageBlock` (Profiler).
  - `dobra de item ao vivo continua aberta depois que o histórico confirma` (Review Focus 3, via `setHistoryTail` com `renamed`).
  - `resumo da compactação, mostrar tudo e cartão de ferramenta usam a mesma dobra do store`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, com os testes de `MessageBlock`, `ActionGroup` e `ToolCallCard` existentes.
- [ ] **Step 5: Commit** `feat(conversa): dobras abertas guardadas no store`.

### Task 5: Lista virtual com react-virtuoso

**Files:**
- Modify: `web/package.json` e `package-lock.json` (`npm install react-virtuoso -w web`).
- Modify: `web/src/components/ChatView.tsx`.
  - O `map` em `.chat-scroll__inner` vira `<Virtuoso>`.
  - Saem `bottomRef`, o `ResizeObserver` e o efeito de `scrollIntoView`; o seguir o fim passa para a biblioteca.
  - `StreamingPreview`, `RunningSubagents`, `BackgroundProcesses` e os pontinhos vão para o `Footer`.
  - O `chat-tofoot` continua, usando `scrollToIndex({ index: 'LAST' })`.
- Create: `web/src/chat/nodes.ts`, com a chave de nó, a partir de `groupActions` (sem mudar `grouping.ts`).
- Modify: `web/src/styles.css`. Tirar `content-visibility`/`contain-intrinsic-size` de `.chat-entry`, que brigam com a medição da biblioteca.
- Modify: `web/src/test/chat-entry-visibility.test.ts`. A primeira asserção passa a ser "`.chat-entry` não usa `content-visibility`: a lista virtual já tira o que está fora da tela". A segunda, nenhuma regra por foco/hover/clique, continua intacta.
- Test: `web/src/test/chat-virtual.test.tsx`, com `VirtuosoMockContext` do react-virtuoso.

**Interfaces:**
- Consumes: `prependHistory`, `historyCursor`, `fetchHistory` (Task 3); `useFold` (Task 4).
- Produces:
  ```ts
  export function nodeKey(node: ChatNode): string   // msg: item.key ?? `i${index}`; grupo: `g:${primeiraChave}`
  export const FIRST_INDEX = 1_000_000              // firstItemIndex = FIRST_INDEX − itens já acrescentados no topo
  // ChatView: <Virtuoso ref data={nodes} firstItemIndex computeItemKey={(_, n) => nodeKey(n)}
  //   followOutput={following ? 'auto' : false} atBottomThreshold={80} atBottomStateChange={setFollowing}
  //   startReached={carregarAnteriores} increaseViewportBy={{ top: 600, bottom: 600 }}
  //   components={{ Header, Footer }} />
  // Header: "início da conversa" quando historyCursor.atStart; senão "carregando…" durante o pedido
  // carregarAnteriores: fetchHistory(localId, cursor.before, 200) → prependHistory; um pedido por vez
  ```
- O handle do Virtuoso fica exposto num ref do módulo da conversa, para a Task 6 rolar até um índice.

- [ ] **Step 1: Testes que falham:**
  - `com 3000 itens monta só os perto da tela`: menos de 60 `.chat-entry`.
  - `chegar ao topo pede a página anterior com before do cursor e limit 200`.
  - `acrescentar no topo mantém o item que estava na tela`: o primeiro visível tem a mesma chave antes e depois.
  - `no começo mostra "início da conversa" e não pede mais`.
  - `grudado no fim acompanha item novo; solto não`.
  - `chat-tofoot volta ao fim`.
  - Os testes existentes de `ChatView` (por exemplo `chatview*.test.tsx`) continuam passando, adaptados ao mock de viewport onde medem DOM.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Instalar o react-virtuoso e implementar.**
- [ ] **Step 4: Rodar a suíte inteira da web e `npx tsc -b`.** Verde.
- [ ] **Step 5: Commit** `feat(conversa): lista virtual na conversa`.

### Task 6: Busca na conversa (Ctrl+F)

**Files:**
- Modify: `web/src/keyboard.ts`.
- Create: `web/src/chat/find.ts`, com a lógica pura: localizar a ocorrência e decidir quais dobras abrir.
- Create: `web/src/components/FindBar.tsx`, montado no topo da coluna do chat em `ChatView`.
- Modify: `web/src/store.ts`, com o slice `find`.
- Modify: `web/src/api.ts`, com `searchHistory`.
- Modify: `web/src/types.ts`, com `SearchField` e `SearchHit` iguais aos do servidor (Task 2).
- Modify: `web/src/components/MessageBlock.tsx` e `ActionGroup.tsx`, com a classe `chat-hit` no item da ocorrência atual. O seletor é estreito: `s.find?.currentKey === key`.
- Modify: `web/src/styles.css` (`.find-bar`, `.chat-hit`, sem animação); `web/src/i18n/{pt-BR,en,es}.ts`; `UX-CONTRACT.md`, com a seção "Conversa e busca".
- Test: `web/src/test/chat-find.test.tsx`, `web/src/test/keyboard.test.ts` (casos novos).

**Interfaces:**
- Consumes: `fetchHistory`/`prependHistory`/`historyCursor` (Task 3), `setFold`/`foldId` (Task 4), o handle do Virtuoso e `nodeKey` (Task 5); a rota de busca (Task 2).
- Produces:
  ```ts
  // keyboard.ts
  export function shouldOpenFind(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'target'>,
    chatInput: HTMLElement | null, barOpen: boolean): boolean
  //  Ctrl/⌘+F sem Shift/Alt; false com a barra aberta; true no chatInput; false em isForeignField(target, chatInput),
  //  em .xterm / [data-terminal] e dentro de [role="dialog"]
  // api.ts
  export function searchHistory(localId: string, q: string, tools: boolean, before?: number, signal?: AbortSignal):
    Promise<{ hits: SearchHit[]; before: number; atStart: boolean }>
  // find.ts
  export function locateHit(items: ChatItem[], hit: SearchHit): string | null
  //  chave `p<pos>` ou começando por `p<pos>.`; para tool_output/tool_input, o tool_call com id === toolUseId
  export function foldsToOpen(nodes: ChatNode[], items: ChatItem[], itemKey: string, field: SearchField): string[]  // foldIds
  //  dentro de grupo → 'group'; campos de ferramenta → 'tool'; texto longo recolhido → 'more'; resumo → 'summary'
  // store
  find: null | { localId: string; q: string; tools: boolean; hits: SearchHit[]; index: number; scanning: boolean;
                 before: number | null; atStart: boolean; scannedBytes: number; capped: boolean; currentKey: string | null }
  ```
- **Fluxo:**
  - Enter na barra começa a busca: pedidos encadeados por `before` até `atStart`, 500 ocorrências ou 64 MB na rodada.
  - Passados os 64 MB sem chegar ao começo, aparece "buscar mais para trás".
  - Nova busca ou Esc cancelam o pedido (`AbortController`).
  - `index 0` é a ocorrência mais recente. Enter vai para a mais antiga seguinte, Shift+Enter volta.
  - **Ir a uma ocorrência:**
    1. `prependHistory` em páginas de 200 até `locateHit` achar;
    2. abre as dobras de `foldsToOpen`;
    3. `scrollToIndex({ index, align: 'center' })`;
    4. marca `currentKey`.
  - Ir a uma ocorrência solta o "grudado no fim", porque é o operador que pediu. Chegar evento novo não move a tela.
  - O destaque do termo é escolha de quem constrói: por exemplo a CSS Custom Highlight API sobre as entradas montadas, sem mexer no DOM, ou `<mark>` só no texto simples. Em qualquer caso, só o que está montado é pintado.
- **Textos (pt-BR):**
  - `find.placeholder` "Buscar na conversa"
  - `find.count` "{{i}} de {{n}}"
  - `find.scanning` "{{n}} encontrados até agora…"
  - `find.more` "buscar mais para trás"
  - `find.capped` "500+ — refine a busca"
  - `find.tools` "incluir ferramentas"
  - `find.none` "nada encontrado"
  - `chat.startOfConversation` "início da conversa"
  - `chat.loadingOlder` "carregando mensagens anteriores…"

- [ ] **Step 1: Testes que falham:**
  - `shouldOpenFind: campo do chat abre; busca da lateral, modal, editor e terminal não; barra aberta não intercepta` (Review Focus 4).
  - `Enter encadeia fatias até atStart e acumula ocorrências na ordem`.
  - `para em 500 e mostra "500+"`.
  - `para em 64 MB e oferece buscar mais para trás`.
  - `Esc cancela o pedido em andamento` (o `signal` é abortado).
  - `ir a uma ocorrência antiga carrega páginas até achar, abre o grupo e marca chat-hit`.
  - `ocorrência em saída de ferramenta abre grupo e cartão`.
  - `evento novo durante a busca não muda o índice atual nem rola a tela` (Review Focus 5).
  - `"reinicio" acha "reinício"` (servidor falso devolvendo o hit, e a barra mostra 1 de 1).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar a suíte inteira da web e `npx tsc -b`.** Verde.
- [ ] **Step 5: Commit** `feat(conversa): busca na conversa com Ctrl+F`.

### Task 7: Ensaio de ponta a ponta na porta 9197

**Files:** nenhum de produção. O roteiro fica em `/tmp/claudinei-e2e-conversa/`.

- [ ] **Step 1: Montar a conversa sintética.** Gerar uma conversa longa do Claude, de **5000+ eventos**: texto, `tool_use`/`tool_result` e um resumo de compactação. Colocar um termo único, por exemplo `marcador-inicio-7731`, só nas primeiras linhas e outro dentro de uma saída de ferramenta antiga. Gravar em `/tmp/claudinei-e2e-conversa/claude/projects/<cwd codificado>/<id>.jsonl`.
- [ ] **Step 2: Subir a instância.** Construir a web (`npm run build -w web`) e subir na **9197**, com estas variáveis:
  - `CLAUDE_CONFIG_DIR=/tmp/claudinei-e2e-conversa/claude`;
  - `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs`;
  - as `env -u` das regras (CLAUDECODE, CLAUDE_CODE_*, CLAUDINEI_HERMES_*, CLAUDINEI_PKG_*);
  - DB, uploads, schedules, speech e progress em `/tmp/claudinei-e2e-conversa`.

  Criar a conta e um projeto apontando para a pasta da conversa. Abrir a sessão com `continueConversation: true`, que mostra a prévia da conversa sintética.
- [ ] **Step 3: Medir no Chromium sem GPU** (Playwright, `--disable-gpu`):
  - número de `.chat-entry` no DOM, que deve ficar abaixo de 60;
  - rolagem até o começo, até aparecer "início da conversa";
  - Ctrl+F com `marcador-inicio-7731`: acha e leva até a ocorrência;
  - o termo da saída de ferramenta só aparece com "incluir ferramentas", e a dobra abre;
  - tempo total da busca.

  Anotar também o número de nós no DOM da mesma conversa na `main` (antes), para comparar.
- [ ] **Step 4: Streaming.** Mandar `demorada` pelo fake e conferir que a tela segue o fim. Soltar a rolagem e conferir que um evento novo não puxa a tela.
- [ ] **Step 5: Encerrar.** Parar a instância pelo PID da 9197, conferindo que não é o da 9105. Apagar `/tmp/claudinei-e2e-conversa` e as pastas `~/.claude/projects/-tmp-…` criadas. Registrar números e capturas no relatório.
