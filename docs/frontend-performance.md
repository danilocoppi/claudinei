# Desempenho do chat

## Estado atual

O usuário pediu depois: "Quero voltar os rostinhos, mas precisamos fazer uma
optimizacao". A restauração está instalada e validada: rostos visíveis na
lista e na régua, arte e movimentos originais,
amostragem nativa a aproximadamente 20 quadros/s e pausa fora da tela.
A instalação validada para essa restauração é `144f901f`. O usuário autorizou
a instalação e um reinício com "Agora pode", após revisar os resultados.
O resultado da operação confirmou saúde, HTTPS e assets servidos iguais ao
build (`.superpowers/deployment-144f901f/result.json`). O usuário confirmou
depois: "pronto agora esta tudo certo!". Essa autorização de reinício já foi
consumida e não vale para reinícios posteriores.

### Restauração otimizada dos rostos — 2026-09-06

Reexibir os rostos com o controlador de 20 quadros/s, sozinho, ainda elevava
o custo com vidro ligado. No cenário reproduzido, quatro rostos (dois
dormindo, um trabalhando e um iniciando) somam 22 animações internas, além
das quatro do chat. O custo alto não era proporcional à área dos desenhos.

O isolamento apontou o `backdrop-filter` da lateral inteira. Remover as
sombras/filtros dos personagens, usar um relógio compartilhado, conter a
pintura ou separar o desfoque num pseudo-elemento não resolveu esse cenário.
Os protótipos ficam em `/tmp/claudinei-faces-return`; não entram no produto.

A lateral agora conserva `background: var(--surface)` sem filtrar a superfície
inteira. No desktop ela acompanha o fundo estático da página; no mobile sua
base já é opaca. A transparência e os filtros dos cartões e overlays continuam
disponíveis. Remover esse filtro pode alterar discretamente o acabamento do
fundo e a composição dos cartões translúcidos; não altera as cores, formas,
adereços nem movimentos dos rostos. O badge do ícone na régua também volta à
posição original. Não há renderer de canvas, imagens geradas ou dependência
nova no frontend.

Comparação controlada com Chrome 153 em Linux e composição por software,
mesmo histórico e viewport de 1610 × 1036. Tempos em ms de CPU somados dos
processos renderer e GPU, em duas amostras de aproximadamente seis segundos.
O controle reexibe os rostos no build `13c51cf6`, já com amostragem a 20 Hz;
a coluna otimizada usa o novo build com a lateral sem backdrop-filter.

| Cenário | Reexibir sem o novo ajuste | Restauração otimizada |
| --- | ---: | ---: |
| Trabalhando, vidro desligado | 2.090 / 2.180 | 2.630 / 2.270 |
| Idle, vidro desligado | 970 / 1.030 | 1.130 / 1.200 |
| Trabalhando, vidro ligado | 7.300 / 6.450 | 2.860 / 3.080 |
| Compactando, vidro ligado | 4.770 / 5.150 | 1.880 / 2.710 |

Com vidro ligado, a média caiu 56,8% trabalhando e 53,7% compactando. Com vidro
desligado, não houve melhora: o filtro já estava ausente, e as amostras ficaram
mais altas nesta rodada. São medições do servidor de teste, com variação entre
amostras; não são porcentagens do processador inteiro nem medem o computador
do usuário. Reativar os rostos continua tendo custo adicional em relação a
deixá-los ocultos.

O teste nativo usa o componente real nos oito estados e tamanhos de 20/22 px:
16 rostos da lateral visíveis, 100 animações e 572 valores de poses comparados
à interpolação original (maior diferença numérica: 0,0003). Verifica também
ausência de loop JavaScript por quadro, pausa/retomada, movimento reduzido,
mudanças de estado, tema/tamanho e cleanup.
Também passaram 90 testes de componentes/layout, incluindo rostos, régua,
recolhimento, redimensionamento, aparência e navegação mobile.
O pacote `144f901f` foi gerado e executado isoladamente: saúde, index e dois
assets principais conferidos byte a byte; rostos presentes e lateral sem
backdrop-filter confirmados no CSS empacotado. A instalação autorizada é
registrada separadamente no relatório de deployment acima.

O profiler aceita `--sidebar-faces show` para repetir o controle num build
que oculta os rostos; `as-built` mede a configuração do próprio build. Os
dados e o estado do pacote ficam em `.superpowers/review-faces-return/`.

### Histórico da retirada temporária

O requisito atual é desempenho aceitável **sem aceleração por GPU**, como
propriedade do frontend. Ativar a GPU no computador do usuário não é a solução
aceita. A implementação descrita em "Orçamento das animações" aplica-se a todos
os clientes, independentemente do backend gráfico.

Depois da restauração das animações e do diagnóstico abaixo, o usuário
solicitou um teste retirando **somente os rostinhos antes dos ícones dos
terminais na lateral**. O CSS agora os oculta também na régua recolhida;
`display: none` encerra as animações desses descendentes. Os ícones, o vidro,
os sinais de status, o sonar e os pontinhos do chat mantêm suas regras.

O pacote foi instalado e o serviço reiniciado com autorização do usuário.
A verificação confirmou saúde, HTTPS e assets do build
(`.superpowers/deployment-673b023a/result.json`). Depois de comparar no próprio
Chrome, o usuário confirmou: "Realmente eram os rostinhos!". Isso identifica
os rostinhos como gatilho do consumo excessivo naquele ambiente, mantendo
vidro e demais animações. A configuração atual permanece sem os rostinhos.
O relatório posterior confirmou composição por software no computador do
usuário, após falhas do processo gráfico (detalhes abaixo).

O relato posterior limita essa conclusão: a conversa ativa ainda fica pesada,
inclusive após terminar a compactação, enquanto outro terminal idle fica leve.
Retirar os rostos reduziu um gatilho; não demonstrou que eram a causa única nem
que a lentidão estava resolvida.

No mesmo cenário de quatro projetos e uma sessão trabalhando, duas medições
de seis segundos por build deram 6.070/6.060 ms de CPU gráfica antes e
2.400/1.570 ms depois. O navegador confirmou quatro animações restantes
(pulse e três typing-bounce), quatro ícones e desfoque de 14 px preservados.
O backend é software; estes valores não medem o computador do usuário.
Dados e validações em `.superpowers/review-no-sidebar-faces/`.

As otimizações de assinaturas do store, streaming, rolagem e conteúdo fora da
tela continuam aplicadas. A preferência de preservar as animações originais
continua válida; ocultar apenas os rostinhos é a exceção de diagnóstico
explicitamente solicitada pelo usuário.

## Orçamento das animações — 2026-09-06

`web/src/indicatorMotion.ts` mantém a anatomia HTML/CSS e os keyframes dos
indicadores, mas amostra a interpolação nativa com alvo de 20 quadros/s. O
navegador calcula as poses durante a preparação; depois reproduz os keyframes
amostrados sem um loop JavaScript por quadro. Duração, atrasos, curvas de
movimento, cores e estados continuam vindo do CSS. O limite é por animação,
não uma promessa de limitar todos os quadros da página ou o streaming a 20 Hz.

O controlador cobre pulse, ping, sonar, typing-bounce, act-pulse e os movimentos
face-*. Elementos fora da região visível são pausados por IntersectionObserver;
retornar à região visível retoma o movimento. Página oculta e movimento
reduzido continuam sendo respeitados. Trocas de tema/tamanho refazem as poses
a partir dos keyframes CSS com variáveis, evitando congelar cores ou medidas
resolvidas do tema anterior. O cleanup restaura os keyframes e remove os
observadores/listeners. O modo idle não mantém um timer de animação próprio.

A faixa transitória de compactação conserva preenchimento translúcido, borda
e spinner, mas dispensa seu backdrop-filter de 8 px. Ela ocupa uma linha sobre
o fundo do chat; filtrar esse fundo aumentava o custo a cada quadro. Os demais
controles de vidro continuam disponíveis. A correção de `data-glass` também
está incluída, para aplicar a preferência salva corretamente.

Foram comparados relógio JavaScript, canvas por quadro, APNG e keyframes
nativos amostrados. Os protótipos ficam apenas em `/tmp/claudinei-motion-budget`.
A versão escolhida conserva o desenho existente e não acrescenta geração de
bitmaps, dependências ou um loop JavaScript à reprodução. Os rostinhos da
lateral continuam ocultos conforme a configuração autorizada.

### Validação funcional

76 testes selecionados passaram. O teste nativo
`scripts/verify-indicator-motion.mjs` comparou 92 valores de poses em 14
animações com a interpolação original; maior diferença numérica: 0,00023.
Verificou também ausência de loop JavaScript por quadro, pausa/retomada fora
da tela e com a página oculta, movimento reduzido do sistema/aplicação,
mudanças de estado, tema e tamanho, além do cleanup. Usa uma página sintética
sem conversas e Playwright opcional:

```sh
PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs \
CHROMIUM_PATH=/caminho/chrome \
node scripts/verify-indicator-motion.mjs /tmp/validacao-movimento.json
```

O pacote foi gerado e executado isoladamente: saúde, index e dois assets
principais conferidos byte a byte com o build. O usuário autorizou o reinício
ao concluir esta otimização: "assim q terminar o q vc esta fazendo pode
reiniciar o servico". Essa autorização vale para esta instalação.

### Comparação final sem GPU

Mesmo histórico e viewport de 1610 × 1036, Chrome for Testing 153 em Linux,
composição por software. Cada célula contém duas amostras de aproximadamente
seis segundos: soma do tempo de CPU dos processos renderer e GPU, em ms.
O "antes" é o frontend instalado no pacote `673b023a`; o "depois" é o pacote
validado `13c51cf6`.

| Cenário | Antes (ms) | Depois (ms) | Redução da média |
| --- | ---: | ---: | ---: |
| Trabalhando, vidro desligado | 4.470 / 4.550 | 1.040 / 960 | 77,8% |
| Compactando, vidro desligado | 5.210 / 4.780 | 1.040 / 1.550 | 74,1% |
| Trabalhando, vidro ligado | 4.990 / 2.100 | 1.120 / 1.160 | 67,8% |
| Compactando, vidro ligado | 4.530 / 4.230 | 1.110 / 1.310 | 72,4% |

Houve variação entre as amostras; esses valores não são um teto de consumo nem
medem o computador do usuário. Todos os cenários conservaram os indicadores
ativos esperados (quatro trabalhando, dois compactando), agora amostrados.
Dados e verificações: `.superpowers/review-software-motion/validation.json`.
O resultado da instalação autorizada será registrado separadamente em
`.superpowers/deployment-13c51cf6/result.json`.

## Conversa ativa e preferência de vidro — 2026-09-06

A captura GET posterior usa o frontend instalado, quatro sessões (uma
trabalhando), 123 eventos / 189.795 bytes de histórico e a preferência real
`glass: off`. O mesmo histórico foi reproduzido em idle, working e compacting,
sem eventos WebSocket após o snapshot. Só o estado ou o indicador explicitamente
selecionado muda nos controles. As fixtures permanecem privadas em
`/tmp/claudinei-active-indicators/`.

| Controle, sem rostinhos | CPU gráfica em aproximadamente 6 s |
| --- | ---: |
| Mesmo histórico em idle | 0 ms |
| Trabalhando, bolinha e três pontinhos | 2.090 ms |
| Trabalhando, só bolinha pausada | 540 ms |
| Trabalhando, só pontinhos pausados | 420 ms |
| Trabalhando, ambos pausados | 10 ms |
| Compactando, bolinha e spinner | 5.140 ms |
| Compactando, só spinner pausado | 460 ms |
| Compactando, só bolinha pausada | 1.870 ms |
| Compactando, ambos pausados, relógio continua | 50 ms |

Estas são amostras individuais de isolamento, não percentuais do computador
do usuário. Trabalhando, não houve mutações ou rolagem; compactando, ocorreram
seis mudanças de texto do relógio, sem rolagem. A reprodução identifica custo
de desenho com os indicadores ativos, sem loop de mensagens ou de layout.

Foi encontrado um defeito verificável na preferência: `applyAppearance`
atualizava `--glass-blur`, mas não `data-glass`. Assim, escolher "desligado"
deixava `blur(0px)` na lateral e no cartão de uso e ainda `blur(8px)` no
cabeçalho da compactação. As regras `[data-glass="off"]` não eram ativadas.
O código agora propaga a preferência normalizada para o atributo, inclusive
ao carregar preferências/cache, no preview e ao cancelar/restaurar.

O harness anterior escrevia esse atributo diretamente nos controles de vidro;
por isso validava o CSS, mas não detectou a falha na aplicação da preferência.
Agora `scripts/profile-frontend.mjs` fornece a escolha pela resposta de
`/api/prefs` e registra atributos, animações e filtros efetivos. Também aceita
`idle`, `compacting`, `pause-status`, `pause-typing`, `pause-indicators`,
`compacting-pause-spinner`, `compacting-pause-status` e
`compacting-pause-indicators`. Nenhum desses controles altera a instalação.

O ajuste isolado de `data-glass` preserva todos os keyframes e os rostinhos ocultos. Não
troca o formato dos indicadores nem reduz sua frequência. Os rostos são HTML
gerado pelo React e desenhado com CSS (`span`/`i`); o estado working executa
seis animações CSS: corpo, olhos, anel e três faíscas. Não são SVG e não há loop
JavaScript por quadro no componente. Mudar o formato por si só não demonstrou
resolver o custo de composição observado.

### Validação do ajuste e limite da melhora

O build instalado foi medido novamente com o harness atualizado: working deu
1.350 ms e compacting 4.000 ms de CPU gráfica em seis segundos. Duas amostras
do novo build, carregando a mesma preferência salva pela API, deram:

| Estado | CPU gráfica em 6 s | Animações em execução | Backdrop filters |
| --- | ---: | ---: | ---: |
| Working | 1.310 / 1.360 ms | 4 | 0 |
| Compacting | 1.310 / 2.150 ms | 2 | 0 |
| Idle | 10 / 20 ms | 0 | 0 |

A correção reduz o custo de compacting e faz o controle funcionar, mas **não
resolve o consumo residual de working** no backend por software. Não é
evidência de que a lentidão no computador do usuário tenha sido eliminada.

Controles adicionais no build corrigido mantiveram os mesmos quatro movimentos:
aproximar a bolinha do topo dos pontinhos, só na página de diagnóstico, deu
440 ms. Remover a sombra da bolinha deu 1.330 ms; tornar o fundo principal
opaco deu 1.370 ms. Ocultar a pintura das mensagens não ajudou (4.080 ms).
Isso aponta para a área de composição entre os indicadores, em vez de apenas
seu formato ou da quantidade de texto. Nenhuma dessas alterações experimentais
foi incorporada ao CSS do produto.

Uma trace separada, sem usar seus tempos como amostra de antes/depois, registrou
365 quadros em seis segundos, zero eventos Paint e 1.051 ms acumulados em
`SoftwareRenderer::DoDrawQuad`. As durações das chamadas aninhadas não devem ser
somadas. O trabalho observado é composição de camadas já pintadas. Foi
solicitado ao usuário o status de Compositing/Rasterization do `chrome://gpu`;
o relatório enviado depois confirmou composição por software, como descrito
na seção seguinte.

44 testes selecionados passaram (aparência, painel, autoscroll e medidor de
contexto). O pacote foi gerado e validado em instância isolada: saúde, index e
assets do build. A instalação permanece no processo anterior, sem reinício.
Resultados sem conversas em `.superpowers/review-active-indicators/`;
capturas e trace completas ficam no diretório privado em `/tmp`.

### Relatório do Chrome do usuário

O arquivo `014-about-gpu-2026-09-06T11-36-07-312Z.txt`, exportado em
2026-09-06 às 11:36:03 UTC, registra Chrome 151.0.7922.137 no Zorin/GNOME,
Linux 6.8.0-136-generic e X11. No primeiro bloco Graphics Feature Status,
Compositing e Rasterization estão em **Software only. Hardware acceleration
disabled**. OpenGL está desativado e o contador registra quatro quedas do
processo GPU. Problems Detected informa explicitamente que o acesso à GPU foi
desativado devido a quedas frequentes.

O bloco separado "Graphics Feature Status for Hardware GPU" lista recursos
acelerados; isso não substitui o estado efetivo do primeiro bloco. O log mostra
quatro encerramentos do processo GPU (code 512) em 4 de setembro, com erros de
VSync entre eles. Há referência a `nvidia-drm`, mas os campos atuais de modelo e
driver estão vazios/desativados. Esses registros não determinam a causa das
quedas nem demonstram que foram provocadas pelo Claudinei.

O relatório confirma a mesma categoria de caminho gráfico usado na reprodução
local, não desempenho idêntico: navegador, hardware e dimensões diferem.
O próximo controle é conferir a opção de aceleração em
`chrome://settings/system`, reabrir completamente o Chrome do computador do
usuário quando ele puder, e conferir novamente o primeiro bloco de
`chrome://gpu` e o consumo na mesma conversa. A recuperação ainda não foi
confirmada. Nenhuma configuração do navegador do usuário, driver ou serviço
do servidor foi alterada por esta análise.

## Isolamento do desfoque com as animações originais — 2026-09-06

Depois do relato de que o consumo voltou, o mesmo Chrome de teste recebeu o
build implantado. Ensaios no frontend completo descartaram como solução isolada
remover o gradiente de fundo, trocar background-attachment, promover camadas e
remover a sombra do rosto. Retirar o desfoque da lateral reduziu o custo.

O controle seguinte manteve três cópias do rosto trabalhando (18 animações,
mesmos movimentos originais) numa página mínima. O painel conservou cor,
transparência e borda; só `backdrop-filter` mudou. Cada amostra mede cerca de
seis segundos, sem streaming nem amostrador de JavaScript.

| Painel atrás das mesmas três bolinhas | CPU do processo gráfico em 6 s |
| --- | ---: |
| Vidro de 292 × 1036 px, desfoque desativado | 590 ms |
| Mesmo vidro, desfoque de 14 px ativado | 5.900 ms |
| Vidro com desfoque de 14 px, altura reduzida para 100 px | 1.170 ms |

Uma primeira dupla independente mediu 560 ms sem vidro e 6.080 ms com vidro.
O controle que desativou **apenas** o desfoque confirmou o efeito. Os números
apontam para o custo de compor o painel filtrado a cada quadro, não para o
número de bolinhas ou a complexidade de seu movimento. A janela de seis
segundos com 5.900 ms de CPU representa aproximadamente um núcleo ocupado.

O backend gráfico desta medição continua sendo software. Naquele momento o
usuário havia confirmado o vínculo entre animações e consumo, mas ainda não
tinha enviado o relatório de GPU; a confirmação posterior está registrada
acima. Não foi medida diretamente a CPU do computador dele. Nenhuma animação
ou preferência da instalação foi alterada nestes ensaios.
Os resultados e o script ficam em `.superpowers/animation-blur-diagnosis/`; os
GETs de entrada permanecem na fixture privada usada na investigação anterior.

Referências: [guia de animações do Chrome](https://web.dev/articles/animations-guide)
e [arquitetura de composição do Chromium](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/).

## Investigação com um agente — 2026-09-06

O primeiro ensaio usava Vite em desenvolvimento, 30 projetos, 700 itens e 50
deltas/s. Além disso, o transporte diferia entre as amostras: aplicação direta
no store antes e WebSocket depois. A redução de 82% observada nesse ensaio não
comprova a solução do consumo no computador do usuário. O ensaio também media
apenas tarefas da thread principal, deixando de fora o processo gráfico.

A investigação seguinte copiou os assets efetivamente servidos pelo binário
em execução e as respostas GET da instalação. O navegador de teste recebeu
essas cópias por interceptação de HTTP/WebSocket; não enviou comandos à
instalação. O serviço permaneceu em execução.

Cenário: quatro projetos, quatro sessões, somente uma trabalhando, preferências
reais do tema Dark Fun, sidebar recolhida por projeto e histórico real de 62
eventos (126 KB), renderizando 40 respostas. Viewport 1610 × 1036, escala 1.
O histórico é o retornado pela API: a aba do usuário pode ter acumulado mais
ferramentas ao vivo. Não é uma captura do DOM do computador dele.

Uma conexão WebSocket somente de leitura recebeu quatro frames em 30 segundos:
snapshot, assistant, user e contexto. Nenhum delta de texto nessa amostra. Por
isso, a espera sem eventos foi medida separadamente do streaming artificial.

### Causa observada

Na espera, não ocorreram mutações do DOM nem chamadas de scrollIntoView durante
a medição. Ainda assim, o processo gráfico consumiu aproximadamente um núcleo.
A trace encontrou a maior parte do tempo em SoftwareRenderer::DoDrawQuad, no
compositor do Chromium. Desligar os movimentos dos projetos parados e manter
apenas rosto ativo, bolinha de estado e pontinhos do chat preservou esse custo.
A quantidade de indicadores visíveis não representa o trabalho de composição.

Retirar o desfoque reduziu parte do custo. Promover camadas com will-change,
isolar o rosto, conter pintura e separar o desfoque num pseudo-elemento não
resolveram o caso medido. O ajuste experimental mantinha os indicadores pequenos
com pose estática e pulsos de opacidade espaçados, usando steps(1, end).
Conserva o vidro e evita redesenho contínuo entre mudanças do pulso. Aplicar
steps às várias animações antigas foi insuficiente.

### Como medir e interpretar

Usamos Chromium headless, assets de produção antes/depois, mesmas respostas
HTTP e mesmo caminho WebSocket nos dois builds. Cada cenário abre um contexto
novo, espera a montagem e o fim da rolagem e mede seis segundos. Nenhum build ou
teste pesado roda em paralelo. Os ensaios finais não ativam o profiler de JS,
porque sua amostragem interfere no consumo do processo renderer.

- Performance.getMetrics: diferenças de TaskDuration, ScriptDuration,
  LayoutDuration e RecalcStyleDuration, apenas da thread principal da página.
- SystemInfo.getProcessInfo: diferenças de cpuTime por processo, incluindo GPU
  e renderer. 6.000 ms de CPU numa janela de 6 s equivalem a um núcleo ocupado;
  não são a porcentagem do processador inteiro do computador.
- Contadores de mutações e scrollIntoView distinguem redesenho gráfico de
  atualizações de conteúdo. Tracing identifica o caminho de renderização.

O servidor de teste usa renderização por software: gpu_compositing e
rasterization aparecem como disabled_software. Estes números demonstram o
problema e a melhora nesse caminho, não medem a CPU/GPU do computador do
usuário. Navegador, aceleração gráfica, escala, resolução e conteúdo podem mudar
os resultados. A confirmação no computador dele continua necessária.

O usuário confirmou Linux com Google Chrome. O executável usado aqui se
identifica como Google Chrome for Testing 153.0.8010.12, rodando em Linux sem
aceleração gráfica. Isso aproxima o motor do navegador, mas por si só não
confirma o backend do computador do usuário. O relatório posterior do Chrome
151 confirmou Compositing e Rasterization por software. Falhas isoladas em
Video Decode/Encode não demonstram falta de aceleração da interface do chat.

### Resultados

Espera sem eventos, três amostras de aproximadamente seis segundos por build.
Tempos em milissegundos (CPU do processo via cpuTime); mediana e intervalo observado, sem descartar a
primeira amostra, que foi mais alta no build atualizado:

| Medição | Servido antes | Atualizado |
| --- | ---: | ---: |
| Processo gráfico | 5.990 (5.910–6.040) | 620 (580–2.270) |
| Tarefas da thread principal | 329 (325–342) | 82 (79–143) |
| JavaScript da página | 5,2 (4,6–5,4) | 2,2 (2,1–6,8) |
| Mutações / chamadas de rolagem | 0 / 0 | 0 / 0 |

A mediana do custo gráfico caiu cerca de 90% nesse cenário. A variação do build
atualizado impede tratar 620 ms como um teto. Mesmo o pacote intermediário, com
otimizações de streaming e rostos parados estáticos, ainda gastava 5.980 ms no
processo gráfico durante a espera; o ajuste de pulsos é uma correção adicional.

Em outro ensaio, com deltas artificiais enviados pelo WebSocket a cada 20 ms,
o build anterior chamou scrollIntoView 296 vezes em seis segundos. O atualizado
chamou 11 vezes; a thread principal passou de 2.796 ms para 599 ms e o processo
gráfico de 5.970 ms para 1.410 ms. Esta é uma carga de streaming, não o tráfego
observado na amostra real de espera.

### Repetição

`scripts/profile-frontend.mjs` aceita um diretório de assets de produção e um
JSON que mapeia caminhos GET às respostas capturadas. São necessários
`/api/auth/me`, `/api/projects`, `/api/sessions`, o histórico da sessão ativa,
`/api/prefs`, `/api/engines` e as listas auxiliares usadas pela tela (grupos,
setores, agendamentos, uso). APIs não capturadas aparecem em `unknownApis` no
relatório. O harness intercepta todo HTTP/WebSocket em um domínio de teste,
sem conexão com o serviço. As fixtures com conversas ficam fora do repositório.

Instale Playwright separadamente para diagnóstico ou indique seu módulo e
Chromium já disponíveis. Exemplo, repetido com cada diretório de assets:

```sh
PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs \
CHROMIUM_PATH=/caminho/chromium/chrome \
node scripts/profile-frontend.mjs \
  --assets /tmp/frontend-capturado --fixtures /tmp/respostas-get.json \
  --output /tmp/metricas.json --modes waiting --samples 3
```

Os modos `stream,reduced-motion,glass-off` verificam também recebimento integral
dos deltas e os atributos reais dos controles de aparência, usando o CSS do
build. Cada execução registra o backend gráfico para distinguir software de
aceleração disponível. Não execute builds/testes concorrentes à medição.

Validação final: 71 testes selecionados passaram; o harness recebeu os 345
deltas enviados sem perda, confirmou zero animações no modo reduzido e zero
backdrop filters com vidro desligado na tela reproduzida. O pacote foi gerado
e executado em uma instância isolada: assets conferidos, WebSocket, adendos em
ordem durante trabalho, contexto e compactação passaram. Não houve instalação
nem reinício do serviço em uso.

## Implementação

O frontend agrupa deltas do WebSocket por sessão e publica o texto no máximo a
cada 100 ms (250 ms com a página oculta). Eventos finais e mudanças de estado
publicam primeiro os deltas pendentes, preservando a ordem e evitando que um
preview reapareça depois da resposta final. Nenhum texto é descartado.

A resposta parcial tem uma assinatura própria do store. O histórico, os grupos
de ferramentas, a barra lateral e as demais telas assinam apenas os campos que
usam. O crescimento vertical do conteúdo é observado por ResizeObserver: um
novo token na mesma linha não reinicia uma animação de rolagem. Ler mensagens
anteriores continua suspendendo o acompanhamento automático.

Os blocos antigos usam content-visibility para reduzir o custo de layout e
pintura fora da área visível. O conteúdo permanece no DOM. Blocos com foco
retiram essa contenção para permitir menus e ações interativas.

Os rostos, bolinhas de estado e pontinhos do chat conservam as animações
originais. Ocultar a página pausa animações.
O modo de movimento reduzido prevalece sobre as regras dos rostos. Desligar
vidro também remove os desfoques dos cartões, cabeçalhos de ações e overlays.
