# Navegador embutido: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada terminal (projeto + motor) ganha um navegador Chromium sem tela no servidor. O agente dos quatro motores o dirige por ferramentas do hermes, e o operador o vê ao vivo na coluna da direita. Ali ele também age (assume o bastão), anota a tela e manda o recorte ao campo. Os servidores locais que o terminal subiu aparecem com Abrir e Parar.

**Architecture:**
- **Servidor, `server/src/browser/`.**
  - `host.ts`: um Chromium (`playwright-core` 1.65.1, externo ao bundle) aberto sob demanda, pelo pipe. Atende as abas por terminal e as páginas isoladas do projeto 15.
  - `terminal-tab.ts`: a aba do terminal.
  - `baton.ts`: o bastão.
  - `agent-ops.ts`: as operações do agente.
  - `hermes-routes.ts`: as rotas `/api/hermes/browser/<op>`.
  - `screencast.ts` e `socket.ts`: o screencast CDP e o WebSocket `/ws/browser/:projectId/:engine`, com quadros binários e entrada do operador.
  - `feature.ts`: amarra tudo e entra em `app.ts` com poucas linhas.
- **Servidores locais, `server/src/local-servers/`.** Marcador `CLAUDINEI_TERMINAL=<projectId>:<motor>` no ambiente de tudo que o terminal abre. Varredura de `/proc`. Parar com reconferência.
- **Web, `web/src/browser/`.**
  - `RightColumn`: a coluna da direita com abas (Acompanhamento, Lateral, Navegador), largura por vista e tela cheia.
  - `BrowserColumn`: um canvas que desenha só quando chega quadro.
  - `Annotator`: anotar e mandar ao campo pelo caminho do "Trazer de volta" (`uploadFile` + `requestAppend`).
- **Mudanças pequenas e localizadas** em `run-hermes.ts`, `index.ts`, `app.ts` e `ChatView.tsx`, que a trilha do projeto 15 também edita.

**Tech Stack:** Node 24 + TypeScript + Fastify + `@fastify/websocket` + `playwright-core` 1.65.1 (servidor); `@modelcontextprotocol/sdk` + zod (hermes); React + zustand + i18next (web); vitest; esbuild + `@yao-pkg/pkg` (empacotamento).

**Spec:** `docs/superpowers/specs/2026-11-21-navegador-embutido-design.md`. Valem também as seções "Decisões de quem escreveu" e "Decisões da checagem do construtor", no fim da spec.

## Global Constraints

- **Dependência:** `playwright-core` em `1.65.1` exato (sem `^`), no `server/package.json`. O lock é atualizado com `npm install --package-lock-only` na raiz do worktree. **Nunca** rode `npm install` normal no worktree: os `node_modules` são links para o repo principal, onde o coordenador já instalou o pacote.
- **Chromium:** a revisão `chromium_headless_shell-1255`, exatamente. Outra revisão não é aceita. A ordem da busca:
  1. `CLAUDINEI_CHROMIUM`;
  2. `$PLAYWRIGHT_BROWSERS_PATH` ou `~/.cache/ms-playwright`, em `chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`.

  Nada é baixado sozinho. O comando de instalação, verbatim: ``npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell``.
- **Sem porta CDP:** `--remote-debugging-pipe` (padrão do `launch`), nunca `--remote-debugging-port`. A sandbox do Chromium fica ligada. Se a subida falhar por causa dela, o host sobe sem sandbox e registra no log e no cabeçalho da coluna.
- **`evaluate` só com string** em `server/src/browser/` e em `server/src/local-servers/`. Isso vale para `evaluate`, `evaluateHandle`, `$eval`, `$$eval`, `waitForFunction` e `addInitScript`. Um teste varre as duas pastas.
- **Esquemas aceitos:** `http:`, `https:` e `about:blank`, da barra de endereço, das ferramentas e do `PreviewPage.goto`. A página de erro do Chromium (`chrome-error://`) não conta como navegação proibida.
- **Números da spec:**

  | O quê | Valor |
  | --- | --- |
  | Processo ocioso | fecha em 2 min (`idleMs` 120 000) |
  | Aba ociosa (sem ferramenta e sem coluna visível) | fecha em 30 min |
  | Abas por processo | no máximo 8 |
  | Páginas isoladas | 2 ao mesmo tempo |
  | `timeoutMs` (isolada) | 20 s |
  | `loadTimeoutMs` | 10 s |
  | `queueTimeoutMs` | 30 s |
  | Viewport | entre 320×240 e 1920×1200; padrão 1280×800; `deviceScaleFactor` 1 |
  | JPEG do screencast | qualidade 55 |
  | Ack ao Chromium | no mínimo 100 ms depois do anterior (≤ 10 quadros/s) |
  | Fila do socket | acima de 512 KB, só o quadro mais recente sai |
  | Movimento do mouse | até 20 por segundo, e só com o bastão do operador |
  | `resize` | 250 ms de espera |
  | Bastão sem coluna do dono | volta em 30 s |
  | Snapshot | corte em 60 000 caracteres |
  | `browser_console` | 50 mensagens |
  | `browser_wait` | teto de 30 s |
  | Varredura de servidores | a cada 5 s com a coluna visível; resultado guardado 2 s |
  | Parar servidor | SIGKILL 5 s depois do SIGTERM |
  | Sinal da ação do agente | some no quadro seguinte depois de 1,5 s |
- **Textos ao agente** (inglês, verbatim):
  - `OPERATOR_IN_CONTROL = "The operator is controlling the browser. Do not retry in a loop; read-only tools still work; ask the operator to click 'Return to agent' if you need it"`
  - `STALE_REF = "the page changed since your last snapshot; take a new browser_snapshot"`
  - `NOT_INSTALLED = "Browser not installed. On the server, run \`npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell\`"`
  - `SCHEME_REFUSED = "only http:, https: and about:blank URLs are allowed"`
  - `TOO_MANY_TABS = "too many browsers open"`
  - `DIALOG_PENDING = "a dialog is pending; answer it with browser_act action=dialog accept=true|false"`
  - `SNAPSHOT_CUT = "\n[snapshot cut at 60000 characters; call browser_snapshot with a smaller depth]"`

  Decisão deste plano: a spec dá esses textos em português ("Navegador não instalado…", "muitos navegadores abertos"). Ao agente eles vão em inglês, como todas as ferramentas do hermes; ao operador vão em pt-BR pelo i18n.
- **Hermes:** nenhuma linha nova em `server/src/hermes/instructions.ts` (orçamento de 3800 caracteres). Tudo vai nas descrições, cada uma com no máximo 2000 caracteres. Nenhuma descrição traz a regra "só quando pedirem" (decisão 10b).
- **Sem GPU** (AGENTS.md):
  - a coluna não tem laço de `requestAnimationFrame` nem transição;
  - desenha só quando chega quadro;
  - nenhum quadro sai com a coluna fechada, a aba oculta ou a tela fora da vista.

  Os rostinhos e as bolinhas dos terminais não mudam.
- **Nada vai ao banco:** sem tabela nova; aba, bastão, avisos e servidores vivem na memória. No localStorage da web ficam a vista e o estado da coluna (`claudinei:column`), as larguras por vista (`claudinei:columnWidths`) e o "Entendi" do aviso de senha (`claudinei:browserPasswordWarned`).
- **Ambiente:** `N24=/usr/local/n/versions/node/24.15.0/bin`.
  - Servidor: `cd server && PATH=$N24:$PATH npx vitest run <arquivo>`; tipos com `cd server && PATH=$N24:$PATH npx tsc --noEmit`.
  - Web: `cd web && npx vitest run <arquivo>`; tipos com `cd web && npx tsc -b`. Não commitar `web/tsconfig.tsbuildinfo`.
  - Commits só com arquivos explícitos (`git add <arquivos>`). A mensagem termina com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ensaio** só na porta **9196**, com banco, uploads e dados em `/tmp/claudinei-e2e-navegador`. Nunca na 9105. Nunca reiniciar o `claudinei.service`. A instância sobe com `env -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_TERMINAL`.
- **Textos ao operador:** i18n em pt-BR, en e es, com as chaves sob `browser.*` e `localServers.*`.

## Review Focus

1. **Diálogo `confirm` pendente e o agente chamando outra ação.**
   - O que pode dar errado: a ação do Playwright fica presa atrás do diálogo até o prazo.
   - O esperado: toda operação do agente que não seja `dialog` responde na hora com `DIALOG_PENDING`. A leitura continua valendo (`snapshot`, `screenshot` e `console`). Teste na Task 6.
2. **Aba que some no meio de uma ferramenta:** fechada por ociosidade, Chromium caído (`disconnected`) ou página travada (`crash`).
   - O esperado: a ferramenta em curso volta com erro legível (`isError`), sem pendurar. A próxima `browser_open` sobe outra aba. Testes nas Tasks 6 e 7.
3. **Navegação para esquema proibido por redirecionamento.**
   - Os casos: `Location: file:///etc/passwd`, ou `location = 'chrome://settings'` por script.
   - O esperado: o vigia do quadro principal volta para `about:blank` e anota o aviso. A página de erro do Chromium não dispara o vigia. Teste na Task 4.
4. **Dois espectadores com tamanhos diferentes e o bastão trocando de dono.**
   - O esperado: o viewport segue a coluna de quem tem o bastão; sem bastão, segue a última coluna que abriu. O screencast reinicia com o `maxWidth`/`maxHeight` novo, e um quadro do tamanho antigo não chega depois do `state` com o novo viewport. Teste na Task 9.
5. **Atalhos com o foco na tela do navegador.**
   - O esperado: Alt+Z (Zen), Mod+Enter (enviar), Mod+F (buscar) e Mod+U (uso) vão à página, não ao Claudinei. Só a combinação de `view.browser` (Alt+B por padrão, ou a que o operador gravou) sai da página e fecha a vista. Teste na Task 13.

---

### Task 1: Conferência com CLIs reais: Kimi e OpenCode repassam `CLAUDINEI_TERMINAL` ao shell?

A spec pede esta conferência antes de tudo, curta e barata. O resultado decide se Kimi e OpenCode precisam do plano B (listar servidores pela pasta de trabalho, com "sem marcador"). A tarefa entrega o módulo do marcador com o resultado gravado.

**Files:**
- Create: `server/src/local-servers/marker.ts`
- Test: `server/test/local-servers-marker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TERMINAL_MARKER_VAR = 'CLAUDINEI_TERMINAL'
  export function terminalMarker(projectId: number, engine: string): string          // `${projectId}:${engine}`
  /** Cópia de `env` com o marcador posto (marker definido) ou apagado (undefined): nunca herda o do serviço. */
  export function withMarker(env: NodeJS.ProcessEnv, marker: string | undefined): NodeJS.ProcessEnv
  /** Motores cuja CLI NÃO repassa o ambiente ao shell (resultado desta conferência). */
  export const ENGINES_FILTERING_ENV: ReadonlySet<string>
  ```

- [ ] **Step 1: Preparar a pasta descartável e o data root do Kimi.**
  ```bash
  mkdir -p /tmp/claudinei-marcador/work
  cd server && PATH=$N24:$PATH npx tsx -e "import('./src/engine/kimi/kimi-home.ts').then(m => console.log(m.ensureKimiHomeAt('/tmp/claudinei-marcador/kimi-home')))"
  ```
  Esperado: imprime o caminho do data root. É o mesmo mecanismo da lateral: login e config entram por link.

- [ ] **Step 2: Um turno no Kimi, com o modelo padrão e uma mensagem só.**
  ```bash
  cd /tmp/claudinei-marcador/work && env CLAUDINEI_TERMINAL=999:kimi KIMI_CODE_HOME=/tmp/claudinei-marcador/kimi-home \
    kimi --output-format stream-json -p 'Run this exact shell command with your shell tool and answer only with its output: echo "MARK=${CLAUDINEI_TERMINAL:-none}"' \
    | tee /tmp/claudinei-marcador/kimi.jsonl
  ```
  Esperado: a saída da ferramenta de shell contém `MARK=999:kimi` (repassa) ou `MARK=none` (filtra). Vale a saída da ferramenta, não o texto do modelo.

- [ ] **Step 3: Um turno no OpenCode, com o modelo mais barato.**
  - Escolha o modelo com `opencode models | grep -iE 'mini|flash|haiku|nano' | head -3`.
  - Rode:
    ```bash
    cd /tmp/claudinei-marcador/work && env CLAUDINEI_TERMINAL=999:opencode \
      opencode run --format json --auto -m <modelo> -- 'Run this exact shell command with your shell tool and answer only with its output: echo "MARK=${CLAUDINEI_TERMINAL:-none}"' \
      | tee /tmp/claudinei-marcador/opencode.jsonl
    ```
  - Esperado: `MARK=999:opencode` ou `MARK=none` na saída da ferramenta.
  - Depois, apague a conversa criada: `opencode session delete <sessionID>`, com o id tirado do JSON.

- [ ] **Step 4: Limpar.** Rode `rm -rf /tmp/claudinei-marcador`. São só links no data root, e o `rm` não os segue. Confira que `~/.kimi-code` não ganhou sessão nova desta pasta.

- [ ] **Step 5: Escrever os testes que falham**, em `local-servers-marker.test.ts`:
  - `terminalMarker(4, 'claude')` → `'4:claude'`.
  - `withMarker({ A: '1', CLAUDINEI_TERMINAL: '9:x' }, '4:claude')` → `CLAUDINEI_TERMINAL === '4:claude'`, `A === '1'`. O objeto de entrada não muda.
  - `withMarker({ CLAUDINEI_TERMINAL: '9:x' }, undefined)` → sem a chave `CLAUDINEI_TERMINAL`.
  - `[...ENGINES_FILTERING_ENV]` está contido em `['kimi', 'opencode']`.

- [ ] **Step 6: Rodar e ver falhar:** `cd server && PATH=$N24:$PATH npx vitest run test/local-servers-marker.test.ts`. Esperado: FAIL, o módulo não existe.

- [ ] **Step 7: Implementar `marker.ts`.** `ENGINES_FILTERING_ENV` recebe os motores que deram `MARK=none` nos Steps 2 e 3 (vazio se os dois repassaram). Um comentário cita a data, as versões (`kimi --version`, `opencode --version`) e o resultado.

- [ ] **Step 8: Rodar e ver passar** com o mesmo comando do Step 6. Esperado: PASS.

- [ ] **Step 9: Commit.** A mensagem diz o resultado de cada CLI.
  ```bash
  git add server/src/local-servers/marker.ts server/test/local-servers-marker.test.ts
  git commit -m "feat(navegador): marcador do terminal e conferência do Kimi e do OpenCode"
  ```

---

### Task 2: `BrowserHost`, o contrato com o projeto 15, com `playwright-core`, resolução do Chromium e empacotamento

**Files:**
- Modify: `server/package.json` (`"playwright-core": "1.65.1"` em `dependencies`), `package-lock.json` (raiz).
- Create:
  - `server/src/browser/host.ts`;
  - `server/src/browser/chromium.ts`;
  - `server/src/browser/terminal-tab.ts` (versão mínima: contexto, página, uso e fechamento; cresce na Task 4);
  - `server/src/browser/types.ts`;
  - `server/src/browser/selftest.ts`.
- Modify:
  - `server/src/pkg-runtime.ts`: o desvio do `inspector`;
  - `scripts/package.mjs`: `EXTERNAL`, a poda de `lib/vite` e o aviso da revisão;
  - `server/src/index.ts`: o host criado uma vez, `--browser-selftest`, o desvio no binário e o `shutdown`;
  - `server/src/app.ts`: o campo `browserHost` em `AppDeps`.
- Test:
  - `server/test/browser-host.test.ts`;
  - `server/test/browser-chromium.test.ts`;
  - `server/test/browser-no-fn-evaluate.test.ts`;
  - `server/test/pkg-inspector.test.ts`;
  - `server/test/browser-host.real.test.ts` (pulado sem Chromium);
  - `server/test/browser-fakes.ts`, o dublê compartilhado (não é `.test`).

**Interfaces:**
- Produces, em `host.ts`. O contrato é **exato**, copiado da spec:
  ```ts
  export interface ConsoleEntry { type: string; text: string }
  export interface PreviewPage {
    setContent(html: string, opts?: { loadTimeoutMs?: number }): Promise<{ loaded: boolean }>
    goto(url: string, opts?: { loadTimeoutMs?: number }): Promise<{ loaded: boolean }>
    screenshot(opts: { fullPage: boolean }): Promise<Buffer>
    contentHeight(): Promise<number>
    consoleMessages(): ConsoleEntry[]
  }
  export interface IsolatedPageOpts { viewport: { width: number; height: number }; offline?: boolean; timeoutMs?: number; queueTimeoutMs?: number }
  export interface BrowserHost {
    withIsolatedPage<T>(opts: IsolatedPageOpts, fn: (page: PreviewPage) => Promise<T>): Promise<T>
    tab(key: TerminalKey): Promise<TerminalTab>
    existingTab(key: TerminalKey): TerminalTab | undefined
    closeTab(key: TerminalKey): Promise<void>
    status(): { state: 'closed' | 'starting' | 'open' | 'unavailable'; tabs: number; reason?: string }
    shutdown(): Promise<void>
  }
  export interface BrowserHostDeps { log: (line: string) => void; idleMs?: number; now?: () => number; launch?: LaunchFn }
  export function createBrowserHost(deps: BrowserHostDeps): BrowserHost
  export class BrowserUnavailableError extends Error { code: 'browser_not_installed' | 'launch_failed'; hint: string }
  export class BrowserBusyError extends Error { code: 'browser_busy' }
  ```
- Produces, interno ao 16, em `types.ts`:
  ```ts
  import type { Browser } from 'playwright-core'
  export interface TerminalKey { projectId: number; engine: string }
  export const keyOf = (k: TerminalKey): string => `${k.projectId}:${k.engine}`
  export type LaunchFn = (o: { executablePath: string; chromiumSandbox: boolean; env: NodeJS.ProcessEnv }) => Promise<Browser>
  export type TabCloseReason = 'idle' | 'evicted' | 'closed_by_user' | 'closed_by_agent' | 'browser_closed' | 'shutdown'
  export class TooManyTabsError extends Error { code: 'too_many_tabs' }   // message = TOO_MANY_TABS
  export const TEXTS: { OPERATOR_IN_CONTROL: string; STALE_REF: string; NOT_INSTALLED: string; SCHEME_REFUSED: string; TOO_MANY_TABS: string; DIALOG_PENDING: string; SNAPSHOT_CUT: string }  // verbatim das Global Constraints
  ```
- Produces, em `terminal-tab.ts` (mínimo; a Task 4 amplia sem trocar estes nomes):
  ```ts
  export interface TerminalTab {
    readonly key: TerminalKey
    readonly context: BrowserContext
    page(): Page
    lastAgentAt: number
    isVisible(): boolean                       // a Task 9 liga aos espectadores; aqui: false
    onClosed(fn: (reason: TabCloseReason) => void): () => void
    close(reason: TabCloseReason): Promise<void>
  }
  export function createTerminalTab(o: { key: TerminalKey; context: BrowserContext; page: Page; now: () => number }): TerminalTab
  ```
- Produces, em `chromium.ts`:
  ```ts
  export const PLAYWRIGHT_CORE_VERSION = '1.65.1'
  export const HEADLESS_SHELL_REVISION = '1255'
  export const INSTALL_COMMAND = 'npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell'
  export type ChromiumResolution = { ok: true; path: string; source: 'env' | 'cache' } | { ok: false; expected: string; reason: 'env_missing' | 'not_installed' }
  export function resolveChromium(env?: NodeJS.ProcessEnv, o?: { home?: string; isFile?: (p: string) => boolean }): ChromiumResolution
  ```
- Produces, em `pkg-runtime.ts`:
  ```ts
  type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown
  /** Envolve o carregador: 'inspector' e 'node:inspector' tentam o verdadeiro; só se ele lançar, devolve {}. */
  export function inspectorFallbackLoader(orig: LoadFn): LoadFn
  export function installInspectorFallback(): void   // aplica em Module._load; idempotente
  ```
- Produces, em `app.ts`: `AppDeps.browserHost?: BrowserHost`. **É o nome que a trilha do 15 usa.**
- Produces, em `index.ts`: `const browserHost = createBrowserHost({ log: (l) => console.log(`[navegador] ${l}`) })`, criado uma vez, passado a `buildApp` e encerrado com `await browserHost.shutdown()` no SIGINT/SIGTERM, antes do `app.close()`.

- [ ] **Step 1: Acrescentar a dependência.** Ponha `"playwright-core": "1.65.1"` em `server/package.json`. Na raiz do worktree, rode `npm install --package-lock-only`. Confira:
  - `git diff package-lock.json` mostra a entrada `node_modules/playwright-core` com `"version": "1.65.1"`;
  - `ls -la node_modules` continua sendo o link para o repo principal.

- [ ] **Step 2: Escrever o dublê** `server/test/browser-fakes.ts`.
  - `fakeLaunch()` devolve `{ launch: LaunchFn; launches: Array<Parameters<LaunchFn>[0]>; browsers: FakeBrowser[] }`.
  - `FakeBrowser`: `newContext(opts)` registra as opções; `disconnect()` emite `'disconnected'`; `close()`.
  - `FakeContext`: `newPage()`, `close()`, `closed`.
  - `FakePage`:
    - `setContent` e `goto` controláveis: resolvem ou ficam pendurados até um `release()`, e lançam `TimeoutError` quando o `timeout` passado estoura;
    - `screenshot()` devolve `Buffer.from('png')`;
    - `evaluate(expr: string)`;
    - `on(event, fn)` e `emit(event, arg)`.
  - Use os tipos do playwright-core por cast (`as unknown as Browser`).

- [ ] **Step 3: Escrever os testes que falham.**
  - `browser-chromium.test.ts`:
    - `CLAUDINEI_CHROMIUM aponta arquivo existente → source 'env'`;
    - `CLAUDINEI_CHROMIUM aponta arquivo ausente → ok false, reason 'env_missing'`, sem cair no cache;
    - `PLAYWRIGHT_BROWSERS_PATH com a revisão 1255 → o caminho .../chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`;
    - `só outra revisão no cache (1248) → not_installed`;
    - `HEADLESS_SHELL_REVISION casa com node_modules/playwright-core/browsers.json`: lê o arquivo e acha a entrada `chromium-headless-shell`.
  - `browser-host.test.ts`, com `fakeLaunch` e `vi.useFakeTimers()`:
    - `status() começa 'closed' e não lança nada antes do primeiro uso`;
    - `duas chamadas simultâneas a tab() lançam o Chromium uma vez só`;
    - `launch recebe chromiumSandbox true e env sem CLAUDINEI_TERMINAL` (com `process.env.CLAUDINEI_TERMINAL='1:x'` no teste);
    - `subida que falha com mensagem de sandbox ("No usable sandbox") tenta de novo com chromiumSandbox false; status().reason === 'no_sandbox'; log chamado`;
    - `sem Chromium (resolveChromium not_installed) → tab() e withIsolatedPage rejeitam BrowserUnavailableError code 'browser_not_installed', hint === INSTALL_COMMAND; status().state === 'unavailable'`;
    - `fecha o processo 120 s depois de ficar sem abas e sem páginas isoladas`: em 119 s ainda aberto, em 120 s fechado;
    - `uma página isolada em curso segura o processo aberto além de idleMs`;
    - `withIsolatedPage fecha o contexto quando fn lança`;
    - `withIsolatedPage estoura timeoutMs contado da abertura (não da fila): rejeita Error('timeout') e fecha o contexto`;
    - `setContent que não chega ao load em loadTimeoutMs → { loaded: false } sem lançar; a página segue utilizável (screenshot funciona)`;
    - `goto('file:///etc/passwd') → rejeita com SCHEME_REFUSED; goto('about:blank') aceito`;
    - `no máximo duas páginas isoladas; a terceira espera na ordem e roda quando uma termina`;
    - `a terceira que espera mais que queueTimeoutMs rejeita BrowserBusyError e sai da fila`;
    - `contexto isolado: acceptDownloads false, offline conforme pedido, viewport pedido, deviceScaleFactor 1`;
    - `consoleMessages traz 'console' e 'pageerror' (type 'pageerror')`;
    - `contentHeight lê scrollHeight por evaluate com string`;
    - `tab(key) cria uma vez e existingTab devolve a mesma; closeTab fecha o contexto`;
    - `a nona aba fecha a mais ociosa não visível (onClosed 'evicted'); com as oito visíveis rejeita TooManyTabsError`;
    - `aba sem ferramenta do agente e invisível por 30 min fecha com 'idle'`;
    - `'disconnected' do Chromium fecha todas as abas com 'browser_closed' e volta status a 'closed'; a próxima tab() lança outro`;
    - `shutdown fecha abas ('shutdown') e o processo`.
  - `pkg-inspector.test.ts`:
    - `inspectorFallbackLoader repassa o verdadeiro quando ele carrega`;
    - `devolve {} só quando o verdadeiro lança, e só para 'inspector' e 'node:inspector'`;
    - `outro módulo que lança continua lançando`.
  - `browser-no-fn-evaluate.test.ts`:
    - varre recursivamente `server/src/browser` e `server/src/local-servers` e falha se achar `/\.(evaluate|evaluateHandle|\$eval|\$\$eval|waitForFunction|addInitScript)\(\s*(async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/`;
    - um caso de controle prova que a regex pega `page.evaluate(() => 1)` e deixa passar `page.evaluate('1')`.
  - `browser-host.real.test.ts`, com `describe.skipIf(!resolveChromium().ok)`:
    - página isolada com `setContent('<h1>ok</h1><script>console.log("oi")</script>')`;
    - `loaded === true`;
    - o PNG começa com `\x89PNG`;
    - `contentHeight() > 0`;
    - `consoleMessages()` contém `{ type: 'log', text: 'oi' }`.

- [ ] **Step 4: Rodar e ver falhar:** `cd server && PATH=$N24:$PATH npx vitest run test/browser-host.test.ts test/browser-chromium.test.ts test/pkg-inspector.test.ts test/browser-no-fn-evaluate.test.ts`. Esperado: FAIL, os módulos não existem.

- [ ] **Step 5: Implementar `chromium.ts`, `types.ts`, `terminal-tab.ts` (mínimo) e `host.ts`.**
  - **O `launch` padrão:**
    - carrega o playwright-core por `await import('playwright-core')` dentro da função, nunca no topo: o desvio do `inspector` tem de vir antes;
    - chama `chromium.launch({ executablePath, headless: true, chromiumSandbox, env })`;
    - passa o `env` sem `CLAUDINEI_TERMINAL`, por `withMarker(process.env, undefined)` da Task 1: o Chromium nunca carrega marcador.
  - **O erro de sandbox:** a falha conta como sandbox quando a mensagem casa com `/sandbox|namespace|setuid/i`.
  - **O processo vivo:** a contagem de uso é `abas + páginas isoladas abertas`. Ao chegar a zero, arma o relógio de `idleMs`.
  - **As páginas isoladas:**
    - semáforo FIFO de 2;
    - contexto `{ viewport, deviceScaleFactor: 1, acceptDownloads: false, offline, serviceWorkers: 'block' }`;
    - o `PreviewPage` captura o `TimeoutError` do `setContent`/`goto` (`waitUntil: 'load'`) e devolve `{ loaded: false }`;
    - `contentHeight` usa `page.evaluate('document.documentElement.scrollHeight')`.
  - **A varredura de ociosidade das abas:** um `setInterval` de 60 s, com `unref()`.

- [ ] **Step 6: Implementar o desvio em `pkg-runtime.ts`.** Em `index.ts`, no ramo `isPackaged()`, logo depois de `process.env.CLAUDINEI_PKG_WEB = webDir`, chame `installInspectorFallback()`.

- [ ] **Step 7: O host em `index.ts` e o campo em `app.ts`.**
  - `index.ts`:
    - importa `createBrowserHost` junto dos outros imports dinâmicos;
    - cria o host depois do `loadConfig()`;
    - passa `browserHost` ao `buildApp`;
    - chama `await browserHost.shutdown()` no SIGINT/SIGTERM.
  - `app.ts`: só o campo `browserHost?: BrowserHost` em `AppDeps`, com um comentário de uma linha ("navegador do 16; o 15 usa `withIsolatedPage`").

- [ ] **Step 8: O modo `--browser-selftest`.**
  - `server/src/browser/selftest.ts`: `export async function browserSelfTest(log): Promise<number>`.
    - Sobe um host.
    - Roda `withIsolatedPage({ viewport: { width: 800, height: 600 } }, …)` com `setContent('<h1>ok</h1>')`.
    - Imprime `JSON.stringify({ status, loaded, pngBytes, height })`.
    - Devolve 0 se o PNG veio e 1 se não veio.
  - Em `index.ts`, no ramo servidor, depois do bloco do binário e antes de abrir o banco: `if (process.argv.includes('--browser-selftest')) { … process.exit(await browserSelfTest(console.log)) }`.

- [ ] **Step 9: Empacotamento em `scripts/package.mjs`.**
  - `'playwright-core'` entra em `EXTERNAL`; o `ignore` do pkg já o cobre pelo `flatMap`.
  - A cópia do pacote usa `cpSync(src, dest, { recursive: true, filter: (p) => !p.startsWith(join(src, 'lib', 'vite')) })`, num ramo próprio (`EXCLUDE = { 'playwright-core': ['lib/vite'] }`).
  - Antes do pkg, um aviso, que não interrompe o build:
    - a revisão vem de `node_modules/playwright-core/browsers.json`, na entrada `chromium-headless-shell`;
    - se `$PLAYWRIGHT_BROWSERS_PATH` ou `~/.cache/ms-playwright/chromium_headless_shell-<rev>` não existir, imprime `⚠ Chromium headless shell <rev> ausente nesta máquina — o navegador embutido dirá "não instalado". Rode: <INSTALL_COMMAND>`.

- [ ] **Step 10: Rodar e ver passar:** os testes do Step 4 e mais `test/browser-host.real.test.ts`. Depois, `cd server && PATH=$N24:$PATH npx tsc --noEmit`. Esperado: PASS e 0 erros.

- [ ] **Step 11: Conferir o binário.**
  - Rode `PATH=$N24:$PATH npm run package` na raiz do worktree.
  - Confira o tamanho: `du -sh dist-pkg/assets/native/playwright-core` deve dar menos de 11 MB, sem `lib/vite`.
  - Rode `./release/claudinei-linux-x64 --browser-selftest`. Esperado: uma linha JSON com `"loaded":true` e `pngBytes > 0`, e saída 0.
  - Não instale nem reinicie nada.

- [ ] **Step 12: Commit.**
  ```bash
  git add server/package.json package-lock.json scripts/package.mjs server/src/pkg-runtime.ts server/src/index.ts server/src/app.ts \
    server/src/browser/host.ts server/src/browser/chromium.ts server/src/browser/types.ts server/src/browser/terminal-tab.ts server/src/browser/selftest.ts \
    server/test/browser-fakes.ts server/test/browser-host.test.ts server/test/browser-chromium.test.ts server/test/pkg-inspector.test.ts \
    server/test/browser-no-fn-evaluate.test.ts server/test/browser-host.real.test.ts
  git commit -m "feat(navegador): host do Chromium (contrato do projeto 15), playwright-core 1.65.1 e empacotamento"
  ```

- [ ] **Step 13: Avisar o coordenador com o sha do commit do host** (`git rev-parse HEAD`). Diga junto que:
  - o campo em `AppDeps` é `browserHost`;
  - o host nasce em `index.ts`;
  - o binário passou no `--browser-selftest`.

  O coordenador repassa à trilha do 15.

---

### Task 3: O marcador no ambiente dos quatro motores, do terminal interativo e da lateral

**Files:**
- Modify:
  - `server/src/engine/types.ts` (`EngineSessionOptions.terminalMarker?: string`);
  - `server/src/claude/session.ts` (`SessionOptions.terminalMarker`, env do spawn, por volta da linha 235);
  - `server/src/engine/claude-engine.ts` (repassa a opção);
  - `server/src/engine/codex/codex-args.ts` (`buildAppServerArgs`);
  - `server/src/engine/codex/codex-rpc.ts` (o construtor aceita `env?: Record<string, string>`);
  - `server/src/engine/codex/codex-session.ts`;
  - `server/src/engine/kimi/kimi-session.ts:73`;
  - `server/src/engine/opencode/opencode-session.ts:128`;
  - `server/src/claude/manager.ts`: nos três `makeSession` (~922, ~1124, ~1171), `terminalMarker: terminalMarker(projectId, engine)`; e no `terminalLauncher` (~1329), `env: { ...env, CLAUDINEI_TERMINAL: terminalMarker(row.project_id, engineId) }`;
  - `server/src/branch/side.ts` (no `side.base`, ~380).
- Test: `server/test/terminal-marker-env.test.ts`, `server/test/codex-args.test.ts` (caso novo).

**Interfaces:**
- Consumes: `terminalMarker` e `withMarker` (Task 1).
- Produces:
  - `EngineSessionOptions.terminalMarker?: string`;
  - `buildAppServerArgs(opts: { hermes?: HermesOptions; terminalMarker?: string }): string[]`. Com o marcador, acrescenta `-c`, `shell_environment_policy.set.CLAUDINEI_TERMINAL="<marcador>"`, escapado por `tomlStr`.

- [ ] **Step 1: Escrever os testes que falham.**
  - `codex-args.test.ts`: `buildAppServerArgs({ terminalMarker: '4:codex' })` contém o par `'-c', 'shell_environment_policy.set.CLAUDINEI_TERMINAL="4:codex"'`; sem o marcador, nada disso aparece.
  - `terminal-marker-env.test.ts`:
    - captura o `env` dado ao `spawn` com `vi.mock('node:child_process')`, que devolve um filho falso;
    - para Claude, Codex (app-server), Kimi e OpenCode, criados com `terminalMarker: '7:<motor>'`, `env.CLAUDINEI_TERMINAL === '7:<motor>'`;
    - criados sem o marcador e com `process.env.CLAUDINEI_TERMINAL='1:fora'`, a chave não aparece.
  - Mesmo arquivo, com o manager e `sessionFactory` capturando as opções:
    - `create`, `revive` e `relaunch` passam `terminalMarker '<id>:<motor>'`;
    - `openInTerminal` chama o `terminalLauncher` com `env.CLAUDINEI_TERMINAL`.
  - Mesmo arquivo, com a lateral e `makeSession` capturando: `side.base.terminalMarker === '<id>:<motor>'`.

- [ ] **Step 2: Rodar e ver falhar:** `cd server && PATH=$N24:$PATH npx vitest run test/terminal-marker-env.test.ts test/codex-args.test.ts`. Esperado: FAIL.

- [ ] **Step 3: Implementar.** Em cada spawn, o `env` passa a ser `withMarker({ ...process.env, PKG_EXECPATH: '', … }, opts.terminalMarker)`. O resto do `env` de cada motor não muda.

- [ ] **Step 4: Rodar e ver passar** os testes do Step 2 e mais `test/codex-session.test.ts test/branch-side.test.ts test/engine-manager.test.ts`. Depois, `npx tsc --noEmit`. Esperado: PASS.

- [ ] **Step 5: Commit**, com `git add` dos arquivos listados e a mensagem `feat(navegador): marcador CLAUDINEI_TERMINAL nos motores, no terminal e na lateral`.

---

### Task 4: A aba do terminal: navegação, esquemas, janelas novas, diálogos, downloads, seletor de arquivo e queda

**Files:**
- Create: `server/src/browser/url-policy.ts`
- Modify: `server/src/browser/terminal-tab.ts`, `server/src/browser/host.ts` (o `tab()` passa `createTerminalTab` com o viewport inicial)
- Test: `server/test/browser-tab.test.ts`, `server/test/browser-tab.real.test.ts` (pulado sem Chromium)

**Interfaces:**
- Produces, em `url-policy.ts`:
  ```ts
  export function allowedUrl(raw: string): URL | null        // http:, https:, about:blank (exato); o resto null
  export function normalizeAddress(input: string): string    // 'localhost:5173' → 'http://localhost:5173'; 'exemplo.com' → 'https://exemplo.com'
  export const isChromiumErrorPage = (url: string): boolean   // começa com 'chrome-error://'
  ```
- Produces, em `terminal-tab.ts`, além dos membros da Task 2:
  ```ts
  export type Actor = { kind: 'agent' } | { kind: 'operator'; userId: number | null; name: string }
  export interface PendingDialog { id: number; type: 'confirm' | 'prompt'; message: string; defaultValue?: string }
  export interface TabSnapshotState {
    url: string; title: string; loading: boolean; crashed: boolean
    viewport: { width: number; height: number }
    dialog: PendingDialog | null
    notices: string[]                 // para a coluna (últimos 5)
    lastAction: { text: string; at: number; point?: { x: number; y: number } } | null
    sandbox: boolean
  }
  // membros novos do TerminalTab:
  state(): TabSnapshotState
  onState(fn: () => void): () => void                // mudou algo do state()
  navigate(input: string): Promise<void>             // lança Error(SCHEME_REFUSED) fora da política
  history(action: 'back' | 'forward' | 'reload'): Promise<void>   // com a página travada, reload recria a página no mesmo contexto na última URL
  onPage(fn: (page: Page) => void): () => void       // a página foi trocada (recuperação da queda): o screencast se religa nela
  answerDialog(accept: boolean, text?: string): void // sem diálogo pendente: no-op
  setViewport(size: { width: number; height: number }): Promise<void>   // grampeia em 320×240..1920×1200
  takeAgentNotices(): string[]                       // avisos ainda não entregues ao agente; esvazia
  pushNotice(text: string, forAgent: boolean): void
  ```
- Textos dos avisos ao agente (inglês, verbatim):
  - `dialog pending: <type> "<message>"`
  - `alert accepted: "<message>"`
  - `beforeunload accepted`
  - `download blocked: <name>, from <url>`
  - `file chooser cancelled (file upload is not supported)`
  - `navigation to <scheme> blocked; back to about:blank`
  - `page crashed; use browser_navigate action=reload`

- [ ] **Step 1: Escrever os testes que falham.**
  - Em `browser-tab.test.ts`, com o dublê:
    - `allowedUrl aceita http, https e about:blank; recusa file:, chrome:, devtools:, javascript:, data:, about:config`;
    - `normalizeAddress: 'localhost:5173' → 'http://localhost:5173'; '127.0.0.1:3000/x' → 'http://127.0.0.1:3000/x'; 'exemplo.com' → 'https://exemplo.com'`;
    - `navigate('file:///etc/passwd') rejeita SCHEME_REFUSED e não chama page.goto`;
    - `framenavigated do quadro principal para chrome://settings volta para about:blank e anota o aviso`;
    - `framenavigated para chrome-error://chromewebdata/ não volta`;
    - `popup (target=_blank / window.open): fecha a página nova e navega a própria aba para a URL dela`;
    - `popup com URL proibida: fecha e não navega`;
    - `alert é aceito e anotado; beforeunload é aceito`;
    - `confirm fica pendente em state().dialog; answerDialog(false) chama dismiss; prompt com texto chama accept(texto)`;
    - `download anota 'download blocked: relatorio.pdf, from https://x/relatorio.pdf'`;
    - `filechooser é cancelado (setFiles([])) e anotado`;
    - `crash marca crashed; history('reload') cria página nova no mesmo contexto e navega à última URL`;
    - `setViewport grampeia 100×100 → 320×240 e 5000×5000 → 1920×1200`;
    - `takeAgentNotices devolve uma vez e esvazia`.
  - Em `browser-tab.real.test.ts`, com o Chromium de verdade e um `http.createServer` local:
    - link `target=_blank` vira navegação na própria aba;
    - `Location: file:///etc/passwd` não sai de http nem chega a `file:`;
    - download com `acceptDownloads: false` anota o aviso e não grava arquivo.

- [ ] **Step 2: Rodar e ver falhar:** `cd server && PATH=$N24:$PATH npx vitest run test/browser-tab.test.ts`. Esperado: FAIL.

- [ ] **Step 3: Implementar.**
  - O contexto da aba usa `{ viewport, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' }`.
  - O viewport inicial vem do host: 1280×800, ou o último pedido de coluna, que a Task 9 informa.
  - O título acompanha `page.title()` depois de cada `load`.
  - `loading` liga no `framenavigated` do quadro principal e desliga no `load`.

- [ ] **Step 4: Rodar e ver passar** com o mesmo comando, mais `test/browser-tab.real.test.ts` e `test/browser-host.test.ts`. Esperado: PASS.

- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): aba do terminal com política de URL, janelas novas, diálogos e downloads`.

---

### Task 5: O bastão

**Files:**
- Create: `server/src/browser/baton.ts`
- Modify: `server/src/browser/terminal-tab.ts` (cada aba tem o seu `baton`)
- Test: `server/test/browser-baton.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BatonState = { kind: 'free' } | { kind: 'agent' } | { kind: 'operator'; userId: number | null; name: string }
  export class OperatorInControlError extends Error { code: 'operator_in_control' }   // message = TEXTS.OPERATOR_IN_CONTROL
  export interface Baton {
    state(): BatonState
    epoch(): number                                   // avança a cada ação do operador
    beginAgent(): void                                // operador no comando → OperatorInControlError
    endAgent(): void                                  // agent → free (se ainda for agent)
    operatorAct(user: { userId: number | null; name: string }): void   // toma na hora e avança o epoch
    release(): void                                   // operador → free; anota 'control returned to the agent' para o agente
    presence(userId: number | null, hasVisibleColumn: boolean): void   // o dono sem coluna visível: 30 s → release()
    onChange(fn: () => void): () => void
  }
  export function createBaton(o: { onNotice: (agentText: string) => void; graceMs?: number /* 30_000 */ }): Baton
  ```
  - `TerminalTab` ganha `readonly baton: Baton`.

- [ ] **Step 1: Escrever os testes que falham**, com relógio falso:
  - `começa livre; beginAgent → agent; endAgent → free`;
  - `operatorAct durante ação do agente: o estado vira operator; endAgent da ação em curso não devolve ao agente; o próximo beginAgent lança OperatorInControlError com a mensagem verbatim`;
  - `operatorAct avança epoch a cada chamada`;
  - `outro operador agindo troca o dono (nome no estado)`;
  - `release → free e onNotice('control returned to the agent')`;
  - `presence(dono, false) por 29 s mantém; aos 30 s devolve; presence(dono, true) no meio cancela`;
  - `presence de outro usuário não afeta o relógio do dono`.

- [ ] **Step 2: Rodar e ver falhar** (`npx vitest run test/browser-baton.test.ts`).
- [ ] **Step 3: Implementar `baton.ts`** e ligá-lo à aba: o `onNotice` vai para `pushNotice(text, true)`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): bastão entre agente e operador`.

---

### Task 6: As operações do agente: snapshot, act, wait, screenshot, console e linha de estado

**Files:**
- Create: `server/src/browser/agent-ops.ts`
- Test: `server/test/browser-agent-ops.test.ts`, `server/test/browser-agent-ops.real.test.ts` (pulado sem Chromium)

**Interfaces:**
- Consumes: `TerminalTab` (Tasks 2 e 4), `Baton` (Task 5), `TEXTS`.
- Produces:
  ```ts
  export type ActAction = 'click' | 'type' | 'fill' | 'press' | 'hover' | 'select' | 'scroll' | 'dialog'
  export interface ActArgs { action: ActAction; ref?: string; text?: string; key?: string; dx?: number; dy?: number; accept?: boolean }
  export type WaitArgs = { text: string } | { textGone: string } | { url: string } | { seconds: number }
  export class StaleRefError extends Error { code: 'stale_ref' }          // TEXTS.STALE_REF
  export class DialogPendingError extends Error { code: 'dialog_pending' } // TEXTS.DIALOG_PENDING
  export class TabGoneError extends Error { code: 'tab_gone' }            // 'the browser tab closed (<reason>); call browser_open again'
  export function maskPasswords(snapshot: string, values: string[]): string   // cada valor não vazio vira '••••'
  export function statusLine(tab: TerminalTab): string
  export interface AgentOps {
    open(url?: string): Promise<string>                        // com url: mutável (bastão)
    navigate(a: { url: string } | { action: 'back' | 'forward' | 'reload' }): Promise<string>
    snapshot(depth?: number): Promise<string>
    act(a: ActArgs): Promise<string>                           // devolve a descrição: "clicked 'Send'"
    wait(w: WaitArgs): Promise<string>
    screenshot(fullPage?: boolean): Promise<Buffer>
    console(): ConsoleEntry[]                                  // últimas 50
    close(): Promise<void>
  }
  export function agentOps(tab: TerminalTab, o: { closeTab: () => Promise<void> }): AgentOps
  ```
- A linha de estado, verbatim:
  - a primeira linha: `Browser: <url> | <title> | control: free|agent|operator (<name>)`;
  - depois, uma linha `Notice: <texto>` por aviso de `takeAgentNotices()`.
- A descrição da ação, que a coluna mostra:
  - `clicked '<nome acessível>'`, `typed into '<nome>'`, `filled '<nome>'`, `pressed <key>`, `hovered '<nome>'`, `selected '<text>' in '<nome>'`, `scrolled <dx>,<dy>`, `answered dialog: accept|dismiss`;
  - o nome sai da linha da snapshot que tem `[ref=eN]`;
  - o ponto do clique é o centro do `boundingBox()`, e vai para `lastAction.point`.

- [ ] **Step 1: Escrever os testes que falham.**
  - Em `browser-agent-ops.test.ts`, com o dublê:
    - `maskPasswords troca cada valor e deixa o resto`;
    - `snapshot chama ariaSnapshot({ mode: 'ai', depth }) e mascara os valores de input[type=password]`;
    - `snapshot maior que 60000 caracteres sai cortada com SNAPSHOT_CUT no fim`;
    - `act com ref vira o seletor 'aria-ref=e6'`;
    - `act com ref depois de operatorAct (epoch mudou desde a última snapshot) → StaleRefError`;
    - `act com ref sem snapshot nenhuma → StaleRefError`;
    - `navigate, act, open com url e close com o operador no comando → OperatorInControlError; snapshot, screenshot, console e wait seguem`;
    - `com diálogo pendente: act click → DialogPendingError na hora (sem chamar o Playwright); act dialog accept=true responde; snapshot funciona`;
    - `act scroll usa mouse.wheel(dx, dy) e não exige ref`;
    - `wait seconds 45 espera 30 s (teto)`;
    - `wait text usa getByText(text).first().waitFor({ state: 'visible', timeout })`;
    - `cada operação toca lastAgentAt`;
    - `aba fechada (onClosed 'idle') durante um act em curso → rejeita TabGoneError`;
    - `statusLine inclui os avisos uma vez só`;
    - `lastAction recebe "clicked 'Enviar'" e point`.
  - Em `browser-agent-ops.real.test.ts`:
    - página com botão "Enviar" e campo de senha preenchido com `hunter2`;
    - a snapshot contém `[ref=` e não contém `hunter2`;
    - o click pela ref dispara o handler da página, conferido pelo título que o handler troca.

- [ ] **Step 2: Rodar e ver falhar** (`npx vitest run test/browser-agent-ops.test.ts`).
- [ ] **Step 3: Implementar `agent-ops.ts`.**
  - As operações mutáveis ficam entre `baton.beginAgent()` e `baton.endAgent()` (`finally`).
  - O epoch da última snapshot fica na aba.
  - Os valores de senha vêm de `page.locator('input[type=password]').evaluateAll('els => els.map(e => e.value)')`. A função vai como string; o Playwright aceita a expressão em string.
  - Toda operação corre contra o `onClosed` da aba: `Promise.race` com um rejeitador de `TabGoneError`.
- [ ] **Step 4: Rodar e ver passar**, mais `test/browser-agent-ops.real.test.ts` e `test/browser-no-fn-evaluate.test.ts`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): operações do agente com referências, máscara de senha e linha de estado`.

---

### Task 7: As rotas do hermes do navegador e a amarração na app

**Files:**
- Create:
  - `server/src/browser/hermes-routes.ts`;
  - `server/src/browser/feature.ts`;
  - `server/src/browser/operator-routes.ts` (listar, abrir e fechar a aba pelo operador).
- Modify:
  - `server/src/app.ts`: duas linhas antes do static. Com `deps.browserHost`, `const browser = createBrowserFeature({...}); browser.register(app); deps.onBrowserReady?.(browser)`, e o campo `onBrowserReady` em `AppDeps`;
  - `server/src/index.ts`: `onBrowserReady: (b) => { browserFeature = b }`; e `browserFeature?.closeAll()` no `onRevokeAll` e `browserFeature?.closeUser(id)` no `onUserInvalidated`.
- Test: `server/test/browser-hermes-routes.test.ts`, `server/test/browser-operator-routes.test.ts`

**Interfaces:**
- Consumes: `BrowserHost` (Task 2), `agentOps` (Task 6), `saveUpload` (`server/src/uploads.ts`), `requireProjectAccess` (`server/src/auth/guards.ts`).
- Produces:
  ```ts
  export interface BrowserFeature {
    register(app: FastifyInstance): void      // rotas do hermes, do operador e (Task 10) o WebSocket
    closeUser(userId: number): void           // Task 10 preenche; aqui no-op
    closeAll(): void
  }
  export function createBrowserFeature(d: { host: BrowserHost; db: Db; uploadsDir: string; broadcast: (m: object) => void }): BrowserFeature
  ```
- As rotas do hermes: `POST /api/hermes/browser/:op`, com `op ∈ open|navigate|snapshot|act|wait|screenshot|console|close`.
  - O corpo é `{ projectId: number; engine: string; ...args }`.
  - A autenticação é a de `goal-done`: projeto existe, senão 404; depois `requireProjectAccess`. O `engine` é string `/^[a-z0-9_-]{1,32}$/`, senão 400.
  - As respostas:

    | Caso | Status | Corpo |
    | --- | --- | --- |
    | Sucesso | 200 | `{ text: string; status: string }`. O `screenshot` acrescenta `png` (base64) e `path`, este de `saveUpload(uploadsDir, 'navegador.png', Readable.from(buf))` |
    | `OperatorInControlError` | 409 | `{ error: TEXTS.OPERATOR_IN_CONTROL, code: 'operator_in_control' }` |
    | `StaleRefError` / `DialogPendingError` | 409 | o `code` de cada um |
    | Esquema | 400 | `code: 'scheme_refused'` |
    | `BrowserUnavailableError` | 503 | `{ error: TEXTS.NOT_INSTALLED, code, hint }` (`launch_failed`: `error` com a mensagem do Chromium) |
    | `TooManyTabsError` | 503 | — |
    | `TabGoneError` | 410 | — |
    | `BrowserBusyError` | 503 | — |
    | Argumento inválido | 400 | `code: 'bad_args'` |
- As rotas do operador, todas com `requireProjectAccess`:
  - `GET /api/browser/tabs` → `{ tabs: Array<{ projectId: number; engine: string }> }`, filtrado pelo acesso;
  - `POST /api/projects/:id/terminals/:engine/browser` → abre ou reaproveita (`host.tab`) e responde `{ ok: true }` (503 sem Chromium);
  - `DELETE` no mesmo caminho → `host.closeTab` e 204.
- O broadcast é `{ type: 'browser_tab', projectId, engine, open: boolean, by: 'agent' | 'operator' | 'system' }`. Sai ao criar uma aba (por quem pediu) e ao fechar (`system` para ociosidade, queda e despejo). Passa pelo `canSee` do hub, que filtra pelo `projectId`.

- [ ] **Step 1: Escrever os testes que falham**, com Fastify e um host montado com `fakeLaunch`.
  - `browser-hermes-routes.test.ts`:
    - `open sem url cria a aba e devolve status com 'control: free'`;
    - `open emite browser_tab { open: true, by: 'agent' }`;
    - `navigate com file: → 400 scheme_refused`;
    - `operador no comando → navigate 409 com o texto verbatim; snapshot 200`;
    - `screenshot devolve png base64 e path de arquivo existente em uploadsDir`;
    - `sem Chromium → 503 com hint === INSTALL_COMMAND`;
    - `projeto inexistente → 404; usuário sem acesso → 403`;
    - `engine inválido → 400`;
    - `close emite browser_tab { open: false }`;
    - `aba fechada no meio de um act (closeTab durante o act pendurado) → 410 tab_gone; o open seguinte cria outra aba` (Review Focus 2).
  - `browser-operator-routes.test.ts`:
    - `GET /api/browser/tabs só lista projetos com acesso`;
    - `POST cria com by 'operator'`;
    - `DELETE fecha e responde 204`.

- [ ] **Step 2: Rodar e ver falhar** (`npx vitest run test/browser-hermes-routes.test.ts test/browser-operator-routes.test.ts`).
- [ ] **Step 3: Implementar e amarrar em `app.ts` e `index.ts`.** São poucas linhas, sem mexer nas rotas de `routes/hermes.ts`.
- [ ] **Step 4: Rodar e ver passar**, mais `test/auth-rbac.test.ts` e `npx tsc --noEmit`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): rotas do hermes e do operador para a aba do terminal`.

---

### Task 8: As ferramentas do hermes

**Files:**
- Modify: `server/src/hermes/run-hermes.ts` (oito `registerTool` novos num bloco só, depois de `goal_done`; o `call` ganha a leitura do corpo de erro com `code`)
- Test: `server/test/hermes-browser-tools.test.ts`

**Interfaces:**
- Consumes: as rotas da Task 7.
- Produces: as ferramentas `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_act`, `browser_wait`, `browser_screenshot`, `browser_console` e `browser_close`.
  - Os esquemas zod seguem a spec. `browser_navigate` recebe `url?` e `action?` (`'back' | 'forward' | 'reload'`); exatamente um dos dois, senão o handler devolve `isError`.
  - Todas mandam `{ projectId: PROJECT_ID, engine: ENGINE || 'claude', ... }`.
  - O resultado é `text(`${r.text}\n${r.status}`)`.
  - O `browser_screenshot` devolve `content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, { type: 'text', text: `saved at ${r.path}\n${r.status}` }]`.
  - Erros viram `{ ...text(msg), isError: true }`, nunca exceção.
- As descrições, cada uma com no máximo 2000 caracteres, dizem:
  - que o operador vê a mesma página ao vivo na coluna do Claudinei;
  - que só valem `http:`, `https:` e `about:blank`;
  - que a `browser_act` precisa de uma `ref` da última `browser_snapshot`;
  - que a leitura vale mesmo com o operador no comando;
  - que não há `evaluate` nem envio de arquivo;
  - que downloads são bloqueados (use `curl` no shell).

  A `browser_open` diz que o agente deve abrir os servidores de desenvolvimento por `http://127.0.0.1:<porta>`.

- [ ] **Step 1: Escrever os testes que falham.**
  - Sobem o hermes como em `server/test/hermes-mode.test.ts`, contra um servidor HTTP falso que registra as chamadas:
    - `tools/list traz as oito ferramentas`;
    - `cada descrição tem ≤ 2000 caracteres e nenhuma contém 'only when'`;
    - `as instructions geradas são idênticas às de antes`: compare com `loadInstructions` chamado direto;
    - `browser_navigate sem url e sem action → isError`;
    - `browser_screenshot devolve um bloco image/png e um texto com o caminho`;
    - `erro 409 do servidor vira isError com o texto do servidor`;
    - `engine ausente vai como 'claude'`.
- [ ] **Step 2: Rodar e ver falhar** (`npx vitest run test/hermes-browser-tools.test.ts`).
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, mais `test/hermes-mode.test.ts`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): ferramentas browser_* no hermes`.

---

### Task 9: O screencast e os espectadores: ritmo, quadro mais recente, só com espectador visível, congelar e viewport

**Files:**
- Create:
  - `server/src/browser/screencast.ts`;
  - `server/src/browser/viewers.ts`;
  - `server/src/browser/frame.ts`;
  - `shared/browser.ts` (tipos do protocolo, usados pela web).
- Modify: `server/src/browser/terminal-tab.ts` (`isVisible()` liga aos espectadores; o viewport segue a regra abaixo)
- Test: `server/test/browser-screencast.test.ts`, `server/test/browser-viewers.test.ts`

**Interfaces:**
- Produces, em `shared/browser.ts`:
  ```ts
  export interface FrameHeader { kind: 'frame' | 'still'; seq: number; width: number; height: number }
  export interface BrowserStateMsg {
    type: 'state'; url: string; title: string; loading: boolean; crashed: boolean
    baton: { kind: 'free' } | { kind: 'agent' } | { kind: 'operator'; name: string; you: boolean }
    viewport: { width: number; height: number }
    dialog: { id: number; type: 'confirm' | 'prompt'; message: string; defaultValue?: string } | null
    notices: string[]; lastAction: { text: string; at: number; point?: { x: number; y: number } } | null
    sandbox: boolean
    unavailable?: { code: 'browser_not_installed' | 'launch_failed'; hint: string; message: string }
    closed?: 'idle' | 'evicted' | 'closed_by_user' | 'closed_by_agent' | 'browser_closed' | 'shutdown'
  }
  export type BrowserClientMsg =
    | { type: 'visible'; visible: boolean }
    | { type: 'resize'; width: number; height: number }
    | { type: 'pointer'; phase: 'down' | 'up' | 'move'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount?: number }
    | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
    | { type: 'key'; phase: 'down' | 'up'; key: string; code: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }
    | { type: 'text'; text: string }
    | { type: 'navigate'; url: string }
    | { type: 'history'; action: 'back' | 'forward' | 'reload' }
    | { type: 'take' } | { type: 'release' }
    | { type: 'dialog'; accept: boolean; text?: string }
    | { type: 'freeze'; on: boolean }
  export const FRAME_HEADER_BYTES = 4   // uint32 big-endian com o tamanho do JSON
  ```
- Produces, em `frame.ts`: `encodeFrame(h: FrameHeader, image: Buffer): Buffer` e `decodeFrame(buf: Buffer): { header: FrameHeader; image: Buffer }` (o segundo só para teste).
- Produces, em `screencast.ts`:
  ```ts
  export interface CdpLike { send(method: string, params?: object): Promise<any>; on(ev: string, fn: (p: any) => void): void; off(ev: string, fn: (p: any) => void): void }
  export function createScreencast(o: {
    cdp: CdpLike; size: () => { width: number; height: number }
    onFrame: (jpeg: Buffer, size: { width: number; height: number }) => void
    minAckMs?: number /* 100 */; now?: () => number
  }): { start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>; running(): boolean }
  ```
  - `Page.startScreencast { format: 'jpeg', quality: 55, maxWidth, maxHeight, everyNthFrame: 1 }`.
  - Cada `Page.screencastFrame` vai ao `onFrame`, e o `Page.screencastFrameAck { sessionId }` sai em `max(0, últimoAck + 100 − agora)` ms.
  - O CDP vem de `context.newCDPSession(page)`.
- Produces, em `viewers.ts`:
  ```ts
  export interface ViewerSink { bufferedAmount: number; sendBinary(b: Buffer): void; sendText(s: string): void }
  export interface Viewer { id: number; userId: number | null; name: string; sink: ViewerSink; visible: boolean; frozen: boolean; size: { width: number; height: number } | null; openedAt: number }
  export function createViewers(o: { tab: TerminalTab; screencast: ReturnType<typeof createScreencast>; maxBuffered?: number /* 512*1024 */; retryMs?: number /* 50 */ }): {
    add(v: Omit<Viewer, 'id' | 'openedAt'>): Viewer; remove(id: number): void
    update(id: number, patch: Partial<Pick<Viewer, 'visible' | 'frozen' | 'size'>>): void
    broadcastFrame(jpeg: Buffer, size: { width: number; height: number }): void
    broadcastState(): void
    anyVisible(): boolean
    desiredViewport(): { width: number; height: number }
  }
  export type Viewers = ReturnType<typeof createViewers>
  /** Um conjunto por aba (WeakMap): cria o screencast com `context.newCDPSession(page)` e o religa no `tab.onPage`. */
  export function viewersFor(tab: TerminalTab): Viewers
  ```
- As regras:
  - **Quando roda o screencast:** só com `anyVisible()`, que conta visível e não congelado. Começa no primeiro espectador visível e para no último que sai.
  - **Para cada espectador visível e não congelado:**
    - com `bufferedAmount > 512 KB`, o quadro fica guardado no lugar do anterior (`pending`);
    - um relógio de 50 ms reconfere e manda só o último.
  - O `seq` cresce por aba.
  - **`desiredViewport()`:**
    - a `size` do espectador do dono do bastão (operador), se houver;
    - senão, a do espectador com o maior `openedAt` que tenha `size`;
    - senão, 1280×800.

    Quando o valor muda, chama `tab.setViewport` e depois `screencast.restart()`.
  - O `state` vai a cada `tab.onState`, `baton.onChange` e mudança de espectador. O campo `baton.you` é calculado por espectador (`userId` igual ao do dono).
  - A `presence` do bastão é recalculada a cada mudança de espectador: o dono tem algum espectador visível?
  - A marca da ação do agente: o `lastAction` vai no `state`, e a web apaga a marca no primeiro quadro que chegar 1,5 s depois de `at`. O servidor não desenha nada na imagem.

- [ ] **Step 1: Escrever os testes que falham.**
  - `browser-screencast.test.ts`, com CDP falso e relógio falso:
    - `start manda Page.startScreencast com jpeg, 55 e o tamanho`;
    - `dois quadros seguidos: o ack do segundo sai 100 ms depois do primeiro ack`, o que dá no máximo 10 por segundo em 1 s de quadros contínuos;
    - `stop manda Page.stopScreencast e para de ackar`;
    - `restart para e começa com o tamanho novo`.
  - `browser-viewers.test.ts`:
    - `encodeFrame/decodeFrame: 4 bytes BE + JSON + imagem`;
    - `sem espectador visível o screencast não começa; o primeiro visível começa; visible:false do último para`;
    - `bufferedAmount 600 KB: três quadros viram um só envio (o último) quando cai para 0`;
    - `espectador congelado não recebe quadros; se for o único, o screencast para`;
    - `o mesmo quadro vai a dois espectadores`;
    - `viewport segue o dono do bastão; sem bastão, a última coluna que abriu; sem nenhuma, 1280×800`;
    - `troca de viewport chama setViewport e restart, e o state com o viewport novo sai antes do próximo quadro` (Review Focus 4);
    - `dono sem espectador visível: presence(false); 30 s depois o bastão volta`;
    - `state.baton.you só para o espectador do dono`.
- [ ] **Step 2: Rodar e ver falhar** (`npx vitest run test/browser-screencast.test.ts test/browser-viewers.test.ts`).
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): screencast ritmado e espectadores com quadro mais recente`.

---

### Task 10: O WebSocket da tela, a entrada do operador e a revogação

**Files:**
- Create: `server/src/browser/socket.ts`, `server/src/browser/input.ts`
- Modify:
  - `server/src/auth/socket-access.ts`: `sendBinary(data: Buffer)` com a mesma guarda do `send`, e `get bufferedAmount()`;
  - `server/src/browser/feature.ts`: registra o socket; `closeUser`/`closeAll` deixam de ser no-op.
- Test: `server/test/browser-socket.test.ts`, `server/test/browser-input.test.ts`

**Interfaces:**
- Consumes: `createViewers` e `shared/browser.ts` (Task 9), `isAllowedOrigin` (`server/src/routes/terminal.ts`), `watchSocketAccess`, `canAccessProject`.
- Produces:
  ```ts
  export function parseClientMessage(raw: string): BrowserClientMsg | null       // valida tipos e faixas; inválido → null
  export function applyInput(tab: TerminalTab, msg: BrowserClientMsg, actor: Actor, o: { canMove: () => boolean }): Promise<void>
  export function registerBrowserSocket(app: FastifyInstance, d: { host: BrowserHost; db: Db; viewersFor: (tab: TerminalTab) => Viewers }): { closeUser(userId: number): void; closeAll(): void }
  ```
- O socket `GET /ws/browser/:projectId/:engine`, em ordem:
  1. `isAllowedOrigin`, senão `close(1008, 'origin')`;
  2. `watchSocketAccess`;
  3. projeto existe e `canAccessProject(req.authUser, projectId)`, senão `close(1008, 'forbidden')`;
  4. `host.existingTab(key)`. Sem aba, manda `state` com `closed: 'closed_by_user'` e fecha com 1000. Com Chromium indisponível, manda `state` com `unavailable` e mantém o socket.

  O cookie e o 401 já vêm do `onRequest` do plugin de auth: `/ws/` é guardado.
- O mapeamento da entrada, com o mouse e o teclado do Playwright:
  - **`pointer`:**
    - `down`/`up` tomam o bastão (`baton.operatorAct`) e chamam `page.mouse.move(x, y)` seguido de `page.mouse.down|up({ button, clickCount })`;
    - `move` só passa com o bastão do operador (dele ou de outro operador), no máximo 20 por segundo por socket; o resto é descartado;
  - **`wheel`:** toma o bastão e chama `page.mouse.move(x, y)` + `page.mouse.wheel(dx, dy)`;
  - **`key`:** toma o bastão e chama `page.keyboard.down|up(key)`. Uma `key` que o Playwright recusa (`Unidentified`, `Dead`, `Process`) é ignorada;
  - **`text`:** toma o bastão e chama `page.keyboard.insertText(text)`;
  - **`navigate`:** toma o bastão e chama `tab.navigate`. Esquema recusado volta como aviso no `state`;
  - **`history`:** toma o bastão;
  - **`take`:** `baton.operatorAct`;
  - **`release`:** `baton.release()`;
  - **`dialog`:** toma o bastão e chama `tab.answerDialog`;
  - **`freeze`:** com `on: true`, `page.screenshot({ type: 'png' })` vai só a este espectador como `still` e ele fica congelado; com `on: false`, descongela;
  - **`visible`** e **`resize`:** chamam `viewers.update`.
- O ator é `{ kind: 'operator', userId: user?.id ?? null, name: user?.username ?? 'operador' }`.
- A revogação: `closeUser(id)` fecha com 1008 os sockets desse usuário, e `closeAll()` fecha todos. O fim do horário de acesso fecha com 1008 pelo `watchSocketAccess`. A saída do espectador entra na `presence`, e o bastão volta em 30 s.

- [ ] **Step 1: Escrever os testes que falham.**
  - `browser-input.test.ts`, com página falsa:
    - `parseClientMessage recusa tipo desconhecido, números não finitos, key não string e text > 10000 caracteres`;
    - `pointer down toma o bastão e chama mouse.down com button e clickCount`;
    - `pointer move sem bastão do operador é ignorado`;
    - `move com bastão passa no máximo 20 por segundo`;
    - `key down 'Unidentified' é ignorada`;
    - `text chama insertText`;
    - `navigate com javascript: não navega e anota o aviso`;
    - `release devolve o bastão`.
  - `browser-socket.test.ts`, com o servidor de verdade em porta efêmera, cliente `ws` e host com dublê, como em `server/test/auth-ws.test.ts`:
    - `sem cookie → 401 no upgrade`;
    - `origem de outro site → fecha 1008`;
    - `usuário sem acesso ao projeto → 1008`;
    - `fora do horário de acesso → 1008`;
    - `closeUser(id) fecha os sockets dele com 1008 e não os de outro`;
    - `closeAll fecha todos`;
    - `visible:true começa o screencast e o primeiro binário chega com cabeçalho 'frame'`;
    - `sem visible nada binário chega`;
    - `freeze on devolve um 'still' PNG só a quem pediu`;
    - `revogação com o operador no comando: 30 s depois o bastão volta ao agente`, com relógio falso;
    - `aba que fecha (closeTab) manda state.closed e fecha o socket 1000`.
- [ ] **Step 2: Rodar e ver falhar** (`npx vitest run test/browser-socket.test.ts test/browser-input.test.ts`).
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, mais `test/auth-ws.test.ts` e `npx tsc --noEmit`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): WebSocket da tela com entrada do operador e revogação`.

---

### Task 11: Os servidores locais: varredura, Parar e rotas

**Files:**
- Create:
  - `server/src/local-servers/proc.ts` (leitura de `/proc`);
  - `server/src/local-servers/scan.ts`;
  - `server/src/local-servers/stop.ts`;
  - `server/src/local-servers/routes.ts`.
- Modify: `server/src/app.ts` (uma linha: `registerLocalServerRoutes(app, { db: deps.db, servicePort: deps.config.port })`, fora do `if (deps.browserHost)`)
- Test: `server/test/local-servers-scan.test.ts`, `server/test/local-servers-stop.test.ts`, `server/test/local-servers-routes.test.ts`

**Interfaces:**
- Consumes: `TERMINAL_MARKER_VAR`, `terminalMarker` e `ENGINES_FILTERING_ENV` (Task 1).
- Produces:
  ```ts
  // proc.ts — todas recebem procRoot (padrão '/proc') e não lançam: ilegível → null/[]
  export function listeningSockets(procRoot: string): Array<{ inode: string; port: number; host: string }>   // tcp + tcp6, estado 0A
  export function socketOwners(procRoot: string): Map<string, number>                                         // inode → pid, por /proc/<pid>/fd
  export function readStat(procRoot: string, pid: number): { ppid: number; pgrp: number; startTime: string; comm: string } | null  // comm pode ter espaço e ')': corta no último ')'
  export function readMarker(procRoot: string, pid: number): string | null
  export function readCmdline(procRoot: string, pid: number): string[]
  export function readCwd(procRoot: string, pid: number): string | null
  export function processLabel(cmdline: string[], comm: string): string   // ['node','/x/.bin/vite'] → 'vite'; ['python3','-m','http.server','8000'] → 'http.server'; senão basename(argv0) ou comm

  // scan.ts
  export interface LocalServer { pid: number; port: number; host: string; label: string; startTime: string; marker: 'exact' | 'cwd' }
  export function createServerScanner(o: { procRoot?: string; selfPid?: number; servicePort: number; ttlMs?: number /* 2000 */; now?: () => number }): {
    forTerminal(projectId: number, engine: string, projectPath: string): LocalServer[]
  }

  // stop.ts
  export class NotSameProcessError extends Error { code: 'not_same_process' }   // 'o processo já não é o mesmo'
  export class NoMarkerError extends Error { code: 'no_marker' }
  export function stopServer(o: { procRoot?: string; selfPid?: number; pid: number; startTime: string; marker: string;
    kill?: (pid: number, sig: NodeJS.Signals) => void; graceMs?: number /* 5000 */ }): Promise<{ target: 'group' | 'pid' }>
  ```
- As regras da varredura. Uma varredura, guardada 2 s, serve a todas as chaves.
  - **Exclusões:**
    - o `selfPid` e os seus ancestrais (subindo pelo `ppid`);
    - a porta `servicePort`;
    - todo processo com `ppid === selfPid`: as CLIs que o Claudinei abriu, inclusive o pty e o Chromium;
    - todo processo cujo pai tem `ppid === selfPid`: o filho direto de uma CLI, que é ferramenta do agente (decisão da checagem do construtor).
  - **O que entra:**
    - os netos da CLI e os readotados (`ppid` 1 ou um subreaper) entram, se tiverem o marcador;
    - o marcador conta só se for **exatamente** igual a `terminalMarker(projectId, engine)`;
    - para um motor em `ENGINES_FILTERING_ENV`, entra também quem não tem marcador nenhum e tem `readCwd` dentro de `projectPath` (`marker: 'cwd'`).
- As regras do Parar:
  - Antes de tudo, relê `readStat` e `readMarker`. Se o `startTime` ou o marcador diferirem, `NotSameProcessError`.
  - Recusa `selfPid`, os ancestrais e o grupo do próprio Claudinei (`pgrp` igual ao do `selfPid`).
  - Os membros do grupo são os pids com o mesmo `pgrp`. Se todos tiverem o mesmo marcador, `kill(-pgrp, 'SIGTERM')`; senão, `kill(pid, 'SIGTERM')`.
  - Depois de `graceMs`, se `readStat(pid)?.startTime === startTime`, manda `SIGKILL` ao mesmo alvo.
  - Um processo `marker: 'cwd'` não é parado: `NoMarkerError`.
- As rotas, ambas com `requireProjectAccess`:
  - `GET /api/projects/:id/terminals/:engine/servers` → `{ servers: LocalServer[] }`;
  - `POST /api/projects/:id/terminals/:engine/servers/:pid/stop`, com corpo `{ startTime: string }` → `{ ok: true, target }`. `NotSameProcessError` dá 409 com `fail('not_same_process', 'o processo já não é o mesmo')`; `NoMarkerError` dá 403 com `no_marker`.

- [ ] **Step 1: Escrever os testes que falham.**
  - Cada teste monta um `/proc` falso numa pasta temporária, com:
    - `net/tcp` e `net/tcp6` com linhas reais (porta 5173 = `1435`, estado `0A`);
    - `<pid>/fd/N`, um link para `socket:[inode]`;
    - `<pid>/stat`, `<pid>/environ` (NUL), `<pid>/cmdline` e `<pid>/cwd`.
  - `local-servers-scan.test.ts`:
    - `marcador exato: '4:claude' não pega '42:claude'`;
    - `filho direto da CLI (MCP com porta) fica fora; neto entra; readotado (ppid 1) entra` (os três casos da decisão);
    - `selfPid, ancestrais e porta do serviço ficam fora`;
    - `processo sem marcador fica fora; com o motor em ENGINES_FILTERING_ENV e cwd dentro da pasta entra como 'cwd'`;
    - `environ ilegível (arquivo ausente) não quebra a varredura`;
    - `comm com espaço e parênteses ('(a) b)') é lido certo`;
    - `processLabel nos dois exemplos`;
    - `a segunda chamada em menos de 2 s não relê /proc; depois de 2 s relê`;
    - `tcp6 '::' com a mesma porta não duplica a entrada do mesmo pid`.
  - `local-servers-stop.test.ts`, com `kill` dublê e relógio falso:
    - `startTime diferente → NotSameProcessError e nenhum kill`;
    - `marcador mudou → NotSameProcessError`;
    - `grupo todo com o mesmo marcador → kill(-pgrp, SIGTERM)`;
    - `grupo misto → kill(pid, SIGTERM)`;
    - `ainda vivo em 5 s com o mesmo startTime → SIGKILL ao mesmo alvo`;
    - `morto antes de 5 s → sem SIGKILL`;
    - `pgrp do próprio Claudinei → recusa sem kill`;
    - `marker 'cwd' → NoMarkerError`.
  - `local-servers-routes.test.ts`:
    - `sem acesso → 403`;
    - `GET devolve a lista`;
    - `POST 409 com 'o processo já não é o mesmo'`.
- [ ] **Step 2: Rodar e ver falhar** (`npx vitest run test/local-servers-scan.test.ts test/local-servers-stop.test.ts test/local-servers-routes.test.ts`).
- [ ] **Step 3: Implementar.** O código não roda comando externo: só `fs` e `process.kill`.
- [ ] **Step 4: Rodar e ver passar**, mais `test/browser-no-fn-evaluate.test.ts`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): servidores locais do terminal com Parar seguro`.

---

### Task 12: Web: a coluna da direita com abas, larguras, tela cheia, Zen, Alt+B e o botão do cabeçalho

**Files:**
- Create:
  - `web/src/browser/columnModel.ts` (puro);
  - `web/src/browser/columnStore.ts`;
  - `web/src/browser/RightColumn.tsx`;
  - `web/src/browser/ColumnResizer.tsx`;
  - `web/src/browser/browserStore.ts`;
  - `web/src/browser/api.ts`;
  - `web/src/browser/useBrowserShortcut.ts`;
  - `web/src/browser/BrowserButton.tsx`.
- Modify:
  - `web/src/components/ChatView.tsx`: as linhas 684–686 viram `<RightColumn … />`, e o `<BrowserButton>` entra ao lado do `<ProgressButton>` (~570);
  - `web/src/components/ProgressColumn.tsx`: o botão passa a chamar `toggleView('progress')`, e o fechar da coluna chama `closeColumn()`;
  - `web/src/App.tsx`: `applyBrowserMessage` antes dos outros na linha 136, e `useBrowserShortcut()`;
  - `web/src/shortcuts/registry.ts`: `'view.browser'` no tipo e em `EDITABLE`;
  - `web/src/i18n/pt-BR.ts`, `en.ts` e `es.ts`;
  - `web/src/styles.css`: a regra Zen `.app.zen .chat-layout > .progress` vira `.app.zen .right-column[data-view="progress"]`, e entram as classes novas.
- Test:
  - `web/src/test/column-model.test.ts`;
  - `web/src/test/right-column.test.tsx`;
  - `web/src/test/browser-shortcut.test.tsx`;
  - os existentes `zen.test.tsx`, `progress-column.test.tsx`, `side-column.test.tsx`, `goal-ui.test.tsx` e `shortcuts-tab.test.tsx` continuam passando.

**Interfaces:**
- Produces, em `columnModel.ts`:
  ```ts
  export type View = 'progress' | 'side' | 'browser'
  export interface ColumnState { open: boolean; view: View; previous: View | 'closed' | null; fullscreen: boolean; marked: View[] }
  export function sideBorn(s: ColumnState): ColumnState            // previous = open ? view : 'closed'; open; view 'side'
  export function sideGone(s: ColumnState): ColumnState            // view 'side' → previous (ou 'progress'); 'closed' → fecha
  export function agentOpened(s: ColumnState): ColumnState         // fechada ou em 'progress' → abre em 'browser'; em 'side' → marca 'browser'
  export function toggleView(s: ColumnState, v: View): ColumnState // aberta na mesma vista → fecha; senão abre nela e desmarca
  export function selectView(s: ColumnState, v: View): ColumnState
  export function effectiveView(s: ColumnState, avail: { side: boolean; browser: boolean }): View | null
  export function tabsFor(avail: { side: boolean; browser: boolean }): View[]   // progress sempre; side e browser se existirem
  export function columnWidth(view: View, stored: number | undefined, area: number): number
  // progress/side: stored ?? 340, em [280, area − 320]; browser: stored ?? area/2, em [360, area − 320]
  ```
- Produces, em `columnStore.ts`: um zustand com `ColumnState` mais `widths: Partial<Record<View, number>>`.
  - `open` é o `useStore.progressOpen` de sempre: lido e escrito por `toggleProgress` / `setState`, e o localStorage `claudinei:progressOpen` continua valendo.
  - O resto vai em `claudinei:column`, e as larguras em `claudinei:columnWidths`.
  - Ações: `toggleView(v)`, `selectView(v)`, `closeColumn()`, `toggleFullscreen()`, `setWidth(v, px)`, `sideBorn()`, `sideGone()` e `agentOpened()`.
- Produces, em `browserStore.ts`:
  - `useBrowserStore` com `tabs: Record<string, true>`, chaveado por `progressKey`;
  - `applyBrowserMessage(msg): boolean`, que trata `browser_tab`;
  - `useBrowserTabsSync()`, que lê `GET /api/browser/tabs` ao montar e a cada reconexão.
  - Quando chega `browser_tab { open: true, by: 'agent' }` do terminal ativo (`useStore.activeLocalId` → sessão), chama `columnStore.agentOpened()`.
- Produces, em `api.ts`: `fetchBrowserTabs()`, `openBrowserTab(projectId, engine)`, `closeBrowserTab(projectId, engine)`, `fetchServers(projectId, engine)` e `stopLocalServer(projectId, engine, pid, startTime)`.
- O registro do atalho: `{ id: 'view.browser', labelKey: 'shortcuts.labels.browser', default: 'Alt+B', scope: 'allButTerminal', editable: true }`.
- O `useBrowserShortcut()` segue o padrão do `useZenShortcut`, com `defaultPrevented` e `repeat`. O `BrowserButton` do cabeçalho chama a mesma ação, `toggleBrowserView(projectId, engine)`, exportada de `columnStore.ts`. A ação:
  - com a vista Navegador já à vista, fecha;
  - senão, se o terminal ativo não tem aba, chama `openBrowserTab` e depois `toggleView('browser')`.
- O `RightColumn`:
  - **Quando aparece:**
    - com `effectiveView` nulo, não desenha nada;
    - senão, desenha `<aside className="right-column" data-view={view}>`.
  - **O que tem dentro:**
    - as abas de texto de `tabsFor`, com a marca estática em `marked`;
    - o puxador na borda esquerda;
    - o botão de tela cheia;
    - a vista: `ProgressColumn`, `SideColumn` ou `BrowserColumn` (Task 13; até lá, um marcador).
  - **A Lateral:** a mudança do `side.info.id` do mesmo terminal (null → id, id → null) chama `sideBorn`/`sideGone`. Trocar de terminal não conta.
  - **Tela cheia:** a classe `chat-layout--column-full` esconde `.chat-main`, e a lista de terminais fica à vista.
  - **Celular:** a coluna cobre o chat, com a mesma regra `position: fixed` que a `.progress` tem hoje.
  - **O puxador:** atualiza a largura no `pointermove` e grava no `pointerup`, sem rAF.

- [ ] **Step 1: Escrever os testes que falham.**
  - `column-model.test.ts`:
    - `sideBorn com coluna fechada → abre em side; sideGone → fecha de novo`;
    - `sideBorn com coluna em browser → side; sideGone → volta a browser`;
    - `agentOpened: fechada → abre em browser; em progress → browser; em side → só marca browser`;
    - `toggleView na vista aberta fecha; noutra vista troca`;
    - `effectiveView sem side disponível cai em progress`;
    - `tabsFor sem side e sem aba → ['progress']`;
    - `columnWidth: browser padrão é metade da área; mínimo 360; máximo área − 320; progress padrão 340`.
  - `right-column.test.tsx`:
    - `abas só das vistas existentes`;
    - `clicar na aba troca a vista`;
    - `largura lembrada por vista no localStorage`;
    - `tela cheia esconde o chat e o mesmo botão volta`;
    - `Zen esconde só data-view=progress`;
    - `nascer a lateral toma a coluna e fechá-la volta à anterior`;
    - `browser_tab do agente no terminal ativo abre em Navegador`;
    - `browser_tab de outro terminal não mexe na coluna`.
  - `browser-shortcut.test.tsx`:
    - `Alt+B abre e fecha a vista`;
    - `no terminal interativo Alt+B não age`;
    - `a aba Atalhos lista 'view.browser' com Alt+B editável`.
- [ ] **Step 2: Rodar e ver falhar** (`cd web && npx vitest run src/test/column-model.test.ts src/test/right-column.test.tsx src/test/browser-shortcut.test.tsx`).
- [ ] **Step 3: Implementar e trocar o trecho do `ChatView`.** No `ChatView` mudam só as linhas citadas e o import.
- [ ] **Step 4: Rodar e ver passar** os testes novos e os existentes listados. Depois, `cd web && npx tsc -b`.
- [ ] **Step 5: Commit**, sem `web/tsconfig.tsbuildinfo`, com a mensagem `feat(navegador): coluna da direita com abas, larguras, tela cheia e Alt+B`.

---

### Task 13: Web: a vista Navegador com socket, canvas, entrada, selo do bastão, barra de endereço, servidores e avisos

**Files:**
- Create:
  - `web/src/browser/frame.ts`;
  - `web/src/browser/browserSocket.ts`;
  - `web/src/browser/painter.ts`;
  - `web/src/browser/coords.ts`;
  - `web/src/browser/BrowserColumn.tsx`;
  - `web/src/browser/BrowserScreen.tsx`;
  - `web/src/browser/ServersStrip.tsx`.
- Modify: `web/src/browser/RightColumn.tsx` (usa `BrowserColumn`), `web/src/i18n/*.ts`, `web/src/styles.css`
- Test:
  - `web/src/test/browser-painter.test.ts`;
  - `web/src/test/browser-coords.test.ts`;
  - `web/src/test/browser-column.test.tsx`;
  - `web/src/test/browser-keys.test.tsx`.

**Interfaces:**
- Consumes: `shared/browser.ts` (Task 9), `api.ts` e `columnStore` (Task 12), `matchShortcut` (`web/src/shortcuts/active.ts`).
- Produces:
  ```ts
  // frame.ts
  export function parseFrame(buf: ArrayBuffer): { header: FrameHeader; image: Blob }   // jpeg para 'frame', png para 'still'
  // painter.ts — sem requestAnimationFrame
  export function createPainter(canvas: HTMLCanvasElement, d?: { createImageBitmap?: (b: Blob) => Promise<ImageBitmap> }): {
    push(image: Blob, header: FrameHeader): void   // decodificando → guarda só o último; ao terminar, drawImage e close() do bitmap
    lastSeq(): number
  }
  // coords.ts
  export function toViewport(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number },
    viewport: { width: number; height: number }): { x: number; y: number }   // grampeado ao viewport, arredondado
  // browserSocket.ts
  export function connectBrowser(projectId: number, engine: string, h: { onState(s: BrowserStateMsg): void; onFrame(f: { header: FrameHeader; image: Blob }): void; onClose(code: number): void }): { send(m: BrowserClientMsg): void; close(): void }
  // reconecta em 1 s, 2 s, 5 s e 10 s; não reconecta em 1008 nem em 1000 com state.closed
  ```
- `BrowserColumn` mostra:
  - **O cabeçalho:**
    - barra de endereço (Enter → `navigate`), voltar, avançar e recarregar;
    - o selo do bastão, com os textos do i18n:
      - `browser.baton.agent` = "Agente no comando";
      - `browser.baton.you` = "Você no comando", com o botão `browser.baton.release` = "Devolver ao agente";
      - `browser.baton.other` = "{{name}} no comando";
      - `browser.baton.free` = "Livre";
    - Anotar (Task 14), tela cheia e fechar a aba (`closeBrowserTab`);
    - "sem sandbox" quando `sandbox === false`.
  - **A faixa de servidores** (`ServersStrip`):
    - `fetchServers` a cada 5 s, só com a vista visível;
    - cada item é ":<porta> <label> — Abrir · Parar";
    - Abrir manda `navigate` para `http://127.0.0.1:<porta>`;
    - Parar chama `stopLocalServer` com o `startTime`; o 409 mostra "o processo já não é o mesmo";
    - `marker: 'cwd'` mostra "sem marcador" e só Abrir.
  - **A última ação do agente:** `lastAction.text`.
  - **A tela:**
    - um `<canvas>` com largura e altura do viewport;
    - um `<textarea>` invisível por cima, que recebe teclado, colar e composição;
    - a marca estática da ação do agente em `lastAction.point`, apagada no primeiro quadro com `Date.now() − at ≥ 1500`.
  - **O diálogo pendente:** a mensagem com OK e Cancelar (o `prompt` com campo).
  - **Os avisos:** a lista curta de `state.notices`.
  - **O aviso de senha:** a faixa `browser.passwordWarning` = "O agente deste terminal lê o que você digitar aqui, inclusive senhas. Prefira um login de teste.", com o botão "Entendi". Aparece quando `baton.you` é verdadeiro e `claudinei:browserPasswordWarned` não está gravado.
  - **Indisponível:** "Navegador não instalado. No servidor, rode `<hint>`".
  - **O que acontece quando a aba fecha:**
    - `closed: 'browser_closed'` → "O navegador fechou", com o botão Reabrir (`openBrowserTab`);
    - `crashed` → "A página travou", com o botão Recarregar (`history reload`).
- A visibilidade: manda `visible` com `vistaAtiva && colunaAberta && !document.hidden && intersectando`, por `visibilitychange` e `IntersectionObserver`. Desmontar manda `visible: false` e fecha o socket.
- O `resize`: um `ResizeObserver` na área da tela, com 250 ms de espera, em px CSS arredondados.
- A entrada:
  - **Mouse:** `pointerdown`/`up` no canvas viram `pointer`, convertidos por `toViewport`, e o foco vai ao textarea. `pointermove` só sai com `baton.you`, no máximo 20 por segundo.
  - **Rolagem:** `wheel`, com `preventDefault`.
  - **Toque (`pointerType 'touch'`):** um toque vira `down` + `up`; arrastar vira `wheel` com os deltas invertidos.
  - **Teclado:** um ouvinte nativo de `keydown`/`keyup` no textarea.
    - Se a tecla casa com `matchShortcut(e, 'view.browser')`, nada é feito e o evento sobe ao atalho global.
    - Senão, `preventDefault()` + `stopPropagation()` e envio de `key`.
  - **Texto:** `paste` e `compositionend` mandam `text`. `input` sem composição é ignorado, porque a tecla já foi.
  - **Clicar fora:** o textarea perde o foco e o teclado volta ao Claudinei.

- [ ] **Step 1: Escrever os testes que falham.**
  - `browser-painter.test.ts`, com `createImageBitmap` dublê que resolve quando o teste mandar:
    - `três push durante uma decodificação → só o primeiro e o último são decodificados`;
    - `drawImage chamado por bitmap e close() logo depois`;
    - `nenhuma chamada a requestAnimationFrame` (espião em `window.requestAnimationFrame`).
  - `browser-coords.test.ts`:
    - `rect 640×400 mostrando viewport 1280×800: clique em (320,200) → (640,400)`;
    - `fora do canvas é grampeado`.
  - `browser-column.test.tsx`, com `connectBrowser` dublê:
    - `selo nos quatro estados`;
    - `Devolver ao agente manda release`;
    - `Enter na barra manda navigate`;
    - `visible:false ao trocar de aba da coluna e ao document.hidden`;
    - `resize sai uma vez depois de 250 ms`;
    - `servidores: Abrir manda navigate para http://127.0.0.1:5173; Parar com 409 mostra 'o processo já não é o mesmo'; 'cwd' sem Parar`;
    - `aviso de senha aparece na primeira tomada e some com Entendi (lembrado)`;
    - `indisponível mostra o comando`;
    - `browser_closed mostra Reabrir`;
    - `diálogo confirm: OK manda dialog accept true`.
  - `browser-keys.test.tsx` (Review Focus 5):
    - com o foco no textarea, `Alt+Z`, `Ctrl+Enter`, `Ctrl+F` e `Ctrl+U` mandam `key` e não ligam o Zen, não enviam e não abrem a busca;
    - `Alt+B` não manda `key` e fecha a vista;
    - com `view.browser` regravado para `Alt+N`, `Alt+B` vai à página.
- [ ] **Step 2: Rodar e ver falhar** (`cd web && npx vitest run src/test/browser-painter.test.ts src/test/browser-coords.test.ts src/test/browser-column.test.tsx src/test/browser-keys.test.tsx`).
- [ ] **Step 3: Implementar.** A coluna não tem transição CSS nem animação.
- [ ] **Step 4: Rodar e ver passar.** Depois, `npx tsc -b`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): vista Navegador com canvas, entrada do operador e servidores`.

---

### Task 14: Web: Anotar e mandar ao campo

**Files:**
- Create: `web/src/browser/Annotator.tsx`, `web/src/browser/annotate.ts` (puro: marcas e recorte)
- Modify: `web/src/browser/BrowserColumn.tsx` (o botão Anotar), `web/src/i18n/*.ts`
- Test: `web/src/test/browser-annotate.test.tsx`

**Interfaces:**
- Consumes: o `still` (Task 10, `freeze`), `uploadFile` (`web/src/api.ts:355`) e `requestAppend` (`web/src/branch/sideStore.ts:195`).
- Produces:
  ```ts
  export type Mark = { kind: 'rect' | 'arrow'; x1: number; y1: number; x2: number; y2: number } | { kind: 'text'; x: number; y: number; text: string }
  export interface AnnotationState { marks: Mark[]; crop: { x: number; y: number; w: number; h: number } | null }
  export function addMark(s: AnnotationState, m: Mark): AnnotationState
  export function undoMark(s: AnnotationState): AnnotationState
  export function annotationText(url: string, viewport: { width: number; height: number }): string   // `Anotação de ${url} (viewport ${w}×${h}):`
  export function annotationFileName(now?: Date): string                                            // `anotacao-HHMMSS.png`
  export async function sendAnnotation(o: { localId: string; still: ImageBitmap; s: AnnotationState; url: string; viewport: { width: number; height: number };
    upload?: typeof uploadFile; append?: typeof requestAppend }): Promise<void>
  ```
- O fluxo:
  1. Anotar manda `freeze { on: true }`. O `still` PNG vira a base do canvas de anotação, e o screencast deste espectador pausa.
  2. As ferramentas são retângulo, seta, texto, recorte e desfazer, numa cor só (`var(--accent)` lido uma vez).
  3. "Mandar ao campo" desenha base + marcas no recorte (ou no viewport inteiro), chama `toBlob('image/png')` e `upload(new File([blob], annotationFileName(), { type: 'image/png' }))`.
  4. Com o token ``tok = `[📎 ${saved.name}]` ``, chama `append(localId, `${annotationText(url, viewport)} ${tok}`, [[tok, saved.path]])`.
  5. Sair, Cancelar ou Mandar mandam `freeze { on: false }`.

  O `localId` é o da sessão principal do terminal.

- [ ] **Step 1: Escrever os testes que falham:**
  - `annotationText('http://127.0.0.1:5173/', {1280,800})` → `'Anotação de http://127.0.0.1:5173/ (viewport 1280×800):'`;
  - `undoMark tira só a última`;
  - `sendAnnotation chama upload com image/png e append com o texto, o token e o par [token, path]`;
  - `upload que falha não chama append e mostra o erro`;
  - `Anotar manda freeze on; Cancelar manda freeze off`.
- [ ] **Step 2: Rodar e ver falhar** (`cd web && npx vitest run src/test/browser-annotate.test.tsx`).
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Depois, `npx tsc -b`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): anotar a tela e mandar o recorte ao campo`.

---

### Task 15: Web: encerrar ou excluir com servidores de pé

**Files:**
- Create: `web/src/browser/StopServersDialog.tsx`, `web/src/browser/serversOnStop.ts`
- Modify:
  - `web/src/components/EngineTabs.tsx` (`confirmStop`, ~51);
  - `web/src/components/DeleteProjectDialog.tsx` (`confirm`, ~40);
  - `web/src/i18n/*.ts`.
- Test: `web/src/test/stop-servers.test.tsx`

**Interfaces:**
- Consumes: `fetchServers` e `stopLocalServer` (Task 12).
- Produces:
  ```ts
  export async function serversOf(projectId: number, engines: string[]): Promise<Array<LocalServer & { engine: string }>>   // só marker 'exact'
  export function serversSummary(list: LocalServer[]): string     // ':5173 vite, :3000 node'
  export async function stopAll(projectId: number, list: Array<LocalServer & { engine: string }>): Promise<void>   // falhas individuais não interrompem
  ```
- O texto, verbatim: `localServers.ask` = "Este terminal deixou {{count}} servidores no ar ({{list}}). Parar também?". Os botões são `localServers.stopAndEnd` = "Parar e encerrar", `localServers.onlyEnd` = "Só encerrar" e "Cancelar".
- **Encerrar** (EngineTabs): antes do `stopSession`, `serversOf(projectId, [engine])`.
  - Lista vazia: encerra como hoje.
  - Lista com servidores: mostra o diálogo. "Parar e encerrar" chama `stopAll` e depois `stopSession`; "Só encerrar" chama `stopSession`; Cancelar não faz nada.
- **Excluir** (DeleteProjectDialog): o mesmo, com os motores das sessões do projeto no store. Vem antes do `deleteProject`, e o "Parar e excluir" usa o mesmo diálogo com o rótulo de excluir.
- Encerramentos sem o operador (reinício, morte da sessão) não passam por aqui.

- [ ] **Step 1: Escrever os testes que falham:**
  - `sem servidores encerra direto`;
  - `com dois servidores mostra 'Este terminal deixou 2 servidores no ar (:5173 vite, :3000 node). Parar também?'`;
  - `Parar e encerrar para os dois e depois encerra`;
  - `Só encerrar não chama stopLocalServer`;
  - `Cancelar não encerra`;
  - `servidor 'cwd' não entra na conta`;
  - `excluir projeto consulta todos os motores com sessão`.
- [ ] **Step 2: Rodar e ver falhar** (`cd web && npx vitest run src/test/stop-servers.test.tsx`).
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, mais os testes existentes de `EngineTabs` e `DeleteProjectDialog` (`npx vitest run src/test -t "excluir|encerrar"`). Depois, `npx tsc -b`.
- [ ] **Step 5: Commit**, com a mensagem `feat(navegador): perguntar pelos servidores ao encerrar ou excluir`.

---

### Task 16: Ensaio isolado na porta 9196: binário, motores e CPU

Sem commit de código, salvo correções que o ensaio revele (cada uma com o teste que a prende, na tarefa dona). Nada de reiniciar o `claudinei.service`. Nada na 9105.

- [ ] **Step 1: Suíte completa e tipos.**
  - `cd server && PATH=$N24:$PATH npx vitest run`. A única falha tolerada é a intermitente do orchestrator, conferida isolada (memória "Teste flaky do orchestrator").
  - `cd web && npx vitest run && npx tsc -b`.
  - `cd server && PATH=$N24:$PATH npx tsc --noEmit`.

- [ ] **Step 2: Empacotar:** `PATH=$N24:$PATH npm run package` na raiz do worktree.

- [ ] **Step 3: Subir a instância isolada com banco novo.**
  ```bash
  mkdir -p /tmp/claudinei-e2e-navegador
  env -u CLAUDINEI_HERMES_COMMAND -u CLAUDINEI_HERMES_ARGS -u CLAUDINEI_TERMINAL \
    CLAUDINEI_PORT=9196 CLAUDINEI_DB=/tmp/claudinei-e2e-navegador/claudinei.db \
    CLAUDINEI_UPLOADS=/tmp/claudinei-e2e-navegador/uploads CLAUDINEI_SCHEDULES=/tmp/claudinei-e2e-navegador/schedules \
    CLAUDINEI_SPEECH=/tmp/claudinei-e2e-navegador/speech \
    ./release/claudinei-linux-x64 --port 9196 > /tmp/claudinei-e2e-navegador/log.txt 2>&1 &
  ```
  Banco novo é pré-setup, e o loopback é liberado. Crie um projeto apontando para `/tmp/claudinei-e2e-navegador/proj` pela API (`POST /api/projects`). Se, em vez disso, usar uma cópia do banco real, neutralize antes de subir:
  - `UPDATE schedules SET enabled=0`;
  - em `terminal_state`: `autostart=0`, `auto_resume=0`, `auto_resume_limit=0`, `interrupted_*` NULL, `limit_hit_at` e `limit_resets_at` NULL e `limit_action='none'`.

- [ ] **Step 4: O navegador pelo binário.**
  - Rode `curl -s -X POST localhost:9196/api/hermes/browser/open -H 'content-type: application/json' -d '{"projectId":<id>,"engine":"claude","url":"http://127.0.0.1:9196/"}'` e depois `…/snapshot`.
  - Esperado: o `status` com `control: free`, e a snapshot com `[ref=`.
  - Rode `…/navigate` com `file:///etc/passwd`. Esperado: 400 `scheme_refused`.

- [ ] **Step 5: Um turno curto por motor.**
  - Nos quatro motores, na UI da 9196, com o modelo mais barato de cada um, mande: `Run exactly: echo "MARK=$CLAUDINEI_TERMINAL"; python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &`. Use uma porta diferente por motor: 8765 a 8768.
  - Esperado: `MARK=<id>:<motor>` na saída da ferramenta.
  - `GET /api/projects/<id>/terminals/<motor>/servers` lista a porta do motor e não a dos outros.
  - Parar pela coluna derruba o processo; confira com `ss -ltn`.
  - Num dos motores, mande `browser_open` com `http://127.0.0.1:8765/` pela própria ferramenta. Confira que a coluna abre no Navegador e mostra a mesma página.
  - Depois, apague as conversas criadas: as do Claude e do Codex no storage, e no OpenCode `opencode session delete`.

- [ ] **Step 6: CPU do lado do operador, sem GPU.**
  - Escreva um script em `/tmp/claudinei-e2e-navegador/cpu.mjs`. Ele usa o `playwright-core` e o `chromium-1255` completo, com `--disable-gpu`, sem tela.
  - O script abre a UI da 9196 no terminal com a aba aberta numa página densa (um texto longo com rolagem automática no próprio servidor de teste).
  - Para medir, lê `SystemInfo.getProcessInfo` por `browser.newBrowserCDPSession()` duas vezes, com 10 s de intervalo, e calcula a CPU do renderer.
  - Esperado:
    - com a coluna aberta, até 10% de um núcleo;
    - com a coluna fechada, cerca de 0 e nenhum quadro binário no socket (conte as mensagens num `page.on('websocket')`).
  - Registre os números no relatório. Lembre que um ensaio em Chrome por software não prova sozinho a causa de lentidão (AGENTS.md).

- [ ] **Step 7: Limpar.**
  - Mate o PID da 9196 e confira com `pgrep -f 'claudinei-linux-x64 --port 9196'` que ele não está mais vivo.
  - Confira que nenhum Chromium órfão ficou: o pipe garante, mas confira com `pgrep -f chrome-headless-shell` e compare com os processos de antes.
  - Rode `rm -rf /tmp/claudinei-e2e-navegador`.
  - Apague as conversas do Claude de teste em `~/.claude/projects/<caminho-codificado>`.

- [ ] **Step 8: Relatório ao coordenador.** Inclua:
  - os resultados dos Steps 4 a 6;
  - os números de CPU;
  - se algum motor precisou do plano B do `cwd`.

  Peça confirmação antes de qualquer instalação ou reinício.
