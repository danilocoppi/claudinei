# Respostas visuais — design

Projeto 15 do roteiro `docs/superpowers/roteiro-ideias-t3code.md`, inspirado no `html_render` e no
`html_preview` do T3 Code. O agente responde com uma página HTML que aparece na conversa, isolada do
Claudinei. A conferência usa o navegador sem tela do projeto 16 (contrato da onda D).

## Por quê

- Gráfico, tabela, protótipo de tela e diagrama leem melhor desenhados. Hoje o agente grava um
  `.html` e o operador o abre no visualizador de arquivos, fora da conversa.
- A chamada de ferramenta não serve de registro: o nome muda por motor, e no Codex a chamada ao
  Hermes vem dentro de um `exec` em JS e não volta no histórico (`rollout.ts:144`). Quem guarda a
  página tem de ser o servidor.
- O agente não vê o que desenhou. Uma página quebrada só aparece quando o operador a abre.

## Objetivos

1. `show_page` no Hermes: o agente manda o HTML ou o caminho de um `.html`. O Claudinei guarda uma
   cópia, com as imagens locais embutidas, e devolve um id.
2. Cartão próprio na conversa (quatro motores, ao vivo e no histórico), com tela cheia e nova aba.
3. Leveza sem GPU: só a página recém-chegada carrega sozinha, e só uma fica viva por vez.
4. Um iframe isolado. Por padrão, a página só alcança algumas CDNs para script, estilo, fonte e
   imagem. O admin pode liberar a rede geral.
5. `check_page` no Hermes: imagem, altura e console da página, para o agente conferir antes.

## Não-objetivos e anti-objetivos

- MCP Apps de terceiros (ver "Depois"). Editar ou apagar uma página isolada pela tela.
- A página falar com o agente ou com o Claudinei (sem formulário, ponte de volta nem, por padrão,
  `fetch`) ou alcançar a sessão, o storage e a API do Claudinei.
- Iframe carregando sozinho no histórico, ou várias páginas animando juntas (AGENTS.md).
- Inflar as instructions do Hermes (4096 caracteres): tudo vai na descrição das ferramentas.
- Mensagem antiga mudar porque o arquivo de origem mudou ou sumiu.

## Desenho

### Ferramentas do Hermes (`server/src/hermes/run-hermes.ts`)

Os nomes `show_page` e `check_page` têm verbo claro e o mesmo substantivo. Ficam adiadas no Claude,
como as demais do Hermes, sem `alwaysLoad`. O nome basta para o agente achá-las.

**`show_page({ html?, path?, title, height? })`**
- **Entrada.** Exatamente um destes: `html`, com até 524.288 caracteres; `path`, um `.html` ou
  `.htm` dentro da pasta do projeto, absoluto ou relativo a ela. Também recebe `title` (1 a 120
  caracteres) e `height`, a altura sugerida (opcional, de 120 a 2000 px). Faz POST em
  `/api/hermes/pages` com `projectId` e `engine`, como o `goal_done`.
- **Resposta.** `page shown to the operator (id pg_…, 34 KB)`, mais os avisos (por exemplo, `2 local
  references not embedded: img/a.png`). Uma recusa volta com `isError` e o motivo.
- **Descrição (em inglês).** Diz quando usar: o operador pediu algo visual, ou a resposta lê melhor
  desenhada. Diz também que: a página roda isolada, sem formulário nem `fetch`; só valem as CDNs da
  lista (o Tailwind vem por `cdn.jsdelivr.net/npm/@tailwindcss/browser@4`); o que é local entra
  embutido, com teto de 512 KB; vale gravar o arquivo e passar `path` quando a página é grande ou
  vai mudar; a chamada não espera o operador; página com script ou layout complexo merece um
  `check_page` antes.

**`check_page({ html?, path?, width? })`**
- **Entrada.** O mesmo `html` ou `path`, e `width` (de 360 a 1920, padrão 1024). Nada é guardado nem
  mostrado ao operador.
- **Montagem.** O documento sai como seria publicado: recursos embutidos, script de altura e a
  política de rede atual, num `<meta http-equiv="Content-Security-Policy">` no início do `<head>`. O
  meta não aceita `sandbox`; esse papel fica com o contexto descartável.
- **Execução.** `BrowserHost.withIsolatedPage({ viewport: { width, height: 800 }, offline: false
  })`, do 16 (`server/src/browser/host.ts`), com `setContent`. Espera o `load` mais 1,5 s, com teto
  de 15 s. Se estourar, captura assim mesmo e avisa.
- **Resposta.** PNG da página inteira (cortado em 2000 px), altura do conteúdo, até 50 linhas de
  console (erros primeiro, inclusive bloqueios de CSP) e o caminho de uma cópia do PNG em
  `os.tmpdir()/claudinei-check/`, apagada em 30 min, para o motor que descartar imagem vinda de MCP
  (o plano confere quais a mostram).
- **Limites.** Até 2 conferências simultâneas; a terceira espera 30 s e volta "busy, try again".
  Navegador ausente ou com falha dá `isError` com o texto do host.

### Servidor: publicar (`server/src/pages/`, novo)

- **Rota e terminal.** `POST /api/hermes/pages`, com token de serviço e `bodyLimit` de 2 MiB. O
  Hermes só conhece projeto + motor. O servidor pega a sessão viva desse terminal: `localId` e
  `engineSessionId`, que é a conversa. Sem sessão viva, recusa. O turno aberto vem de
  `tracker.openSegment(localId)` (`undo/tracker.ts:583`), com a `text_key` de `undo_turns`.
- **Embutir.** O servidor procura recursos locais em `img[src]`, `link[rel=stylesheet][href]`,
  `script[src]` e `url(...)` (em `<style>`, `style=` e CSS embutido), a partir da pasta do `.html`
  (com `path`) ou da raiz do projeto (com `html`). Só entra o que, depois do `realpath`, fica dentro
  da raiz do projeto (`files/scope.ts`): outros usuários do projeto veem a página, e um caminho de
  fora vazaria para eles. Imagem e fonte viram `data:` (MIME de `PREVIEW_MIME`,
  `routes/files.ts:28`), CSS vira `<style>` e JS vira `<script>`. O que faltar ou ficar fora segue
  como está e vira aviso. A busca é por expressão regular, sem parser de HTML.
- **Teto e gravação.** O teto é de 512 KB (524.288 bytes UTF-8) no documento final. Acima disso,
  recusa e cita os três maiores recursos. A gravação é atômica, em `~/.claudinei/pages/<id>.html`
  (`config.pagesDir`, `CLAUDINEI_PAGES`). Depois entra a linha em `visual_pages`. Por fim, o
  broadcast `{ type: 'visual_page', projectId, engine, localId, page }`. O filtro do WebSocket
  (`routes/ws.ts:39`) já entrega só a quem acessa o projeto.

### Servidor: mostrar

- **Listar.** `GET /api/sessions/:localId/pages` devolve, em ordem de criação, as páginas da conversa
  (por `conversation_id`, ou `local_id` se não havia id). Exige acesso ao projeto.
- **Abrir.** `POST /api/pages/:id/view` exige cookie e acesso e devolve `{ url }` com token novo, de
  uma instância própria de `createPreviewStore` (`files/preview.ts`) cuja raiz é o arquivo da página:
  32 bytes, 10 min, preso ao endereço de quem pediu e revalidado por `req.accessAllowed`.
- **Servir.** `GET /api/pages/view/:token/:id.html` é pública, porque o token autoriza. Serve só
  aquele documento; qualquer outro caminho dá 404. Injeta o script de altura no fim do `<body>`,
  como o `formBridgeScript` (`routes/files.ts:337`). Cabeçalhos: `X-Frame-Options: SAMEORIGIN`,
  `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` sem
  câmera, microfone, geolocalização e captura de tela, e a CSP montada a cada pedido.
- **CSP padrão.** `sandbox allow-scripts; default-src 'none'`, mais: `script-src 'unsafe-inline'
  'unsafe-eval' <CDN>`; `style-src 'unsafe-inline' <CDN> https://fonts.googleapis.com`; `font-src
  data: <CDN> https://fonts.gstatic.com`; `img-src data: blob: <CDN>`; `media-src data: blob:`;
  `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`. `<CDN>` =
  `https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com`.
- **Por que estas CDNs.** As três hospedam quase toda biblioteca de npm que um agente usa (Chart.js,
  D3, Mermaid, Tailwind 4, Alpine, highlight.js), como arquivo estático por URL. O dono de um pacote
  não vê quem pediu. Google Fonts entra só para estilo e fonte. `cdn.tailwindcss.com` fica de fora:
  o jsdelivr já tem o Tailwind 4 para navegador. O token só abre aquela página, sem pasta nem
  subrecurso, dura 10 min e fica preso ao cliente. A CDN não amplia o que um vazamento alcança.
- **CSP com a rede liberada.** `sandbox allow-scripts; default-src * data: blob: 'unsafe-inline'
  'unsafe-eval'; connect-src *; form-action 'none'; base-uri 'none'`. Continuam fora
  `allow-same-origin`, `allow-forms`, `allow-popups` e `allow-top-navigation`.
- **`Origin: null` recusado, sempre.** É a origem de toda página em sandbox. Pedido a `/api/*` ou
  `/ws` com essa origem volta 403, no gancho de `auth/plugin.ts`. Sem isso, com a rede aberta, uma
  página aberta no próprio servidor alcançaria `127.0.0.1` sem credencial no pré-setup
  (`auth/plugin.ts:205`). A interface e o Hermes nunca mandam essa origem.

### Configuração "liberar a rede" (admin, global)

- **Chave.** `visualPagesNetwork` em `settings`, `'cdn'` (padrão) ou `'open'`. Todos leem por
  `GET /api/visual-pages/settings`; só o admin altera, pelo `PUT`, como no auto-compact
  (`routes/sessions.ts:143`). É global, e não por usuário, porque a política vale para quem abre a
  página, inclusive quem não escolheu nada, e a página roda a partir do servidor, na rede dele.
- **Na tela.** Item "Páginas visuais" no menu do usuário, só para admin, com a opção e o aviso:
  > Com a rede liberada, o código de qualquer página visual pode mandar o que estiver nela
  > (inclusive dados do projeto que o agente pôs ali) para qualquer endereço da internet, carregar
  > código de qualquer site e tentar alcançar outros aparelhos da rede de quem a abrir. A página
  > continua sem acesso à sua sessão e à API do Claudinei. Vale para todas as páginas, de todos
  > os terminais e usuários, a partir da próxima vez que forem abertas.

### Web: o cartão (`web/src/components/PageCard.tsx`, novo)

- **Âncora 1: a chamada.** As páginas vêm da listagem, junto com o histórico, e do evento
  `visual_page`, num store por `localId`. Um `tool_call` cujo resultado traz o id de uma delas vira
  o cartão, no lugar dele. O id vem no texto, no Claude, no Kimi e no OpenCode, e no JSON do
  `mcpToolCall`, no Codex. Casa pelo id (`pg_` + 16 caracteres) e por um nome terminado em
  `show_page`, com qualquer prefixo de motor. Um `exec` do Codex que imprima o id não some.
  `grouping.ts` não dobra essas chamadas no grupo de ações.
- **Âncora 2: o turno.** Sem chamada visível (Codex aninhado ou histórico do Codex), o cartão vai ao
  fim do bloco do turno. O lugar vem de `attachTurns` (`undo/attachTurns.ts`) sobre pseudo-turnos de
  `turn_id`/`turn_key`. O desenho é o de `turnLines` (`ChatView.tsx:254`).
- **Sem âncora** (terminal interativo, turno sem texto, página antiga não carregada): a página fica
  em "Páginas desta conversa (n)", item novo do menu do terminal, com abrir, tela cheia e nova aba.
- **Estados.** Parado: linha estática com título, tamanho e "Ver página". Vivo: iframe com
  `sandbox="allow-scripts"`, `referrerPolicy="no-referrer"` e nenhum `allow`. Nunca `srcdoc`, que
  herdaria a CSP do app. Erro: "Página apagada" ou "Não carregou — tentar de novo". Sem
  `backdrop-filter`, sombra animada ou miniatura.
- **Altura.** Começa na sugerida (ou 360 px). O script injetado mede com `ResizeObserver` e avisa
  por `postMessage`, no máximo a cada 200 ms e só quando muda 4 px ou mais. O cartão só aceita a
  mensagem do próprio iframe (`event.source`). O limite vai de 120 px a 70% da janela; acima disso,
  a página rola por dentro.
- **Uma viva por vez.** O store guarda `livePageId`. Abrir outra página, por clique ou chegada,
  devolve a anterior à linha estática. Um `IntersectionObserver` (como em `indicatorMotion.ts`)
  desmonta o iframe que sai da tela. Assim, a margem de 600 px da lista virtual não mantém página
  viva. Na volta à tela, a página recarrega só se ainda for a viva. Trocar de terminal descarrega.
- **Carregar sozinho.** Só na chegada do `visual_page` do terminal aberto nesta aba (vira a viva; o
  chat segue no fim se já estava). No histórico, nada carrega sem clique.
- **Tela cheia e nova aba.** A tela cheia é o diálogo quase tela cheia do `FileViewerModal`, com
  token novo, e o cartão descarrega. A nova aba usa `window.open(url, '_blank',
  'noopener,noreferrer')` com token novo; o `sandbox` do cabeçalho mantém a origem opaca. Depois de
  10 min, recarregar dá 404, com texto pedindo para reabrir pelo Claudinei. Textos em pt-BR, en e es.

### Dados e retenção

- **Tabela `visual_pages`.** Colunas `id TEXT PK`, `project_id` (FK `ON DELETE CASCADE`), `engine`,
  `local_id`, `conversation_id`, `turn_id`, `turn_key`, `title`, `height`, `bytes`, `source`
  (`html`/`path`), `source_path` e `created_at`. Índice em `(project_id, engine, conversation_id)`.
- **A página sai junto com o que a contém.** Terminal excluído: o `DELETE /api/projects/:id` apaga
  os arquivos, e a cascata, as linhas. Turno cortado por "Editar a partir daqui": quando o desfazer
  marca `rewound_at` (`undo/store.ts:193`), saem as páginas daquele `turn_id`. "Apagar conversa" o
  Claudinei ainda não tem; quando tiver, `conversation_id` basta. Sem prazo por idade. Na subida,
  uma varredura apaga arquivo sem linha e linha sem arquivo.

## Ordem única do próximo envio

Não entra. Nada aqui manda mensagem ao agente. `show_page` e `check_page` respondem no próprio
turno, como resultado de ferramenta, e a página não fala com o agente.

## Erros e bordas

- **Entrada inválida.** `html` e `path` juntos ou ausentes, caminho fora do projeto, extensão
  errada, arquivo inexistente ou acima do teto: recusa legível, nada gravado.
- **Sem acesso ao terminal.** O evento não chega, listagem e `view` dão 403, e token alheio dá 404.
  Admin vê tudo. Sem autenticação, vale o de hoje.
- **Quem publica.** Subagente do Claude publica no terminal, pelas mesmas âncoras. A conversa
  lateral (`branch/side.ts`) sobe sem Hermes e não publica.
- **Fora da vista.** Com o operador em outro terminal, a página chega estática e não carrega sozinha
  na volta. Configuração trocada vale na próxima abertura.
- **Navegação para fora.** A página pode navegar o próprio iframe para fora com dados na URL, e
  nenhuma CSP impede (`files/preview.ts:22`). Aceito: o agente já tem rede pelo shell, e o que se
  protege é a sessão e a API.

## Testes

- **Servidor.** Publicação: `html` e `path`, embutindo imagem, CSS, JS e `url()`. Avisos: recurso
  fora ou ausente. Recusas: teto depois de embutir, `html`/`path` exclusivos e falta de sessão viva.
  Gravação: turno aberto. Acesso: broadcast filtrado, listagem por conversa e `view` com 403. Token:
  preso ao cliente, expirado e revogado. Exibição: CSP das duas políticas e script de altura.
  Barreiras: `Origin: null` com 403 e `PUT` só do admin. Retenção: exclusão do terminal,
  `rewound_at` e varredura.
- **Hermes.** Esquemas, erros, resultado com o id; `check_page` contra um dublê do `BrowserHost`
  (meta CSP, corte em 2000 px, teto de 15 s, 2 simultâneas, cópia temporária, sem navegador).
- **Web.** Âncora pela chamada (quatro motores, fora do grupo), âncora pelo turno, e só o menu
  quando não há âncora. Uma viva por vez, com carga automática só no evento ao vivo e descarga fora
  da tela (observer dublado). Altura limitada, com mensagem alheia ignorada. Token novo para tela
  cheia e nova aba. Diálogo do admin com o aviso.
- **Ensaio.** Instância isolada (porta e banco próprios, nunca a 9105), CLI falso chamando
  `show_page` com um `<canvas>` animado: rolar até a página sair, conferir no DOM que o iframe saiu
  e, no Chrome com `--disable-gpu`, comparar a CPU com a página viva e fora da tela.
- **Plano.** `check_page` é a última tarefa e espera o sha do host do 16.

## Fora do escopo / depois

- MCP Apps de terceiros (`io.modelcontextprotocol/ui`): projeto à parte, a começar pelo Codex.
- Tema e atalhos passados à página por `postMessage`; `allow-forms`; bibliotecas fixas servidas
  pelo próprio Claudinei no lugar de CDN; apagar uma página pela tela; teto de disco por terminal.
- Páginas na conversa copiada (`/fork`, outro `conversation_id`); PNG do `check_page` como miniatura.
