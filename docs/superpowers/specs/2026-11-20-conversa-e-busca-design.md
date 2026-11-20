# Conversa virtualizada e busca na conversa — design

Projetos 3 e 7 do roteiro `docs/superpowers/roteiro-ideias-t3code.md`, numa trilha
só: virtualizar a lista tira da página as mensagens fora da tela, e com isso o
Ctrl+F do navegador deixa de alcançá-las — a busca do Claudinei tem de nascer
junto.

## Por quê

A conversa ativa é a parte cara da página (AGENTS.md): numa sessão longa o chat
fica lento, e hoje todas as mensagens carregadas ficam no DOM ao mesmo tempo
(`ChatView.tsx:271-282`), aliviadas só pelo `content-visibility: auto` do
`.chat-entry` (`styles.css:3096`). Ao mesmo tempo, o operador não alcança o
começo de uma conversa longa: o servidor corta o histórico nos 300 últimos
eventos (`HISTORY_EVENT_LIMIT`, `server/src/routes/sessions.ts:11` e `:210`), e
o que ficou para trás não aparece nem é encontrável. O Ctrl+F do navegador só
procura no que está na página.

## Objetivos

1. Só as mensagens perto da tela existem na página; rolar continua liso, sem GPU.
2. Rolar para cima carrega as mensagens mais antigas aos poucos, até o começo da
   conversa (fim do teto de 300 para exibição).
3. Buscar na conversa inteira do terminal (Ctrl+F): a busca roda no servidor,
   leva até a ocorrência carregando o trecho necessário e abre a dobra onde ela
   está.
4. O estado aberto/fechado ("▾ mostrar tudo", grupos de ações, cartão de
   ferramenta, resumo da compactação) sobrevive à mensagem sair e voltar à tela.

## Não-objetivos

- Buscar em conversas anteriores do terminal ou em todos os terminais (um "Ctrl+K"
  global): projeto à parte.
- Mudar o desenho das mensagens, o agrupamento de ações (`chat/grouping.ts`) ou o
  `StreamingPreview`.
- Virtualizar a lateral ou outras listas.

## Anti-objetivos

- Pular ou tremer: abrir uma dobra, chegar texto novo ou carregar antigas não pode
  arrancar o operador do ponto em que está lendo.
- Perder o "grudado no fim": enquanto o agente responde e o operador está no fim,
  a tela segue o texto como hoje (`scrollFollow.ts`, folga de 80 px).
- Reconstruir a lista inteira a cada fim de turno (hoje o refetch do histórico
  troca todos os objetos e re-renderiza todos os blocos, `ChatView.tsx:87-119`).
- Repetir o erro do `content-visibility` trocado no foco, que derrubava a aba do
  Chrome (`chat-entry-visibility.test.ts`).
- Ler conteúdo de mensagens fora do que a busca pediu, ou mandá-lo a terceiros.

## Abordagens consideradas

1. **react-virtuoso + histórico paginado + busca no servidor (escolhida).** A
   biblioteca já trata alturas variáveis que mudam depois de desenhar (blocos de
   código, diffs, grupos que abrem), seguir o fim e acrescentar itens no topo sem
   pular. O servidor serve o histórico em páginas e procura no histórico inteiro.
2. Virtualização própria (IntersectionObserver / janelas manuais). Sem
   dependência nova, mas frágil exatamente nos pontos acima (alturas que mudam,
   âncora ao acrescentar no topo). Descartada.
3. Manter tudo no DOM e só tirar o teto de 300. Resolve o alcance, piora o peso —
   o oposto do pedido. Descartada.

## Como (decidido com o operador)

### Identidade estável das mensagens

Cada evento do histórico passa a ter um **ordinal**: sua posição na conversa
inteira, contada do começo (o histórico das engines só cresce no fim). O
`readHistory` de cada engine continua igual; a rota numera o resultado. Eventos ao
vivo que chegam por WebSocket recebem o ordinal seguinte ao último conhecido; ao
reler o histórico depois do turno, os ordinais casam e só o que mudou é trocado
(nada de reconstruir a lista). As chaves do React passam a ser o ordinal (e, nos
grupos, o ordinal do primeiro item), não a posição na lista.

### Histórico em páginas

- `GET /api/sessions/:localId/history` aceita `?before=<ordinal>&limit=<n>` e
  devolve `{ events, firstOrdinal, total }`. Sem parâmetros, devolve o fim (os
  últimos ~300, como hoje) — compatível com quem já chama.
- Rolar até perto do topo pede a página anterior; a lista acrescenta no topo
  mantendo o ponto de leitura. No começo da conversa, um marcador "início da
  conversa".
- O store passa a guardar as páginas carregadas por sessão; o que já foi carregado
  não é pedido de novo enquanto a sessão não mudar.

### Lista virtual

- `ChatView` troca o `map` sobre todos os nós por `react-virtuoso` com
  `followOutput` ligado só quando o operador está no fim (mesma regra de hoje) e
  `firstItemIndex` para acrescentar no topo. O `StreamingPreview` vai no rodapé da
  lista. O botão "ir para o fim" (`chat-tofoot`) continua.
- O `.chat-entry` mantém `content-visibility: auto` só se não brigar com a medição
  da biblioteca; se brigar, sai — mas nenhuma regra volta a trocá-lo por foco ou
  hover (o teste-guarda continua valendo).

### Estado aberto/fechado

Sai do `useState` local de `MessageBlock` (`:47`, `:158`, `:193`, `:280`, `:316`),
`ActionGroup` (`:18`) e `ToolCallCard` (`:30`) para o store, chaveado por sessão +
ordinal, com seletor estreito (o padrão `useShallow` do projeto) para abrir uma
dobra não re-renderizar as outras.

### Busca (Ctrl+F)

- **Abrir:** Ctrl+F abre a barra de busca do Claudinei quando o foco está no chat
  ou em nada (regra `isForeignField` de `web/src/keyboard.ts`: em outro campo de
  texto, não intercepta). Com a barra já aberta, um novo Ctrl+F não é interceptado
  e cai na busca do navegador. Esc fecha.
- **Onde procura:** na conversa inteira do terminal, no servidor:
  `GET /api/sessions/:localId/search?q=&tools=0|1` devolve as ocorrências como
  `{ ordinal, field, start, end }` em ordem, até um teto (por exemplo 500), com o
  total.
- **O que olha (decidido pelo operador):** por padrão o texto das mensagens —
  operador, respostas do agente, cartões de tarefa, de agendamento e do Claudinei.
  Com "incluir ferramentas" ligado, também entradas e saídas das ferramentas.
- **Navegar:** "3 de 27", setas ↑/↓ (Enter / Shift+Enter). Ir a uma ocorrência
  carrega as páginas até ela, rola até a mensagem, **abre a dobra** onde o texto
  está (grupo de ações, "mostrar tudo", cartão de ferramenta) e destaca a
  ocorrência. Só as mensagens visíveis são pintadas.
- **Sem distinção de maiúsculas e acentos** por padrão ("reinicio" acha
  "reinício").

## Decisões de quem escreveu (o operador confere na leitura)

- O ordinal é a posição no histórico completo da engine; numa conversa compactada
  ele continua crescendo (a compactação não reescreve o arquivo).
- Página de 200 eventos ao subir; a primeira carga continua com ~300.
- Teto de 500 ocorrências por busca; acima disso, "500+ — refine a busca".
- A busca não guarda índice: lê o histórico da sessão a cada pedido (uma conversa
  cabe em segundos de leitura no pior caso); se ficar lento em conversas gigantes,
  vira projeto de índice depois.
- A barra de busca fica no topo da coluna do chat, sem animação.
- Mensagem de subagente conta como texto da mensagem (aparece na conversa).

## Verificação

- Servidor: paginação (`before`/`limit`, ordinais, compatibilidade sem
  parâmetros); busca (texto vs. ferramentas, acentos, teto, ordinal/posição certos)
  em históricos sintéticos das quatro engines.
- Web: a lista virtual monta só o que está perto da tela (contagem de nós num
  histórico de milhares de itens); grudar no fim durante o streaming; acrescentar
  no topo sem pular; o refetch do fim de turno não re-renderiza blocos que não
  mudaram (teste de Profiler no padrão de `perf-render.test.tsx`); dobra aberta
  sobrevive a sair e voltar da tela; Ctrl+F respeita campos de texto e o segundo
  Ctrl+F cai no navegador; ir à ocorrência abre a dobra certa.
- Ensaio numa instância isolada com uma conversa longa real (milhares de eventos):
  rolagem até o começo, busca de um termo do início, e medição de nós no DOM e de
  tempo de quadro sem GPU, comparando com antes.

## Deixado para quem constrói

- A versão do react-virtuoso e como acomodar o `content-visibility`.
- O formato exato de destaque da ocorrência e as chaves de i18n (pt-BR, en, es).
- Como numerar eventos ao vivo antes de o histórico confirmar (desde que casem
  depois sem reconstruir a lista).
