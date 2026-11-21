# Navegador embutido — desenho

Projeto 16 do roteiro `docs/superpowers/roteiro-ideias-t3code.md`: o agente navega, o operador vê, anota e manda o recorte ao chat; os servidores locais de cada terminal aparecem com Parar. Os números vêm do levantamento da onda D e dos ensaios desta spec (seção "Evidências"). O módulo `server/src/browser/host.ts` é deste projeto e serve também à ferramenta `html_preview` do projeto 15.

## Por quê

- Para conferir uma página, hoje o agente usa um navegador próprio que o operador não vê (os MCPs de navegador do Claude; o Codex não tem nenhum), e o operador abre outra aba na máquina dele para ver a mesma coisa. Os dois olham telas diferentes.
- Quando algo está errado na tela, o operador tira um print, recorta e cola no campo à mão.
- Servidores de desenvolvimento que o agente sobe (`npm run dev &`) ficam de pé depois do turno e ninguém sabe de qual terminal são. No Claude, o painel de processos em segundo plano sabe parar só os da sessão; nos outros motores, nada.

## Objetivos

1. Um navegador por terminal (projeto + motor), na coluna à direita do chat, que o agente dos quatro motores dirige por ferramentas do hermes e o operador vê ao vivo, no mesmo navegador.
2. O operador clica, digita e rola; ao agir, assume o comando (bastão) até devolver.
3. Anotar: congelar, desenhar retângulo, seta e texto, recortar e mandar a imagem ao campo de mensagem, com a URL.
4. Servidores locais de cada terminal listados com Abrir e Parar, sem nunca atingir o de outro terminal.
5. Leve sem GPU no lado do operador: um canvas, quadros só quando a tela muda, nada com a coluna fechada.

## Não-objetivos

- Logins que sobrevivem a reinício (perfil persistente por projeto): o operador escolheu não ter, por ora.
- Mostrar o app por iframe com proxy reverso: o agente não age num iframe, e a tela divergiria.
- O agente rodar JavaScript arbitrário na página (`evaluate`), enviar arquivos (`<input type=file>`), DevTools.
- Várias abas por terminal; copiar da página remota para a área de transferência do operador; áudio.

## Anti-objetivos

- Uma porta CDP em TCP, mesmo em 127.0.0.1: qualquer processo da máquina dirigiria todas as abas.
- Parar processo de outro terminal, do próprio Claudinei ou sem conferir o marcador logo antes do sinal.
- Animação contínua ou laço de `requestAnimationFrame` na coluna (AGENTS.md): só se desenha quando chega quadro.
- Quadros acumulando num WebSocket lento: o quadro mais recente vence, o resto é descartado.

## Abordagens consideradas

1. **Chromium sem tela no servidor, screencast via CDP, ferramentas no hermes (escolhida).** É a única em que agente e operador veem a mesma página, vale nos quatro motores sem configuração nova e deixa o servidor arbitrar o bastão. É o que o T3 Code faz no `t3 serve` (`ServerBrowser.ts`: chrome-headless-shell via playwright-core, JPEG, ack ritmado).
2. Injetar `@playwright/mcp --cdp-endpoint` por terminal. Exige porta CDP aberta, depende do npx e não arbitra o operador. Descartada.
3. Xvfb + noVNC ou WebRTC: encoder de vídeo por software, mais caro. Descartada.

## Desenho — servidor

**Biblioteca: `playwright-core` fixado em `1.65.1` (sem `^`), externo ao bundle.** CDP direto pelo pipe obrigaria a reescrever a snapshot de acessibilidade com referências, a espera de "elemento clicável", diálogos e a entrada de teclado — o miolo do controle pelo agente. Ensaio feito (ver "Evidências"): embutido no bundle do esbuild ele quebra (procura o próprio `package.json` pelo `__dirname`); como externo, copiado para `assets/native/playwright-core` igual aos nativos (`scripts/package.mjs`, lista `EXTERNAL`) e achado pelo `NODE_PATH`, funciona dentro do binário do pkg. Três ajustes:
- podar `lib/vite` (o visualizador de traces): o pacote cai de 14 MB para 9,9 MB, e o ensaio rodou igual;
- o Node do pkg vem sem `inspector`, e o playwright-core faz `require("inspector")` ao carregar: o `pkg-runtime.ts` instala, antes do primeiro `require` dele, um desvio que devolve um módulo vazio só se o verdadeiro falhar;
- o pkg compila o código do Claudinei em bytecode, e função passada a `page.evaluate` perde o texto ("Passed function is not well-serializable"): no código do Claudinei, `evaluate` só com string. Um teste varre `server/src/browser/`.

**Achar o Chromium.** Na ordem: (1) `CLAUDINEI_CHROMIUM`, caminho de um executável; (2) a resolução do próprio playwright-core, que procura a revisão exata que a versão fixada espera (`PLAYWRIGHT_BROWSERS_PATH` ou `~/.cache/ms-playwright/chromium_headless_shell-1255`, já presente nesta máquina). Sem nenhum, nada é baixado sozinho: a coluna e as ferramentas dizem "Navegador não instalado. No servidor, rode `npx -y playwright-core@1.65.1 install --no-remove chromium-headless-shell`" (o `--no-remove` evita apagar as outras revisões do cache, que os MCPs do operador usam). Outra revisão não é aceita: o protocolo pode não casar. O `package.mjs` avisa no build se a revisão esperada não estiver no cache da máquina.

**`server/src/browser/host.ts` (contrato com o projeto 15).** Criado uma vez em `server/src/index.ts` e passado por `deps`. Abre o Chromium sob demanda (`headless`, `--remote-debugging-pipe`, sandbox do Chromium ligada; se a subida falhar por causa dela, sobe sem e registra no log e no cabeçalho da coluna), conta o uso e fecha o processo 2 min depois de ficar sem abas e sem páginas isoladas. O pipe também garante que o Chromium morre junto com o serviço.

```ts
export interface ConsoleEntry { type: string; text: string }        // 'log' | 'warning' | 'error' | 'pageerror' …
export interface PreviewPage {
  setContent(html: string): Promise<void>                            // espera o 'load'
  goto(url: string): Promise<void>                                   // só http:, https:, about:blank
  screenshot(opts: { fullPage: boolean }): Promise<Buffer>           // PNG
  contentHeight(): Promise<number>                                   // scrollHeight do documento, px CSS
  consoleMessages(): ConsoleEntry[]                                  // coletadas desde a abertura
}
export interface IsolatedPageOpts { viewport: { width: number; height: number }; offline?: boolean; timeoutMs?: number }
export interface BrowserHost {
  withIsolatedPage<T>(opts: IsolatedPageOpts, fn: (page: PreviewPage) => Promise<T>): Promise<T>
  tab(key: TerminalKey): Promise<TerminalTab>                        // cria sob demanda (uso do projeto 16)
  existingTab(key: TerminalKey): TerminalTab | undefined
  closeTab(key: TerminalKey): Promise<void>
  status(): { state: 'closed' | 'starting' | 'open' | 'unavailable'; tabs: number; reason?: string }
  shutdown(): Promise<void>
}
export interface BrowserHostDeps { log: (line: string) => void; idleMs?: number; now?: () => number; launch?: LaunchFn }
export function createBrowserHost(deps: BrowserHostDeps): BrowserHost
// TerminalKey, TerminalTab e LaunchFn são internos do projeto 16; o 15 não os usa.
export class BrowserUnavailableError extends Error { code: 'browser_not_installed' | 'launch_failed'; hint: string }
```

`withIsolatedPage` abre um contexto novo (sem cookies, downloads recusados, `offline` quando pedido), conta como uso (o processo não fecha no meio), e fecha o contexto no `finally`, com erro ou com estouro de `timeoutMs` (padrão 15 s, que rejeita com `Error('timeout')`). No máximo duas páginas isoladas ao mesmo tempo; as outras esperam na ordem. O projeto 15 usa só `createBrowserHost`, `withIsolatedPage` e `BrowserUnavailableError`; o `launch` é a costura do dublê nos testes.

**A aba do terminal (`server/src/browser/terminal-tab.ts`).** Um contexto isolado por terminal (`TerminalKey` = projectId + motor), com uma página só. Viewport: o tamanho da tela da coluna de quem tem o bastão ou, sem bastão, da última coluna que abriu (entre 320×240 e 1920×1200; sem coluna nenhuma, 1280×800), com `deviceScaleFactor` 1. Janela nova (`target=_blank`, `window.open`) vira navegação na própria aba. `alert` e `beforeunload` são aceitos e anotados; `confirm` e `prompt` ficam pendentes, na coluna com OK/Cancelar, e para o agente na ação `dialog`. Seletor de arquivo é cancelado com aviso. A aba fecha depois de 30 min sem ferramenta do agente e sem coluna visível; até 8 abas: a nona fecha a mais ociosa que não esteja visível ou é recusada com "muitos navegadores abertos". Nada vai ao banco.

**O bastão.** Estados: livre, agente agindo (só durante uma ferramenta) e operador no comando (com o nome do usuário). Clique, tecla, rolagem, barra de endereço, voltar e recarregar do operador tomam o bastão na hora; mover o mouse sem ter o bastão não toma. Com o operador no comando, as ferramentas que mudam a página (`browser_navigate`, `browser_act`, `browser_open` com URL, `browser_close`) respondem com erro "The operator is controlling the browser. Do not retry in a loop; read-only tools still work; ask the operator to click 'Return to agent' if you need it". Leitura (`browser_snapshot`, `browser_screenshot`, `browser_console`) segue valendo. O bastão volta com "Devolver ao agente", ou quando nenhuma coluna desse operador fica aberta por 30 s. Cada ação do operador avança um contador da aba; uma `browser_act` com referência tirada antes disso é recusada com "the page changed since your last snapshot; take a new browser_snapshot". Ação do agente já em curso quando o operador toma o bastão termina; a seguinte é recusada.

**Ferramentas do hermes** (`server/src/hermes/run-hermes.ts`, chamando `POST /api/hermes/browser/<op>` com `projectId` + `engine`, a mesma autenticação de `goal-done`). Nenhuma linha nova nas instructions (orçamento de 3800 caracteres em `instructions.ts`): tudo nas descrições. Sem a regra "só quando pedirem" (decisão 10b).
- `browser_open({ url? })`: abre ou reaproveita a aba do terminal; devolve URL, título e quem está no comando.
- `browser_navigate({ url } | { action: 'back' | 'forward' | 'reload' })`.
- `browser_snapshot({ depth? })`: a snapshot de acessibilidade com referências (`page.ariaSnapshot({ mode: 'ai' })`, `[ref=e6]`), cortada em 60 mil caracteres com aviso. Valor de campo de senha sai como `••••`.
- `browser_act({ action, ref?, text?, key?, dx?, dy?, accept? })`, com `click`, `type`, `fill`, `press`, `hover`, `select`, `scroll` e `dialog`; a referência vira o seletor `aria-ref=e6`.
- `browser_wait({ text? | textGone? | url? | seconds? })`, teto de 30 s.
- `browser_screenshot({ fullPage? })`: imagem PNG no resultado e, também, o caminho do arquivo salvo pela rotina de uploads (`saveUpload`), para motor que não mostre imagem de ferramenta MCP.
- `browser_console()`: as últimas 50 mensagens do console e erros da página.
- `browser_close()`.

Todo resultado traz uma linha de estado (URL, comando, avisos novos: diálogo pendente, download bloqueado, bastão devolvido). O servidor mostra na coluna a última ação do agente ("clicou em 'Enviar'") e marca o ponto do clique com um sinal estático que some no quadro seguinte depois de 1,5 s.

**WebSocket da tela: `/ws/browser/:projectId/:engine`.** Passa pelo mesmo `onRequest` de `/ws` (cookie, 401 aborta), por `isAllowedOrigin`, por `canAccessProject` (fecha com 1008) e por `watchSocketAccess` (horário de acesso, conferido a cada segundo e a cada mensagem; ganha um `sendBinary`). Entra no `closeUser` da revogação, como o `/ws`.
- Servidor → web, texto JSON: `state` (URL, título, carregando, bastão e de quem, viewport, avisos, indisponível).
- Servidor → web, binário: 4 bytes com o tamanho de um cabeçalho JSON (`{ kind: 'frame' | 'still', seq, width, height }`) e depois a imagem (JPEG do quadro, PNG do congelado).
- Web → servidor, texto JSON: `visible`, `resize`, `pointer` (down, up, move), `wheel`, `key` (key, code, modificadores), `text` (colar e composição), `navigate`, `history`, `take`, `release`, `dialog`, `freeze`.

O screencast (`Page.startScreencast`, JPEG qualidade 55, `maxWidth`/`maxHeight` = viewport) só roda com ao menos um espectador visível daquele terminal. O ack ao Chromium sai no mínimo 100 ms depois do anterior (≤ 10 quadros/s); com a página parada o Chromium não manda nada. Se o socket tiver mais de 512 KB na fila (`bufferedAmount`), o quadro espera no lugar do anterior e só o último sai. O mesmo quadro vai a todos os espectadores do terminal. Movimento do mouse só é repassado com o bastão do operador, até 20 por segundo.

**Segurança (decisão 12b: rede toda liberada; vê e usa quem tem acesso ao projeto).**
- Esquemas: o servidor só aceita `http:`, `https:` e `about:blank` da barra de endereço e das ferramentas. `file:` exporia o disco do servidor a quem não tem shell nele; `chrome:` e `devtools:` mexem no próprio navegador; `javascript:` e `data:` não fazem falta. Um vigia de navegação do quadro principal volta para `about:blank` se cair noutro esquema (exceto a página de erro do próprio Chromium). Link `file:` vindo de página web o Chromium já recusa.
- Downloads bloqueados (`acceptDownloads: false`): nada se grava no disco do servidor por um site qualquer, e o agente tem `curl` no shell. A coluna e a próxima ferramenta mostram "download bloqueado: nome, de URL".
- Controle só pelo pipe; nenhuma porta. O Claudinei em 127.0.0.1 é alcançável, mas o contexto não tem o cookie dele.
- Aviso: na primeira vez que o operador toma o bastão numa aba, uma faixa diz "O agente deste terminal lê o que você digitar aqui, inclusive senhas. Prefira um login de teste." com Entendi (lembrado por navegador). A máscara de senha na snapshot é só redução de dano: captura de tela e outros campos continuam legíveis.

**Servidores locais (`server/src/browser/local-servers.ts`).** Marcador `CLAUDINEI_TERMINAL=<projectId>:<motor>` no ambiente do CLI e de tudo que ele abre. Onde entra:
- Claude: no `env` do spawn (`server/src/claude/session.ts:235`). O Bash do Claude herda o ambiente do CLI: os `CLAUDINEI_*` do serviço aparecem nos comandos desta própria sessão.
- Codex: no `env` do app-server (`codex-rpc.ts:24`) e, por garantia, `-c shell_environment_policy.set.CLAUDINEI_TERMINAL=…` em `buildAppServerArgs` (`codex-args.ts:54`). O `set` vale mesmo com `inherit = "none"` no config do operador, e o filtro padrão (nomes com KEY, SECRET, TOKEN) não pega este nome.
- Kimi (`kimi-session.ts:73`) e OpenCode (`opencode-session.ts:128`): no `env` do spawn. Não confirmei com um turno de verdade (gastaria tokens): é a primeira tarefa do plano, com `echo $CLAUDINEI_TERMINAL` num terminal isolado.
- Também no terminal interativo (`terminal/pty.ts`, `env` aditivo) e na conversa lateral, com o marcador do terminal.

Varredura sob pedido (coluna visível, a cada 5 s; resultado guardado 2 s): `/proc/net/tcp` e `tcp6` em LISTEN, inode → PID por `/proc/<pid>/fd`, e `/proc/<pid>/environ` com o marcador **exato** (não prefixo: `4:claude` ≠ `42:claude`). Dois terminais na mesma pasta não se misturam: o marcador é do terminal, não da pasta. Sem comando externo. Fora da lista: o PID do Claudinei e seus ancestrais, a porta do serviço, os processos de CLI que o Claudinei abriu e o Chromium. Parar relê o marcador e o início do processo (`/proc/<pid>/stat`, contra PID reaproveitado) logo antes; manda SIGTERM ao grupo só se todos os membros tiverem o mesmo marcador, senão só ao PID; SIGKILL depois de 5 s se ainda for o mesmo processo. Rotas: `GET /api/projects/:id/terminals/:engine/servers` e `POST …/servers/:pid/stop`, com `requireProjectAccess`.

## Desenho — web

**Convivência na coluna da direita: uma de cada vez, com abas.** A coluna vira um lugar só, com três vistas: Acompanhamento, Conversa lateral e Navegador. No topo, abas de texto só das vistas que existem (Acompanhamento sempre; Lateral enquanto existir; Navegador enquanto o terminal tiver aba). O `/side` toma a coluna ao nascer, como hoje, e ao fechar volta a vista anterior. O Navegador abre pelo botão novo no cabeçalho do chat ou por **Alt+B** (ação `view.browser` no registro de atalhos, editável). Quando o agente abre o navegador e o operador está naquele terminal, a coluna abre no Navegador se estava fechada ou no Acompanhamento; se a Lateral estiver à vista, só a aba aparece, com uma marca estática.
- **Alargar:** puxador na borda esquerda; largura lembrada por vista (localStorage). Acompanhamento e Lateral: 340 px por padrão. Navegador: metade da área do chat, mínimo 360 px, máximo a área menos 320 px para o chat.
- **Tela cheia:** botão no cabeçalho da coluna; ela cobre a área do chat (a lateral de terminais fica). O mesmo botão volta. Vale para as três vistas. No celular a coluna cobre o chat, como a Lateral hoje.
- O modo Zen continua escondendo só o Acompanhamento; Lateral e Navegador são trabalho, não moldura.

**A vista Navegador (`web/src/components/BrowserColumn.tsx`).** Cabeçalho: barra de endereço, voltar, avançar, recarregar, o selo do comando ("Agente no comando" / "Você no comando — Devolver ao agente" / "Livre"), Anotar, tela cheia e fechar a aba. Embaixo, a faixa de servidores do terminal (":5173 vite — Abrir · Parar"; Abrir navega a aba para `http://127.0.0.1:<porta>`) e a última ação do agente. A tela é **um canvas**: cada quadro binário vira `Blob` → `createImageBitmap` → `drawImage`, e o bitmap anterior é fechado; com uma decodificação em curso, só o último quadro chegado espera. Sem `requestAnimationFrame`, sem transição. A web manda `visible: false` quando a vista sai da aba, a coluna fecha, o documento fica oculto ou a tela sai da vista (`IntersectionObserver`). `resize` sai com 250 ms de espera. Indisponível: o texto do comando de instalação.

**Entrada do operador.** Ponteiro no canvas convertido para px CSS do viewport. O foco do teclado fica num campo invisível sobre a tela, para receber teclas, colar e composição; ali todas as teclas vão à página, exceto o atalho do Navegador (Alt+B). Clicar fora devolve o teclado ao Claudinei. No celular, toque vira clique e arrastar vira rolagem.

**Anotar e mandar.** Anotar pede `freeze`: o servidor responde com um PNG do viewport (mais nítido que o JPEG), e o screencast pausa até sair. Ferramentas: retângulo, seta, texto, recorte, desfazer a última marca; uma cor. "Mandar ao campo" desenha o recorte num canvas, gera PNG (`toBlob`), envia por `uploadFile` (`web/src/api.ts:355`) e chama `requestAppend` (`web/src/branch/sideStore.ts:195`) para a sessão principal, com o texto "Anotação de <URL> (viewport L×A):" e o token do anexo. O operador escreve o resto e manda como quiser.

**Encerrar com servidores de pé.** Ao encerrar a sessão de um terminal ou excluir o projeto pela tela, a web consulta os servidores; havendo algum, pergunta "Este terminal deixou N servidores no ar (:5173 vite, …). Parar também?" com Parar e encerrar, Só encerrar e Cancelar. Encerramento sem o operador (reinício, morte da sessão) não para nada.

## Dados

Nenhuma tabela nova. Aba, bastão, avisos e servidores vivem na memória; reiniciar o serviço fecha tudo (decisão 6a). Na web, localStorage: vista e largura da coluna por vista, "Entendi" do aviso de senha.

## Ordem única do próximo envio

Não entra. O navegador nunca manda mensagem ao agente: diálogo, download bloqueado e bastão devolvido aparecem no resultado da próxima ferramenta. O recorte anotado só vai ao campo; sai como mensagem do operador pelo caminho de sempre (Enter, ou a fila com Alt+Enter, lugar 3).

## Erros e bordas

- Chromium caiu (`disconnected`): todas as abas somem, a coluna mostra "O navegador fechou — Reabrir"; a próxima ferramenta sobe outro. Página travou (`crash`): só aquela aba, com Recarregar.
- Dois usuários olhando o mesmo terminal: os dois veem; quem agir toma o bastão, e o selo mostra o nome.
- Fim do horário de acesso: o WebSocket fecha com 1008; o agente continua usando o navegador (o token de serviço não tem horário) e o bastão volta ao agente depois dos 30 s.
- Sessão parada: a aba continua até ficar ociosa; o operador pode usá-la sozinho.
- Viewport estreito: o agente vê o layout que a coluna mostra (inclusive o de celular); é o preço de ver igual.
- Certificado inválido (https local autoassinado) mostra a página de erro do Chromium. Autenticação HTTP básica e `window.opener` de login por janela não funcionam (janela nova vira a própria aba).
- Servidores invisíveis: dentro de Docker (o `docker-proxy` é do root e sem marcador), de outro usuário (`environ` ilegível), subidos fora do Claudinei, só UDP. Kimi ou OpenCode que filtrem o ambiente: listados pela pasta de trabalho (`/proc/<pid>/cwd` dentro da do projeto), com "sem marcador", só Abrir.
- Processo que sai entre a varredura e o Parar, ou PID reaproveitado: o Parar responde "o processo já não é o mesmo".
- Snapshot gigante: corte em 60 mil caracteres e sugestão de `depth`.

## Testes

- Servidor, unitários (com o `launch` dublê): sob demanda, contador de uso e fechamento ocioso; `withIsolatedPage` fecha o contexto com erro e com tempo estourado, limite de duas; resolução do Chromium (variável, revisão exata, ausente com o texto de instalação); esquemas recusados; bastão (operador toma, ações recusadas, leitura permitida, devolver, 30 s sem coluna); referências vencidas; máscara de senha; download anotado; nenhum `evaluate` com função.
- WebSocket: sem cookie, origem errada, projeto sem acesso, fora do horário (1008), revogação; screencast só com espectador visível; quadro mais recente vence com `bufferedAmount` simulado; ritmo ≤ 10 por segundo.
- Servidores: `/proc` falso em pasta temporária: marcador exato, exclusões (PID próprio, ancestrais, porta, CLIs), reconferência antes do sinal, grupo × PID, SIGKILL depois de 5 s. Marcador nos argumentos e ambientes dos 4 motores, do pty e da lateral.
- Integração com Chromium de verdade (pulada se não instalado): abrir, snapshot, clicar por referência, quadros do screencast, página isolada do contrato.
- Web: canvas desenha e descarta intermediários (`createImageBitmap` dublê), sem laço de quadros; conversão de coordenadas; selo do bastão; Anotar → upload → `requestAppend` com a URL; abas e larguras da coluna, tela cheia; Zen; pergunta ao encerrar com servidores.
- Ensaios: o binário empacotado (`npm run package`, Node 24) numa instância isolada, porta e banco próprios, abrindo uma página e tirando snapshot; um turno curto por motor com `echo $CLAUDINEI_TERMINAL`; num Chrome com `--disable-gpu`, CPU da aba do operador com a coluna aberta numa página densa (meta: até 10% de um núcleo) e zero com a coluna fechada.

## Evidências (ensaios de 21/11, em /tmp, já apagados)

- playwright-core 1.65.1 com chromium_headless_shell-1255 (Chrome 159.0.8154.6): sobe em ~40 ms com `--remote-debugging-pipe` e sem `--remote-debugging-port`; sandbox ligada funciona nesta máquina.
- esbuild + `@yao-pkg/pkg` 6.21, Node 24: bundle com o playwright-core dentro falha; externo pelo `NODE_PATH` roda, depois do desvio do `inspector` e com `evaluate` em string. Snapshot com `[ref=…]`, clique por `aria-ref`, 11 quadros do screencast, página isolada com PNG, altura e console: tudo dentro do binário.
- Link `file:` numa página http não navega; download com `acceptDownloads: false` dispara o evento e não grava; a snapshot mostra o valor de campo de senha (daí a máscara).
- Números do screencast e da memória (levantamento da onda D): texto denso a 10 quadros/s: ~3 MB/s, Chromium 33% de um núcleo; decodificar 4,4 a 5,5 ms por quadro sem GPU; headless_shell ~210 MB, mais 15 a 220 MB por aba.

## Decisões de quem escreveu (o operador confere na leitura)

- Leitura (snapshot, screenshot, console) continua liberada ao agente com o operador no comando: serve para "olha isto".
- O bastão volta sozinho só quando o operador fecha a coluna por 30 s; não há tempo limite com a coluna aberta.
- Aba ociosa fecha em 30 min (perde os cookies); processo fecha 2 min depois da última aba; teto de 8 abas.
- Viewport igual ao tamanho da coluna, em escala 1 (nítido e barato), em vez de um tamanho fixo reduzido.
- Alt+B para abrir e fechar o Navegador; tela cheia e alargar valem para as três vistas da coluna.

## Fora do escopo / depois

Perfil persistente por projeto; iframe por proxy para dev server; gravação de vídeo; `evaluate` e envio de arquivo pelo agente; várias abas; emulação de celular e escolha de viewport pelo agente; ignorar certificado de dev; instalar o Chromium por um botão; listar servidores de Docker.
