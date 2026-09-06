# Desempenho do chat

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
resolveram o caso medido. O ajuste escolhido mantém os indicadores pequenos
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
aceleração gráfica. Isso aproxima o motor do navegador, mas não confirma que o
computador do usuário também renderize por software. O próximo dado solicitado
é o valor de Compositing e Rasterization em Graphics Feature Status, na página
chrome://gpu do computador dele. Falhas isoladas em Video Decode/Encode não
demonstram falta de aceleração da interface do chat.

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

Rostos de sessões ociosas/encerradas ficam estáticos. Rostos pequenos usam poses
e pulsos espaçados para sinalizar trabalho, inicialização e compactação; os
rostos grandes conservam seus gestos. A bolinha de estado e os pontinhos do
chat também pulsam em intervalos discretos. Ocultar a página pausa animações.
O modo de movimento reduzido prevalece sobre as regras dos rostos. Desligar
vidro também remove os desfoques dos cartões, cabeçalhos de ações e overlays.
