# Respostas visuais: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O agente responde com uma página HTML (`show_page` no Hermes) que aparece na conversa num cartão isolado, uma viva por vez, e confere a página antes num navegador sem tela (`check_page`).

**Architecture:**
- **Servidor, módulo novo `server/src/pages/`.** Guarda a cópia da página (recursos locais embutidos) em `~/.claudinei/pages/<id>.html` e uma linha em `visual_pages`, avisa a tela por WebSocket, lista as páginas da conversa e serve cada uma por um token curto, com CSP e `sandbox` montados a cada pedido.
- **Web, módulo novo `web/src/pages/`.** Um store por `localId`, as âncoras (a chamada `show_page` ou o fim do turno), o cartão `PageCard` com no máximo um iframe vivo, a tela cheia, a nova aba, a lista no menu do terminal e o diálogo do admin.
- **`check_page`** roda no servidor, sobre o `BrowserHost` do projeto 16 (`server/src/browser/host.ts`), e é a última tarefa. Até o aviso do coordenador com o sha do host, as outras tarefas seguem sem ele.
- Mudanças nos arquivos que o 16 também mexe (`run-hermes.ts`, `app.ts`, `index.ts`, `ChatView.tsx`) ficam em poucas linhas, localizadas; a lógica mora nos módulos novos.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 + `@modelcontextprotocol/sdk`/zod (servidor e Hermes); React, zustand, react-virtuoso e i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-respostas-visuais-design.md`, inclusive "Decisões do coordenador" e "Decisões da checagem do construtor". Contrato do host: seção `server/src/browser/host.ts` de `/home/coppi/Projects/61-Claudinei/claudinei-navegador/docs/superpowers/specs/2026-11-21-navegador-embutido-design.md`.

## Global Constraints

- **Id da página:** `pg_` + 16 caracteres hexadecimais minúsculos (`randomBytes(8)`). Reconhecido na web por `/\bpg_[0-9a-f]{16}\b/`.
- **Entrada do `show_page`:** exatamente um de `html` (até **524.288** caracteres) e `path` (`.html` ou `.htm` dentro da pasta do projeto, absoluto ou relativo a ela); `title` de **1 a 120** caracteres; `height` opcional, inteiro de **120 a 2000**. `check_page`: o mesmo `html`/`path` e `width` de **360 a 1920**, padrão **1024**.
- **Teto:** **524.288 bytes UTF-8** no documento final, depois de embutir. Acima, recusa citando os **três** maiores recursos. `bodyLimit` das rotas `POST /api/hermes/pages` e `POST /api/hermes/pages/check`: **2 MiB**.
- **Embutir:** só o que, depois do `realpath`, fica dentro da raiz real do projeto (`isUnderProjectRoot`, `files/scope.ts`). Imagem e fonte viram `data:` (MIME de `PREVIEW_MIME`, `routes/files.ts`), CSS vira `<style>`, JS vira `<script>`. O resto segue como está e vira aviso. Busca por expressão regular, sem parser de HTML.
- **Gravação:** atômica (arquivo temporário + `rename`) em `config.pagesDir` = `CLAUDINEI_PAGES` ou `~/.claudinei/pages`; depois a linha; depois o broadcast `{ type: 'visual_page', projectId, engine, localId, page }`.
- **Token de exibição:** instância própria de `createPreviewStore` (`files/preview.ts`): 32 bytes, **10 min**, preso ao endereço de quem pediu e revalidado por `req.accessAllowed`. A raiz é o arquivo da página.
- **Cabeçalhos da página servida:** `X-Frame-Options: SAMEORIGIN`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=()`.
- **CSP padrão (`cdn`), verbatim, com `<CDN>` = `https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com`:**
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' <CDN>; style-src 'unsafe-inline' <CDN> https://fonts.googleapis.com; font-src data: <CDN> https://fonts.gstatic.com; img-src data: blob: <CDN>; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'`
- **CSP com a rede liberada (`open`), verbatim:** `sandbox allow-scripts; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src *; form-action 'none'; base-uri 'none'`.
- **Configuração:** chave `visualPagesNetwork` em `settings`, `'cdn'` (padrão, também para valor ausente ou desconhecido) ou `'open'`. `GET /api/visual-pages/settings` para todos; `PUT` só admin. Vale na próxima abertura.
- **`Origin: null`:** pedido a `/api/*`, `/ws` ou `/ws/*` com `Origin: null` volta **403**, sempre, inclusive no pré-setup e sem auth configurada.
- **Script de altura:** mede com `ResizeObserver` e manda `parent.postMessage({ type: 'claudinei-page-height', height }, '*')` no máximo a cada **200 ms** e só quando a altura muda **4 px** ou mais.
- **Cartão:** altura inicial = a sugerida ou **360 px**; limite de **120 px** a **70 %** da altura da janela (acima disso a página rola por dentro). Iframe com `sandbox="allow-scripts"`, `referrerPolicy="no-referrer"`, sem `allow` e nunca `srcdoc`. Sem `backdrop-filter`, sombra animada ou miniatura (AGENTS.md). Uma página viva por vez.
- **`check_page`:** `withIsolatedPage({ viewport: { width, height: 800 }, offline: false, timeoutMs: 20_000, queueTimeoutMs: 30_000 })` e `setContent(doc, { loadTimeoutMs: 10_000 })`; com `loaded: true` espera mais **1,5 s**; PNG da página inteira cortado em **2000 px**; até **50** linhas de console, erros primeiro; cópia do PNG em `os.tmpdir()/claudinei-check/`, apagada em **30 min**. Sem semáforo próprio: a fila é do host (`BrowserBusyError`).
- **Hermes:** `show_page` e `check_page` adiadas no Claude, **sem** `_meta['anthropic/alwaysLoad']`. As instructions (`hermes/instructions.ts`) não mudam. Cada descrição tem no máximo **2000** caracteres e é em inglês.
- **Textos da tela** em pt-BR, en e es (`web/src/i18n/*.ts`, namespace `pages`).
- **Ambiente:** `N24=/usr/local/n/versions/node/24.15.0/bin`.
  - servidor: `cd server && PATH=$N24:$PATH npx vitest run <arquivo>`; tipos: `cd server && PATH=$N24:$PATH npx tsc --noEmit`;
  - web: `cd web && npx vitest run <arquivo>`; tipos: `cd web && npx tsc -b` (não commitar `web/tsconfig.tsbuildinfo`);
  - `node_modules` do worktree são symlinks: **nunca** `npm install`;
  - commits só com `git add <arquivos>` explícitos, mensagem terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ensaio:** porta **9197**, dados em `/tmp/claudinei-e2e-visuais`. Nunca a 9105; nunca reiniciar o serviço do Claudinei (AGENTS.md).

## Review Focus

1. **Texto repetido em turnos diferentes.** Dois turnos "continue" (5 e 9), página só no 5, sem chamada visível: o cartão vai ao fim do bloco do turno 5, não ao do 9. Por isso as âncoras usam os turnos reais do desfazer quando carregados e só completam com pseudo-turnos. Teste na Task 7.
2. **Evento antes do resultado da chamada.** Ao vivo, o `visual_page` chega enquanto o `tool_call` do `show_page` ainda não tem resultado. A página aparece no fim do turno e, quando o resultado chega, passa ao lugar da chamada sem aparecer duas vezes e continua viva. Teste na Task 8.
3. **Referências locais esquisitas.** `../` que sai do projeto, symlink para fora, `a.png?v=2#x`, nome com espaço ou `%20`, `url('x')` e `url("x")` com aspas, `data:`/`http:`/`//cdn` ignorados, e um JS embutido com `</script>` no meio (não pode fechar a tag). Teste na Task 2.
4. **Mensagem de altura alheia ou absurda.** `postMessage` de outra janela ou de outro iframe, `height` `NaN`, negativo, string ou `1e9`: o cartão ignora ou limita, sem quebrar. Teste na Task 8.
5. **Tokens cruzados.** O mesmo token não serve outro id; abrir a mesma página no cartão e na tela cheia emite dois tokens; token de outro endereço dá 404; expirado devolve a página de 404 que pede para reabrir pelo Claudinei. Teste na Task 4.

---

### Task 1: Dados: tabela, store, pasta e tipos compartilhados

**Files:**
- Create: `shared/visual-pages.ts`
- Create: `server/src/pages/schema.ts`, `server/src/pages/store.ts`
- Modify: `server/src/db.ts`: uma linha, `migratePages(db)` logo depois de `migrateBranch(db)` (depois da migração de `projects.path`, que recria a tabela).
- Modify: `server/src/config.ts`: `pagesDir: env.CLAUDINEI_PAGES ?? join(homedir(), '.claudinei', 'pages')` em `Config` e `loadConfig`.
- Test: `server/test/pages-store.test.ts`

**Interfaces:**
- Produces, `shared/visual-pages.ts`:
  ```ts
  export const PAGE_ID_RE = /\bpg_[0-9a-f]{16}\b/
  export const PAGE_HEIGHT_MESSAGE = 'claudinei-page-height'
  export type PageNetwork = 'cdn' | 'open'
  export interface VisualPageDto {
    id: string; projectId: number; engine: string; localId: string
    conversationId: string | null; turnId: number | null; turnKey: string | null
    title: string; height: number | null; bytes: number; source: 'html' | 'path'; createdAt: string
  }
  export function pageIdIn(text: string): string | null          // primeiro id do texto
  export function isShowPageName(name: string): boolean           // /(?:^|[^A-Za-z0-9])show_page$/
  ```
- Produces, `schema.ts`: `migratePages(db: Db): void`. Tabela `visual_pages` com `id TEXT PRIMARY KEY`, `project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE`, `engine TEXT NOT NULL`, `local_id TEXT NOT NULL`, `conversation_id TEXT`, `turn_id INTEGER`, `turn_key TEXT`, `title TEXT NOT NULL`, `height INTEGER`, `bytes INTEGER NOT NULL`, `source TEXT NOT NULL`, `source_path TEXT`, `created_at TEXT DEFAULT (datetime('now'))`; índice `idx_visual_pages_conv ON visual_pages(project_id, engine, conversation_id)`.
- Produces, `store.ts`:
  ```ts
  export interface NewPage { id: string; projectId: number; engine: string; localId: string; conversationId: string | null
    turnId: number | null; turnKey: string | null; title: string; height: number | null; bytes: number
    source: 'html' | 'path'; sourcePath: string | null }
  export function createPagesStore(db: Db): {
    insert(p: NewPage): VisualPageDto
    get(id: string): VisualPageDto | undefined
    /** Ordem de criação (created_at, rowid). conversationId null: casa por local_id com conversation_id nulo. */
    listConversation(projectId: number, engine: string, conversationId: string | null, localId: string): VisualPageDto[]
    idsOfTurns(turnIds: number[]): string[]
    idsOfProject(projectId: number): string[]
    allIds(): string[]
    moveTurns(turnIds: number[], conversationId: string): number
    remove(ids: string[]): void
  }
  export type PagesStore = ReturnType<typeof createPagesStore>
  ```

- [ ] **Step 1: Escrever os testes que falham:**
  - `migratePages é idempotente e openDb já cria visual_pages`.
  - `insert e get devolvem o DTO sem source_path`.
  - `listConversation: por conversation_id; sem id, por local_id; ordem de criação; outro motor fica de fora`.
  - `moveTurns troca a conversa só das páginas desses turnos`.
  - `apagar o projeto leva as linhas (cascata)`.
  - `pageIdIn acha pg_ seguido de 16 hex e recusa 15 ou 17`; `isShowPageName: mcp__hermes__show_page, hermes/show_page, hermes_show_page, show_page sim; myshow_page e show_pages não`.
  - `loadConfig: CLAUDINEI_PAGES vence o padrão ~/.claudinei/pages` (em `pages-store.test.ts`, não no `config.test.ts`).
- [ ] **Step 2: Rodar e ver falhar:** `cd server && PATH=$N24:$PATH npx vitest run test/pages-store.test.ts`.
- [ ] **Step 3: Implementar** `shared/visual-pages.ts`, `schema.ts`, `store.ts`, a linha em `db.ts` e o campo em `config.ts`.
- [ ] **Step 4: Rodar e ver passar.** Rodar também `test/db.test.ts` e `test/config.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(páginas): tabela visual_pages, store e pasta das páginas`.

### Task 2: Embutir os recursos locais

**Files:**
- Create: `server/src/pages/embed.ts`
- Modify: `server/src/routes/files.ts`: só `export` em `PREVIEW_MIME`.
- Test: `server/test/pages-embed.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EmbedResult {
    html: string
    embedded: Array<{ ref: string; bytes: number }>   // bytes = tamanho do que entrou no documento
    missing: string[]                                  // ausente, fora do projeto, diretório ou extensão sem MIME
  }
  /** baseDir: pasta do .html (path) ou raiz do projeto (html). projectRoot: raiz do projeto. Síncrona. */
  export function embedLocalResources(html: string, opts: { baseDir: string; projectRoot: string }): EmbedResult
  ```
- Alvos: `img[src]`, `link[rel=stylesheet][href]` (atributos em qualquer ordem), `script[src]` e `url(...)` em `<style>`, em `style="…"` e dentro do CSS embutido. O `url()` do CSS embutido resolve a partir da pasta do arquivo CSS.
- Referência ignorada (sem aviso): com esquema (`http:`, `https:`, `data:`, `blob:`, `mailto:`), `//…` e `#…`. Antes de resolver, tira `?…` e `#…` e aplica `decodeURI` (com falha, usa o texto cru).
- Saída:
  - `<img src="data:<mime>;base64,…">`;
  - `<link rel=stylesheet>` vira `<style>…</style>`;
  - `<script src>` vira `<script` + os outros atributos + `>…</script>`, com `</script` do conteúdo escrito como `<\/script`.
  - A mesma referência repetida é lida uma vez.

- [ ] **Step 1: Escrever os testes que falham.** Pasta temporária com `proj/` (`img/a.png`, `css/s.css` com `url(../img/a.png)`, `js/app.js`, `fonts/f.woff2`) e um `fora/b.png`:
  - `img local vira data:image/png;base64 e entra em embedded com os bytes`.
  - `link stylesheet vira <style> e o url() de dentro resolve a partir da pasta do CSS`.
  - `script src vira script inline e mantém type="module"`.
  - `url() em <style> e em style= com e sem aspas`.
  - `fonte woff2 vira data:font/woff2`.
  - `http:, https:, //cdn, data: e #âncora ficam como estão e sem aviso`.
  - `../fora/b.png e symlink para fora: ficam como estão e entram em missing`.
  - `arquivo ausente e extensão sem MIME entram em missing`.
  - `a.png?v=2#x e "img/com%20espaco.png" resolvem o arquivo`.
  - `JS com "</script>" no meio não fecha a tag` (o documento de saída tem exatamente um `</script>` por script).
  - `com html, a base é a raiz do projeto; com path, a pasta do .html`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run test/pages-embed.test.ts`.
- [ ] **Step 3: Implementar `embedLocalResources`.** Um `replace` por alvo, com expressões regulares não gulosas; `realpathSync` + `statSync().isFile()` + `isUnderProjectRoot(real, { path: projectRoot })`.
- [ ] **Step 4: Rodar e ver passar.** Rodar também `test/files-preview.test.ts` e `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(páginas): embutir imagens, CSS, JS e fontes locais`.

### Task 3: Publicar: serviço, rota do Hermes e `show_page`

**Files:**
- Create: `server/src/pages/service.ts`, `server/src/pages/routes.ts`
- Modify: `server/src/app.ts`: cria o serviço e registra as rotas depois do `createUndo` (≈ 10 linhas, num bloco só). Declarar `let pages: PagesService | undefined` no início do `buildApp`, para as tarefas 6 e 12 lerem.
- Modify: `server/src/hermes/run-hermes.ts`: só o `registerTool('show_page', …)`.
- Test: `server/test/pages-publish.test.ts`, `server/test/hermes-pages.test.ts`, `server/test/helpers/hermes.ts` (cópia de `hermesCall` e `fakeApi` de `hermes-mode.test.ts`; esse arquivo não muda)

**Interfaces:**
- Consumes: `createPagesStore` (Task 1), `embedLocalResources` (Task 2), `resolveInScope`/`isUnderProjectRoot` (`files/scope.ts`).
- Produces, `service.ts`:
  ```ts
  export const PAGE_HTML_MAX_CHARS = 524_288
  export const PAGE_MAX_BYTES = 524_288
  export interface PageSourceInput { html?: unknown; path?: unknown }
  export interface PublishInput extends PageSourceInput { projectId: number; engine: string; title?: unknown; height?: unknown }
  export interface PagesDeps {
    db: Db
    dir: string
    projects: { get(id: number): { id: number; path: string } | undefined }
    liveSession(projectId: number, engine: string): { localId: string; engineSessionId: string | null } | undefined
    openTurn(localId: string): { turnId: number; turnKey: string | null } | undefined
    broadcast(msg: object): void
    log?: (m: string) => void
  }
  export function createPagesService(deps: PagesDeps): {
    /** Valida a fonte, lê, embute e aplica o teto. Lança UserError. */
    buildDocument(projectId: number, src: PageSourceInput): { html: string; bytes: number; source: 'html' | 'path'; sourcePath: string | null; warnings: string[] }
    publish(input: PublishInput): { id: string; bytes: number; warnings: string[] }
    get(id: string): VisualPageDto | undefined
    filePath(id: string): string
    store: PagesStore
  }
  export type PagesService = ReturnType<typeof createPagesService>
  export function registerPageRoutes(app: FastifyInstance, deps: { pages: PagesService; manager: Pick<SessionManager, 'get'>; settings: SettingsService }): void
  ```
- Códigos de recusa (`UserError`, 400 salvo indicação):
  - `page_source`: `html` e `path` juntos ou nenhum;
  - `page_title`;
  - `page_height`;
  - `page_path`: fora do projeto, extensão errada ou inexistente;
  - `page_too_large`: texto `page is 612 KB after embedding, over the 512 KB limit; largest resources: img/a.png 300 KB, css/s.css 120 KB, js/app.js 90 KB`; também com `path` cujo `stat.size` já passa do teto, antes de ler;
  - `no_live_session`, **409**: `no live session in this terminal; open it in Claudinei first`.
- Aviso: `` `${n} local reference${n === 1 ? '' : 's'} not embedded: ${missing.slice(0, 10).join(', ')}` ``.
- `POST /api/hermes/pages` (`bodyLimit: 2 * 1024 * 1024`, `requireProjectAccess`) devolve **201** `{ id, bytes, warnings }`.
- Em `app.ts`:
  - `liveSession` = a sessão `ACTIVE` do projeto e motor, como o `liveLocalId` de `app.ts:252`;
  - `openTurn(localId)` = `undo.tracker.openSegment(localId)` + `undo.store.turn(id)?.textKey ?? null`.
- `show_page` no Hermes:
  - esquema zod com `html: z.string().max(524288).optional()`, `path: z.string().optional()`, `title: z.string().min(1).max(120)`, `height: z.number().int().min(120).max(2000).optional()`;
  - POST com `{ projectId, engine: ENGINE || 'claude', html, path, title, height }`;
  - sucesso: `` `page shown to the operator (id ${id}, ${Math.max(1, Math.round(bytes / 1024))} KB)` `` mais os avisos, um por linha;
  - erro: `` `show_page rejected: ${msg}` `` com `isError`.
- Descrição do `show_page` (inglês, ≤ 2000 caracteres), com estes pontos:
  - quando usar: o operador pediu algo visual, ou a resposta lê melhor desenhada;
  - `html` ou `path`, nunca os dois; gravar o arquivo e passar `path` quando a página é grande ou vai mudar;
  - a página roda isolada, sem formulário nem `fetch`/XHR/WebSocket, sem acesso ao Claudinei nem à sessão do operador;
  - script, estilo, fonte e imagem só de `https://cdn.jsdelivr.net`, `https://unpkg.com` e `https://cdnjs.cloudflare.com`, e Google Fonts para estilo e fonte; Tailwind por `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`;
  - imagem, CSS e JS locais entram embutidos, com teto de 512 KB;
  - a chamada não espera o operador;
  - página com script ou layout complexo merece um `check_page` antes.

- [ ] **Step 1: Escrever os testes que falham.** Em `pages-publish.test.ts`, o serviço com `liveSession`/`openTurn`/`broadcast` dublados e pasta temporária:
  - `html publicado: arquivo em <dir>/<id>.html, linha com conversa, turn_id e turn_key do trecho aberto, broadcast visual_page com projectId, engine, localId e page`.
  - `path relativo e absoluto dentro do projeto; .htm aceito`.
  - `path fora do projeto, .txt e inexistente: page_path, nada gravado (pasta vazia, tabela vazia)`.
  - `html e path juntos ou nenhum: page_source`.
  - `title vazio ou com 121 caracteres: page_title; height 119 e 2001: page_height`.
  - `teto depois de embutir: page_too_large cita os três maiores recursos; nada gravado`.
  - `teto em bytes, não em caracteres: 200 mil emojis (menos de 524.288 caracteres, mais de 524.288 bytes) recusam`.
  - `aviso de referência ausente volta em warnings`.
  - `sem sessão viva: no_live_session (409), nada gravado`.
  - `sem trecho aberto: turn_id e turn_key nulos; engineSessionId nulo: conversation_id nulo`.
  - `gravação atômica: nenhum .tmp sobra na pasta`.
  - Rota (via `buildApp`): `POST /api/hermes/pages com token de serviço responde 201`; `corpo acima de 2 MiB dá 413`; `usuário sem acesso ao projeto dá 403`.
  - Em `hermes-pages.test.ts`:
    - `show_page chama a rota com projeto, motor e campos`;
    - `resultado traz o id e o tamanho em KB, e os avisos`;
    - `recusa da rota vira isError com o motivo`;
    - `descrição ≤ 2000, cita check_page, jsdelivr e @tailwindcss/browser@4, e sem alwaysLoad`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run test/pages-publish.test.ts test/hermes-pages.test.ts`.
- [ ] **Step 3: Implementar.** Gravação: `writeFileSync(tmp)` + `renameSync`, com `mkdirSync(dir, { recursive: true })` na primeira vez.
- [ ] **Step 4: Rodar e ver passar.** Rodar também `test/hermes-mode.test.ts`, `test/hermes-instructions.test.ts` e `test/routes-hermes.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(páginas): show_page publica a página na conversa`.

### Task 4: Mostrar: listar, buscar por id, abrir com token e servir com CSP

**Files:**
- Create: `server/src/pages/csp.ts`, `server/src/pages/height-script.ts`
- Modify: `server/src/pages/routes.ts`
- Modify: `server/src/auth/plugin.ts`: `GET /api/pages/view/` entra ao lado de `isPreviewRead` (público; o token autoriza).
- Test: `server/test/pages-view.test.ts`

**Interfaces:**
- Produces, `csp.ts`:
  ```ts
  export const PAGE_CDNS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com'] as const
  export function pageCsp(network: PageNetwork): string          // as duas strings verbatim das Global Constraints
  export function metaCsp(network: PageNetwork): string          // a mesma sem a diretiva sandbox (o <meta> não a aceita)
  export const PAGE_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), display-capture=()'
  ```
- Produces, `height-script.ts`: `export const HEIGHT_SCRIPT: string` e `export function withHeightScript(html: string): string`. O segundo põe `<script id="claudinei-page-height">…</script>` antes do último `</body>` (sem diferenciar maiúsculas) ou, sem `</body>`, no fim.
- Rotas em `routes.ts`:
  - `GET /api/sessions/:localId/pages`: 404 sem sessão, 403 sem acesso; devolve `VisualPageDto[]` da conversa (`engineSessionId`, ou `localId` sem id).
  - `GET /api/pages/:id`: o DTO; 403 sem acesso ao projeto dono; 404 apagada.
  - `POST /api/pages/:id/view`: 403 sem acesso, 404 sem linha ou sem arquivo; devolve `{ url: '/api/pages/view/<token>/<id>.html' }`, com o token emitido para `filePath(id)`, `req.socket.remoteAddress` e `req.accessAllowed`.
  - `GET /api/pages/view/:token/:file`:
    - 404 se o token não resolve, se `file !== id + '.html'` ou se a raiz do grant não é o arquivo daquele id;
    - serve `withHeightScript(conteúdo)` com os cabeçalhos das Global Constraints e `pageCsp(network)`, com `network` lido a cada pedido;
    - o 404 é uma página HTML curta com três linhas (pt-BR, en, es), como "Esta página expirou ou não existe. Reabra pelo Claudinei.".
- `registerPageRoutes` aceita `views?: PreviewStore` (padrão: `createPreviewStore()` próprio, separado do de arquivos) e `network: () => PageNetwork` (a Task 5 liga a configuração; até lá, `() => 'cdn'`).

- [ ] **Step 1: Escrever os testes que falham** (`buildApp` com auth e dois usuários, um sem acesso ao projeto):
  - `listagem por conversa: ordem de criação; outra conversa do mesmo terminal fica de fora; sem engineSessionId, por localId`.
  - `listagem e view sem acesso ao projeto: 403; admin vê tudo`.
  - `GET /api/pages/:id: com acesso devolve o DTO; sem acesso 403; apagada 404`.
  - `view emite token novo a cada pedido (cartão e tela cheia têm tokens distintos)`.
  - `servir: corpo com o script de altura antes de </body>; Content-Security-Policy igual à string cdn verbatim; X-Frame-Options SAMEORIGIN; no-store; nosniff; no-referrer; Permissions-Policy`.
  - `servir: token de outro endereço (remoteAddress diferente no inject) dá 404`.
  - `servir: token expirado (store com now injetado) dá a página de 404 com o texto nas três línguas`.
  - `servir: accessAllowed que passa a falso revoga o token (404)`.
  - `servir: token válido com outro id, outro nome de arquivo ou ../ dá 404`.
  - `servir sem cookie funciona (rota pública pelo token); /api/pages/:id sem cookie dá 401`.
  - `visual_page de projeto alheio não chega ao não-admin pelo /ws; chega ao admin e a quem tem acesso` (no padrão de `auth-ws.test.ts:117`, sem mexer nesse arquivo).
  - `script de altura (vm com ResizeObserver, setTimeout e parent.postMessage dublados): manda a primeira altura; mudança de 3 px não manda; de 4 px manda; duas mudanças em 50 ms viram uma mensagem depois de 200 ms`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run test/pages-view.test.ts`.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `test/auth-plugin.test.ts`, `test/auth-hardening.test.ts` e `test/files-preview.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(páginas): listar, abrir com token e servir isolada`.

### Task 5: A rede das páginas (admin) e a recusa de `Origin: null`

**Files:**
- Create: `server/src/pages/settings.ts`
- Modify: `server/src/pages/routes.ts`; `server/src/app.ts` (passa `network` às rotas, uma linha)
- Modify: `server/src/auth/plugin.ts`: o gancho `onRequest` da recusa entra em `registerSecurityHeaders`, que roda com e sem auth.
- Test: `server/test/pages-network.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PAGE_NETWORK_KEY = 'visualPagesNetwork'
  export function readNetwork(settings: Pick<SettingsService, 'get'>): PageNetwork   // tudo que não for 'open' vale 'cdn'
  ```
- Rotas: `GET /api/visual-pages/settings` → `{ network }`; `PUT /api/visual-pages/settings` com `{ network: 'cdn' | 'open' }`, protegido por `requireAdmin`; valor inválido dá 400.
- Recusa:
  - caminho decodificado uma vez com `decodeURIComponent`, como o gancho de auth;
  - `Origin` igual a `null` em `/api/*`, `/ws` ou `/ws/*` → 403 `{ error: 'opaque_origin' }`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `GET devolve cdn por padrão e com valor desconhecido no banco`.
  - `PUT de admin grava open; não admin 403; valor inválido 400`.
  - `a próxima abertura usa a CSP open verbatim; a de antes não muda (sem cache)`.
  - `Origin: null em /api/projects e na rota da página servida: 403, com e sem auth configurada e no pré-setup`.
  - `Origin: null em /%61pi/projects (percent-encoding): 403`.
  - `upgrade de /ws com Origin: null: 403`.
  - `Origin normal e ausente seguem como antes`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run test/pages-network.test.ts`.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `test/auth-*.test.ts`, `test/ws.test.ts` e `test/pages-view.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(páginas): rede liberada pelo admin e Origin null recusado`.

### Task 6: Retenção: volta da conversa, exclusão do terminal e varredura

**Files:**
- Modify: `server/src/pages/service.ts`
- Modify: `server/src/undo/rewind.ts`: `RewindDeps` ganha `onRewound?(turnIds: number[]): void` e `onRelabeled?(turnIds: number[], conversationId: string): void`. Os dois são chamados logo depois de `store.markRewound`/`store.setConversation`, nos dois lugares: o ramo do Codex (`rewind.ts:411`) e o `onTurnClosed` do Claude (`rewind.ts:468`). Uma falha neles vai ao `log` e não desfaz a volta.
- Modify: `server/src/undo/index.ts`: `UndoDeps` ganha `onTurnsRewound?` e `onTurnsRelabeled?`, repassados ao `createRewindService`.
- Modify: `server/src/routes/projects.ts`: dep `onRemoving?: (projectId: number) => void`, chamada logo antes de `svc.remove(id)`.
- Modify: `server/src/app.ts`: liga `onTurnsRewound`, `onTurnsRelabeled` e `onRemoving` ao serviço pela referência `pages`, e roda `pages.sweep()` uma vez no `buildApp`, com try/catch e log.
- Test: `server/test/pages-retention.test.ts`; casos novos em `server/test/undo-rewind.test.ts`

**Interfaces:**
- Produces, no serviço:
  ```ts
  onTurnsRewound(turnIds: number[]): void                     // apaga arquivos e linhas das páginas desses turnos
  onTurnsRelabeled(turnIds: number[], conversationId: string): void   // store.moveTurns
  removeProject(projectId: number): void                      // apaga os arquivos; as linhas saem pela cascata
  sweep(): { files: number; rows: number }                    // arquivo pg_*.html sem linha, *.tmp e linha sem arquivo
  ```

- [ ] **Step 1: Escrever os testes que falham:**
  - Em `pages-retention.test.ts`:
    - `onTurnsRewound apaga arquivo e linha só das páginas desses turnos`;
    - `onTurnsRelabeled passa as páginas dos turnos que ficaram para a conversa nova: a listagem pela conversa nova as traz`;
    - `DELETE /api/projects/:id apaga os arquivos das páginas e a cascata leva as linhas`;
    - `sweep: arquivo sem linha, .tmp esquecido e linha sem arquivo saem; o resto fica`;
    - `pasta das páginas ausente: sweep não lança`.
  - Em `undo-rewind.test.ts`:
    - `codex com fork: onRelabeled recebe os turnos que ficam e o id novo; onRewound recebe o trecho` (no padrão do teste `codex com fork`, linha 828);
    - `Claude: onRewound e onRelabeled só no fim do primeiro turno da conversa nova que confirma o id`;
    - `Claude que morre antes do primeiro result: nenhum dos dois é chamado` (no padrão dos testes das linhas 459 e 532);
    - `onRewound que lança vai ao log e a volta segue`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run test/pages-retention.test.ts test/undo-rewind.test.ts`.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `test/routes-projects.test.ts`, `test/undo-*.test.ts` e `test/routes-undo.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(páginas): a página sai com o turno cortado e com o terminal, e acompanha a conversa nova`.

### Task 7: Web: store, API, âncoras e grupo de ações

**Files:**
- Create: `web/src/pages/api.ts`, `web/src/pages/pagesStore.ts`, `web/src/pages/anchors.ts`
- Modify: `web/src/App.tsx`: `applyPagesWsMessage(msg)` ao lado de `applyUndoWsMessage(msg)` (`App.tsx:136`).
- Modify: `web/src/chat/grouping.ts`: `isAction` deixa de fora o `tool_call` com `isShowPageName(name)`.
- Test: `web/src/test/pages-anchors.test.ts`, `web/src/test/pages-store.test.ts`, caso novo em `web/src/test/grouping.test.ts`

**Interfaces:**
- Produces, `api.ts` (usa `req` de `../api`):
  ```ts
  listPages(localId: string): Promise<VisualPageDto[]>
  getPage(id: string): Promise<VisualPageDto>
  viewPage(id: string): Promise<{ url: string }>
  fetchPagesSettings(): Promise<{ network: PageNetwork }>
  savePagesSettings(network: PageNetwork): Promise<{ network: PageNetwork }>
  ```
- Produces, `pagesStore.ts` (zustand):
  ```ts
  interface PagesState {
    byLocal: Record<string, VisualPageDto[] | undefined>
    byId: Record<string, VisualPageDto | 'unavailable' | undefined>
    livePageId: string | null
    load(localId: string): Promise<void>       // a última carga vence (contador por localId, como undoStore)
    fetchOne(id: string): Promise<void>         // 403/404 → 'unavailable'
    setLive(id: string | null): void
  }
  export const usePagesStore: UseBoundStore<StoreApi<PagesState>>
  export function applyPagesWsMessage(msg: any): void
  ```
  `visual_page`: entra em `byLocal[msg.localId]`, se carregado, e em `byId`. Com `msg.localId === useStore.getState().activeLocalId`, vira a viva. Na reconexão (`progressEpoch`), recarrega os `localId` carregados, como o `undoStore`.
- Produces, `anchors.ts`:
  ```ts
  /** O id do cartão: tool_call sem erro, nome terminado em show_page, resultado com pg_…; senão null. */
  export function pageIdOfToolCall(item: ChatItem): string | null
  /**
   * Páginas sem chamada visível: as de turno com texto vão ao fim do bloco do turno; as outras ficam só no menu do terminal.
   * Turnos = os reais do desfazer (quando carregados) mais pseudo-turnos { id: turnId, key: turnKey, origin: 'operator' } dos que faltam; posição por attachTurns.
   * afterIndex < 0 sem atStart, turnKey nulo ou turno que não casou: fora de `at`.
   */
  export function placePages(items: ChatItem[], pages: VisualPageDto[], turns: TurnDto[] | undefined, atStart: boolean):
    { at: Map<number, VisualPageDto[]>; shown: Set<string> }
  ```
  `shown` = os ids que já têm chamada visível em `items`; essas páginas não entram em `at`. O menu "Páginas desta conversa" (Task 9) lista todas as da conversa, então a página sem âncora sempre tem onde ser aberta.

- [ ] **Step 1: Escrever os testes que falham:**
  - Em `pages-anchors.test.ts`:
    - `quatro motores: mcp__hermes__show_page (Claude), hermes/show_page com resultado em JSON (Codex), hermes_show_page (OpenCode) e show_page (Kimi) dão o id`;
    - `exec do Codex que imprime pg_… não vira cartão`;
    - `show_page com isError ou sem resultado: null`;
    - `página sem chamada vai ao fim do bloco do turno dela`;
    - `dois turnos "continue" (5 e 9), página só no 5: vai ao bloco do 5` (com os turnos reais);
    - `sem os turnos reais, o pseudo-turno casa pela turn_key`;
    - `turn_key nulo, turno que não casou e página de turno antes da página carregada (sem atStart): fora de at`;
    - `página com chamada visível fica fora de at e entra em shown`.
  - Em `pages-store.test.ts`:
    - `visual_page do terminal ativo vira a viva; de outro terminal só entra na lista`;
    - `uma viva por vez: setLive troca a anterior`;
    - `fetchOne com 403 e com 404 vira unavailable`;
    - `carga antiga que responde depois da nova não sobrescreve`.
  - Em `grouping.test.ts`: `show_page não entra no grupo de ações; três Read seguidos ao redor continuam agrupando`.
- [ ] **Step 2: Rodar e ver falhar:** `cd web && npx vitest run src/test/pages-anchors.test.ts src/test/pages-store.test.ts src/test/grouping.test.ts`.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `src/test/chat-nodes.test.ts` e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(páginas): store, âncoras e chamadas show_page fora do grupo`.

### Task 8: Web: o cartão, a tela cheia e a nova aba, no chat

**Files:**
- Create: `web/src/components/PageCard.tsx`, `web/src/components/PageFullscreen.tsx`, `web/src/pages/useChatPages.ts`, `web/src/pages/pages.css`
- Modify: `web/src/components/MessageBlock.tsx`: no `case 'tool_call'`, com `pageIdOfToolCall(item)`, renderiza `<PageCard pageId={id} localId={currentLocalId} />` no lugar do `ToolCallCard`.
- Modify: `web/src/components/ChatView.tsx`, mudança mínima:
  - `const pagesAt = useChatPages(activeLocalId, session?.engineSessionId ?? null, items, undoTurns, atStart)`;
  - no `renderNode`, `{first === 0 && pagesAt(-1)}` e `{pagesAt(last)}` logo antes de `turnLinesAt(...)`, nas dependências do `useCallback`.
- Modify: `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts`: namespace `pages` (chaves desta tarefa).
- Test: `web/src/test/page-card.test.tsx`

**Interfaces:**
- Consumes: `usePagesStore`, `viewPage`, `placePages` (Task 7).
- Produces:
  ```ts
  export function PageCard(props: { pageId: string; localId: string; page?: VisualPageDto }): JSX.Element
  export function PageFullscreen(props: { page: VisualPageDto; onClose(): void }): JSX.Element   // portal
  /** Carrega a lista em (localId, engineSessionId); solta a viva ao trocar de localId; devolve quem desenha, por posição, as páginas ancoradas no turno. */
  export function useChatPages(localId: string | null, engineSessionId: string | null, items: ChatItem[], turns: TurnDto[] | undefined, atStart: boolean): (afterIndex: number) => ReactNode
  ```
- Estados do `PageCard`:
  - **sem DTO:** pede `fetchOne`;
  - **`unavailable`:** linha "Página indisponível";
  - **parado:** linha estática com título, "N KB" e o botão "Ver página", que chama `setLive(id)`;
  - **vivo:** iframe montado só com `livePageId === id` e o cartão na tela (`IntersectionObserver` no elemento do cartão). O `url` vem de `viewPage` a cada montagem. Cabeçalho com título, "Tela cheia", "Nova aba" e "Fechar", que chama `setLive(null)`;
  - **erro:** 404 no `viewPage` dá "Página apagada"; outro erro dá "Não carregou — tentar de novo", e o botão tenta de novo.
- Altura:
  - estado inicial `page.height ?? 360`;
  - listener de `message` aceita só `event.source === iframe.contentWindow`, `data.type === PAGE_HEIGHT_MESSAGE` e `Number.isFinite(data.height)`;
  - aplica `clamp(h, 120, Math.floor(window.innerHeight * 0.7))`.
- Tela cheia: o mesmo invólucro quase tela cheia do `FileViewerModal` (`calc(100vw - 40px)` × `calc(100vh - 40px)`, sem blur), com token novo. Ao abrir, a página deixa de ser a viva, se era. Esc e ✕ fecham.
- Nova aba: `const { url } = await viewPage(id); window.open(url, '_blank', 'noopener,noreferrer')`.
- `pages.css`: classes `page-card*`, sem `backdrop-filter`, sem `animation`/`transition` de sombra e sem miniatura.

- [ ] **Step 1: Escrever os testes que falham** (`IntersectionObserver` dublado com gatilho manual; `viewPage` e `window.open` espiados):
  - `parado por padrão no histórico: nenhum iframe, título, KB e Ver página`.
  - `Ver página monta o iframe com sandbox="allow-scripts", referrerpolicy no-referrer, sem allow e sem srcdoc`.
  - `uma viva por vez: abrir a segunda devolve a primeira à linha estática`.
  - `saiu da tela: o iframe desmonta; voltou e ainda é a viva: monta de novo com token novo (viewPage chamado duas vezes)`.
  - `visual_page ao vivo do terminal ativo monta sozinho; de outro terminal fica parado; trocar de terminal descarrega`.
  - `evento antes do resultado: a página aparece no fim do turno e, quando o tool_call ganha o resultado, sai do fim do turno e aparece no lugar da chamada, viva, uma vez só` (ChatView com store real).
  - `altura: mensagem do próprio iframe ajusta; de outra janela é ignorada; NaN, negativo e "300" ignorados; 1e9 limita a 70% da janela; 50 limita a 120`.
  - `tela cheia: token novo, o cartão volta a parado, Esc fecha`.
  - `nova aba: window.open com a url do token novo, _blank e noopener,noreferrer`.
  - `404 no view: Página apagada; 500: Não carregou com tentar de novo`.
  - `id fora da lista da conversa: busca por id; 404 vira Página indisponível`.
  - `pages.css sem backdrop-filter nem animation` (lendo o arquivo, como `card-actions-css.test.ts`).
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run src/test/page-card.test.tsx`.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `src/test/chatview.test.tsx`, `src/test/chat-virtual*.test.tsx`, `src/test/perf-render.test.tsx` e `src/test/action-group.test.tsx`, depois `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(páginas): cartão da página na conversa, uma viva por vez`.

### Task 9: Web: "Páginas desta conversa" e o diálogo do admin

**Files:**
- Create: `web/src/components/PagesListDialog.tsx`, `web/src/components/VisualPagesSettings.tsx`
- Modify: `web/src/components/TerminalMenu.tsx`:
  - prop opcional `localId?: string`;
  - com ela e com páginas carregadas, item "Páginas desta conversa (n)" (n = todas as da conversa), que abre a fase `'pages'` com o `PagesListDialog`.
- Modify: `web/src/components/ChatView.tsx`: passa `localId={session.localId}` ao `TerminalMenu` (`ChatView.tsx:583`).
- Modify: `web/src/components/UserMenu.tsx`: item "Páginas visuais" só para admin, que abre `VisualPagesSettings`.
- Modify: `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts`.
- Test: `web/src/test/pages-menu.test.tsx`

**Interfaces:**
- `PagesListDialog({ localId, onClose })`: um `PageCard` por página, em ordem de criação. "Ver página" abre ali mesmo, como a viva; tela cheia e nova aba como no cartão.
- `VisualPagesSettings({ onClose })`:
  - lê `fetchPagesSettings`;
  - dois rádios, "Só as CDNs conhecidas (padrão)" e "Liberar a rede";
  - o aviso aparece com "Liberar a rede" marcado;
  - Salvar chama `savePagesSettings`; erro aparece no diálogo.
- Aviso em pt-BR, verbatim:
  > Com a rede liberada, o código de qualquer página visual pode mandar o que estiver nela (inclusive dados do projeto que o agente pôs ali) para qualquer endereço da internet, carregar código de qualquer site e tentar alcançar outros aparelhos da rede de quem a abrir. A página continua sem acesso à sua sessão e à API do Claudinei. Vale para todas as páginas, de todos os terminais e usuários, a partir da próxima vez que forem abertas.

  En e es: tradução fiel do mesmo texto.

- [ ] **Step 1: Escrever os testes que falham:**
  - `menu do terminal no chat com 2 páginas: item "Páginas desta conversa (2)"; sem páginas ou sem localId (cartão da lateral): sem item`.
  - `lista: abrir monta o iframe no diálogo; tela cheia e nova aba pedem token novo`.
  - `menu do usuário: Páginas visuais só para admin`.
  - `diálogo: carrega cdn; marcar Liberar a rede mostra o aviso verbatim; Salvar manda open; erro aparece`.
  - `as chaves pages.* existem nas três línguas` (no padrão dos testes de i18n existentes).
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run src/test/pages-menu.test.tsx`.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar a suíte da web (`npx vitest run`) e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(páginas): lista das páginas da conversa e rede liberada pelo admin`.

### Task 10: Peças do `check_page` que não dependem do host

**Files:**
- Create: `server/src/pages/check-parts.ts`
- Test: `server/test/pages-check-parts.test.ts`

**Interfaces:**
- Consumes: `metaCsp` (Task 4), `withHeightScript` (Task 4).
- Produces:
  ```ts
  export interface CheckConsoleEntry { type: string; text: string }   // mesma forma do ConsoleEntry do host
  export const CHECK_MAX_HEIGHT = 2000
  export const CHECK_CONSOLE_MAX = 50
  export const CHECK_SHOT_TTL_MS = 30 * 60_000
  /** Corta um PNG de 8 bits, sem entrelaçamento, nas primeiras maxHeight linhas (node:zlib). Outro formato: devolve o original, cropped false. */
  export function cropPngHeight(png: Buffer, maxHeight: number): { png: Buffer; cropped: boolean }
  /** <meta http-equiv="Content-Security-Policy"> logo depois de <head …>; sem <head>, cria um depois de <html …>; sem <html>, no início. */
  export function withMetaCsp(html: string, csp: string): string
  /** O documento como seria publicado: meta CSP da rede atual e script de altura. */
  export function checkDocument(html: string, network: PageNetwork): string
  /** Erros (error, pageerror) primeiro, na ordem de chegada; cada linha "[tipo] texto", cortada em 500 caracteres; até max. */
  export function orderConsole(entries: CheckConsoleEntry[], max?: number): string[]
  export function createCheckShots(opts?: { dir?: string; ttlMs?: number; now?: () => number }): {
    save(png: Buffer): string      // os.tmpdir()/claudinei-check/<aleatório>.png; antes, apaga os mais velhos que o ttl; agenda a remoção (unref)
    sweep(): number
  }
  ```
- Corte do PNG:
  - lê o IHDR e junta os IDAT;
  - descomprime e guarda `maxHeight × (1 + largura × bytesPorPixel)` bytes; o filtro de cada linha só olha a de cima;
  - recomprime e reescreve a altura e os CRC (CRC-32 próprio, com tabela);
  - copia os chunks auxiliares antes do IDAT e põe o IEND.

- [ ] **Step 1: Escrever os testes que falham.** Um codificador de PNG RGBA mínimo no próprio teste:
  - `PNG 100×3000 vira 100×2000: IHDR com altura 2000, IDAT descomprime em 2000 linhas iguais às originais, CRCs válidos`.
  - `PNG com 1500 linhas volta igual, cropped false`; `entrelaçado ou 16 bits volta igual`.
  - `withMetaCsp: com <head lang>, sem head, sem html`; `metaCsp não tem sandbox`.
  - `checkDocument traz meta CSP e script de altura`.
  - `orderConsole: erros primeiro, 50 no máximo, linha cortada em 500`.
  - `createCheckShots: grava em dir/claudinei-check, nomes distintos; sweep apaga os de mais de 30 min (now injetado)`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run test/pages-check-parts.test.ts`.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar** e `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(páginas): corte do PNG, documento da conferência e cópias temporárias`.

### Task 11: Ensaio de ponta a ponta na instância isolada (porta 9197)

**Files:** nenhum de produção. Scripts em `/tmp/claudinei-e2e-visuais-scripts/`, projeto descartável em `/tmp/claudinei-e2e-visuais-proj/` (um `grafico.html` com um `<canvas>` animado por `requestAnimationFrame` e uma `img/logo.png`).

- [ ] **Step 1: Subir a instância:**
  - `npm run build -w web` antes (sem `npm install`);
  - `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_PKG_NATIVE -u CLAUDINEI_PKG_WEB`;
  - `CLAUDINEI_PORT=9197`, `CLAUDINEI_DB=/tmp/claudinei-e2e-visuais/claudinei.db`, `CLAUDINEI_UPLOADS=/tmp/claudinei-e2e-visuais/uploads`, `CLAUDINEI_PAGES=/tmp/claudinei-e2e-visuais/pages`, `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs`, com `PATH=$N24:$PATH`;
  - banco novo. Se usar cópia do real, neutralizar antes `schedules.enabled` e, em `terminal_state`, autostart, `auto_resume`, `auto_resume_limit`, `interrupted_*`, `limit_hit_at`, `limit_resets_at` e `limit_action='none'`.
- [ ] **Step 2: Publicar pelo Hermes.**
  - Terminal Claude no projeto descartável, mensagem `demorada` (turno aberto).
  - Subir o shim `server/hermes/hermes-mcp.mjs` por stdio, com `CLAUDINEI_API=http://127.0.0.1:9197`, `CLAUDINEI_PROJECT_ID`, `CLAUDINEI_ENGINE=claude` e `CLAUDINEI_SERVICE_TOKEN_FILE=/tmp/claudinei-e2e-visuais/service-token`.
  - Chamar `show_page` com `path: 'grafico.html'`.
  - Esperado:
    - o resultado traz `pg_…`;
    - na tela aberta, a página carrega sozinha no fim do turno, com o logo embutido;
    - outra chamada com `html` vira a viva e a anterior volta a parado.
- [ ] **Step 3: Fora da tela e CPU.** No Chromium do Playwright com `--disable-gpu`, encher o chat (mensagens do fake) e rolar até o cartão sair da tela.
  - Conferir no DOM que o `iframe` saiu.
  - Medir 10 s de CPU dos processos de renderização (`/proc/<pid>/stat`) com a página viva na tela e fora dela.
  - Registrar os dois números no relatório.
- [ ] **Step 4: Isolamento.**
  - Pelo console da página, `fetch('/api/projects')` e `fetch('https://example.com')` falham.
  - `curl -H 'Origin: null' http://127.0.0.1:9197/api/projects` dá 403.
  - A URL da página aberta noutra aba funciona e, depois de reiniciar só a instância 9197 (tokens na memória), dá a página de 404 em três línguas.
  - Com o admin em "Liberar a rede", a próxima abertura tem a CSP `open`.
- [ ] **Step 5: Retenção.** "Editar a partir daqui" antes da mensagem do turno da página: a linha e o arquivo somem de `/tmp/claudinei-e2e-visuais/pages`. Excluir o terminal apaga o resto.
- [ ] **Step 6: Capturas** do cartão parado, vivo, em tela cheia, da lista do menu e do diálogo do admin (Playwright).
- [ ] **Step 7: Parar** pelo PID da porta 9197, conferindo que não é o da 9105. Apagar `/tmp/claudinei-e2e-visuais*` e as pastas `~/.claude/projects/-tmp-claudinei-e2e-visuais*` do ensaio.

### Task 12: `check_page` sobre o host do projeto 16 (última)

**Files:**
- Create: `server/src/pages/check.ts`
- Modify: `server/src/pages/routes.ts`: `POST /api/hermes/pages/check`.
- Modify: `server/src/app.ts`: passa o host às rotas.
- Modify: `server/src/index.ts`: só se o commit do 16 ainda não criar o host (ver Step 1).
- Modify: `server/src/hermes/run-hermes.ts`: só o `registerTool('check_page', …)`.
- Test: `server/test/pages-check.test.ts`, casos novos em `server/test/hermes-pages.test.ts`

**Interfaces:**
- Consumes, do 16, só: `BrowserHost` (`withIsolatedPage`), `PreviewPage` (`setContent`, `screenshot`, `contentHeight`, `consoleMessages`), `BrowserUnavailableError` (`code`, `hint`) e `BrowserBusyError` (`code: 'browser_busy'`), de `server/src/browser/host.ts`.
- Consumes, das tarefas anteriores: `buildDocument` (Task 3), `checkDocument`, `cropPngHeight`, `orderConsole` e `createCheckShots` (Task 10), `readNetwork` (Task 5).
- Produces:
  ```ts
  export interface CheckResult { png: string /* base64 */; height: number; cropped: boolean; loaded: boolean; console: string[]; file: string }
  export async function runCheck(host: BrowserHost, doc: string, width: number,
    shots: ReturnType<typeof createCheckShots>, opts?: { settleMs?: number }): Promise<CheckResult>
  ```
  - `withIsolatedPage({ viewport: { width, height: 800 }, offline: false, timeoutMs: 20_000, queueTimeoutMs: 30_000 }, …)`;
  - dentro: `setContent(doc, { loadTimeoutMs: 10_000 })`; se `loaded`, espera `settleMs` (padrão 1500); depois `contentHeight()`, `screenshot({ fullPage: true })` cortado em 2000 e `consoleMessages()` ordenadas.
- Rota:
  - `bodyLimit` 2 MiB; `requireProjectAccess`; `width` inteiro de 360 a 1920 (padrão 1024; fora disso, 400 `page_width`);
  - documento por `buildDocument` e depois `checkDocument(doc, readNetwork(settings))`. Nada é gravado em `visual_pages` nem vai ao broadcast;
  - erros:
    - host ausente: 503 `browser not available`;
    - `code === 'browser_busy'`: 503 `busy, try again`;
    - `BrowserUnavailableError`: 503 `` `${message}. ${hint}` ``;
    - `Error('timeout')`: 504 `the page stayed open longer than 20 s`.
  - Reconhecer pelo `code` (e `message === 'timeout'`), não por `instanceof`.
- `check_page` no Hermes:
  - esquema `html?`, `path?`, `width?` (`z.number().int().min(360).max(1920).optional()`);
  - conteúdo `[{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text }]` sempre, nos quatro motores: quem descarta a imagem lê o caminho;
  - texto: `content height: N px`, `(screenshot cut at 2000 px)` quando cortado, `the load event did not fire within 10 s; captured anyway` quando `loaded` falso, `screenshot copy: <file> (kept 30 min)` e `console (n lines, errors first):` com as linhas;
  - erro: `` `check_page failed: ${msg}` `` com `isError`.
- Descrição do `check_page` (inglês, ≤ 2000 caracteres):
  - renderiza num navegador sem tela e devolve imagem (página inteira, cortada em 2000 px), altura do conteúdo e até 50 linhas de console, erros primeiro, inclusive bloqueios;
  - o mesmo `html`/`path` do `show_page` e `width` de 360 a 1920, padrão 1024;
  - monta como o `show_page` publicaria, mas nada é guardado nem mostrado ao operador;
  - traz o caminho de uma cópia do PNG, guardada 30 min, para quem não vê imagem de ferramenta;
  - "busy": tentar de novo em instantes.

- [ ] **Step 1: Esperar o aviso do coordenador com o sha do host do 16 e fazer merge desse commit no branch** (`git merge <sha>`; resolver conflito só nos arquivos tocados por ambos, mantendo as duas mudanças).
  - Conferir no `host.ts` merjado as assinaturas consumidas acima. Se divergirem, parar e avisar o coordenador antes de seguir.
  - Se o commit já cria o host em `index.ts` e o passa em `AppDeps`, usar esse campo.
  - Senão, acrescentar `browserHost?: BrowserHost` em `AppDeps`, criar em `index.ts` com `createBrowserHost({ log })` e chamar `shutdown()` no encerramento. Dizer isso no relatório da tarefa, para a integração manter uma só criação.
- [ ] **Step 2: Escrever os testes que falham.** Dublê de `BrowserHost` que registra as opções e devolve um `PreviewPage` falso (PNG 1024×3000 do codificador da Task 10, `contentHeight` 3000, console com `log`, `warning`, `error` e `pageerror`):
  - `withIsolatedPage recebe viewport {width, 800}, offline false, timeoutMs 20000, queueTimeoutMs 30000; setContent recebe loadTimeoutMs 10000`.
  - `o documento passado ao setContent tem a meta CSP da rede atual no início do head, sem sandbox, e o script de altura`.
  - `loaded true espera settleMs antes de capturar (relógio falso); loaded false captura sem esperar e o texto avisa`.
  - `PNG cortado em 2000 e cropped true; altura 3000 no resultado`.
  - `console: erros primeiro, no máximo 50`.
  - `cópia gravada no dir de teste e o caminho no resultado`.
  - `fila: o dublê rejeita com { code: 'browser_busy' } → 503 busy, try again`. Não há semáforo no 15: com três pedidos simultâneos, os três chegam ao `withIsolatedPage` do dublê.
  - `navegador ausente: BrowserUnavailableError com hint → 503 com a mensagem e o hint`.
  - `timeout do host → 504`.
  - `sem host → 503 browser not available`.
  - `width 359 e 1921 → 400; nada vai a visual_pages nem ao broadcast`.
  - Hermes:
    - `check_page repassa html/path/width e devolve image + text com o caminho`;
    - `busy vira isError com "busy, try again"`;
    - `descrição ≤ 2000 e sem alwaysLoad`;
    - `instructions do Hermes iguais às de antes` (`buildInstructions` para a mesma entrada).
- [ ] **Step 3: Rodar e ver falhar:** `npx vitest run test/pages-check.test.ts test/hermes-pages.test.ts`.
- [ ] **Step 4: Implementar.**
- [ ] **Step 5: Rodar e ver passar.** Rodar a suíte inteira do servidor e `npx tsc --noEmit`. A única falha tolerada é o teste intermitente conhecido do orchestrator: rodá-lo isolado para confirmar.
- [ ] **Step 6: Conferência real (opcional, se o Chromium da revisão esperada estiver no cache).** Na instância 9197 da Task 11, subida de novo do mesmo jeito, chamar `check_page` pelo shim com o `grafico.html`: imagem com o gráfico, altura plausível, console vazio. Com um `fetch('https://example.com')` no script, o console traz o bloqueio de CSP. Parar e limpar como no Step 7 da Task 11.
- [ ] **Step 7: Commit** `feat(páginas): check_page confere a página no navegador sem tela`.
