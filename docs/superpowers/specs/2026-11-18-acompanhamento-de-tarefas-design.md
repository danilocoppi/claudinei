# Acompanhamento de tarefas longas — design

## Por quê

Em tarefas longas, o operador só sabe em que pé está o agente lendo o chat. No
projeto AI Uno, o agente passou a manter uma página (`~/ia-uno-progresso/`):
um `estado.js` que ele reescreve a cada passo (o que faz agora, as tarefas com o
estado de cada uma, o que espera do operador) e uma página que o relê a cada 5 s.
O operador quer isso como padrão em **todos os terminais**, dentro do Claudinei:
um botão no cabeçalho do chat abre uma coluna à direita com o andamento daquele
terminal, no visual do Claudinei.

## Objetivos

- Todo agente, em trabalho com várias etapas, informa o andamento ao Claudinei:
  ao começar, a cada etapa concluída, ao travar ou precisar do operador, e no fim.
- O Claudinei mostra esse andamento numa coluna à direita do chat, atualizada na
  hora (sem recarregar de tempos em tempos).
- Funciona igual nos quatro motores (Claude, Codex, Kimi, OpenCode).
- O andamento fica gravado num arquivo por terminal, que o operador pode abrir.

## Não-objetivos

- Pedidos rápidos e perguntas não ganham acompanhamento.
- "Roteiro" de fases (o bloco "Roteiro da Fase 2" do AI Uno) — fora.
- Histórico de tarefas longas anteriores: a nova substitui a antiga.
- Mostrar a lista interna de afazeres dos agentes (TodoWrite/update_plan).
- Visão agregada de todos os terminais numa tela só.

## Anti-objetivos

- Encarecer toda tarefa: o agente não atualiza a cada ferramenta que usa, só nos
  marcos acima.
- Pesar a interface sem GPU (AGENTS.md): nada de animação contínua cara; a
  bolinha do "Agora" pulsa por opacidade, e pausa com `prefers-reduced-motion`.
- Acompanhamento que mente: se o terminal parou no meio, a coluna não pode seguir
  dizendo "em andamento" como se nada fosse.

## Abordagens consideradas

1. O agente escreve um arquivo JSON; o Claudinei vigia e desenha. Literal ao
   pedido, mas o agente escreve o formato à mão (erros de sintaxe), precisa saber
   o caminho, e o Codex roda em área restrita (escrever fora da pasta pode falhar).
2. **Ferramenta nova no Hermes (escolhida pelo operador).** O agente chama
   `update_progress` com o estado; o Claudinei confere o formato, grava num
   arquivo por terminal e manda à tela por WebSocket. Formato garantido, mesmo
   caminho nos quatro motores (todos já carregam o Hermes), arquivo continua
   existindo.
3. Mostrar a lista interna dos agentes. Custo zero, mas pobre (sem "agora" nem
   "esperando você"), diferente por motor, opcional para o agente e efêmera.

## Como (decidido com o operador)

### Identidade

Um acompanhamento por **terminal = projeto + motor**, não por sessão: sobrevive a
reinício e a sessão nova do mesmo terminal. O Hermes já recebe
`CLAUDINEI_PROJECT_ID` e `CLAUDINEI_ENGINE` em todos os motores.

### O estado (sempre inteiro; cada chamada substitui o anterior)

- `title`: a tarefa longa (ex.: "Fase 4, parte 1").
- `now`: `{ title, detail? }` — o que está fazendo agora.
- `tasks`: lista de `{ name, status, note? }`, `status` ∈ `pending`,
  `in_progress`, `review`, `blocked`, `done`.
- `waiting`: lista de textos — o que depende do operador.
- O servidor carimba `updatedAt`.

### A ferramenta `update_progress` (Hermes)

- A orientação de uso (quando chamar: tarefas com várias etapas; nos marcos;
  estado inteiro a cada chamada; textos no idioma do operador) vai na
  **descrição da ferramenta**, não nas instructions do servidor — as instructions
  já usam o orçamento de 4096 caracteres do Claude com a regra do terminal errado.
- Formato inválido ou acima dos limites volta como erro legível para o agente
  corrigir e chamar de novo.

### Gravação e entrega

- Arquivo `~/.claudinei/acompanhamento/<projectId>-<engine>.json` (o diretório
  segue a pasta de dados do Claudinei).
- Broadcast por WebSocket para quem tem acesso ao projeto; leitura do estado
  atual ao abrir a coluna (e ao reconectar).
- Respeita o acesso por projeto (mesma regra das rotas do Hermes).

### A coluna

- Botão no cabeçalho do chat, antes de "Schedules" (o ponto da seta do print do
  operador). Ganha uma bolinha quando há tarefa `in_progress`.
- Coluna à direita, ~340 px, que **empurra** o chat (não sobrepõe); lembra se
  estava aberta. No celular, ocupa a tela, com botão de voltar.
- Conteúdo, no visual do Claudinei (variáveis de tema, cartões, chips):
  título + "3 de 7" com barra de progresso; **Agora** em destaque com bolinha;
  **Tarefas** com ícone e chip de estado e nota; **Esperando você** em destaque
  âmbar; rodapé "atualizado há X min".
- Vazio: uma linha dizendo que o terminal ainda não tem tarefa longa em
  acompanhamento.

### Quem atualiza (decidido pelo operador)

Um acompanhamento por terminal, e **o mais recente vence**: rotina agendada e
tarefa encaminhada por outro projeto também atualizam a coluna, porque são o que
o terminal está fazendo. Para não sumir o que depende do operador, a descrição da
ferramenta manda o agente **carregar os itens de "Esperando você" ainda não
resolvidos** para o estado novo. Só o agente principal atualiza; a descrição diz
que subagentes não chamam a ferramenta (o servidor não os distingue).

### Decisões de quem escreveu (o operador confere na leitura)

- **Andamento que pode estar velho.** Se a sessão do terminal parou ou morreu
  (`stopped`/`dead`, ou não há sessão viva) com tarefa `in_progress`, a coluna
  mostra um aviso ("o terminal parou; este andamento pode estar desatualizado"),
  a bolinha do "Agora" e a do botão param. Terminal ocioso (`idle`/
  `needs_attention`) é normal — o agente pode estar esperando o operador — e não
  gera aviso. O rodapé fica âmbar depois de 45 min sem atualização enquanto houver
  tarefa não concluída. Tudo isso é só na tela, derivado no navegador do status da
  sessão; o arquivo não é reescrito.
- **Limpar.** A coluna tem um botão para descartar o acompanhamento (apaga o
  arquivo; confirma antes). O agente não tem ação de limpar: uma tarefa nova
  substitui a anterior.
- **Terminal interativo ("Abrir no terminal") fica de fora.** Nenhum motor
  carrega o Hermes nesse modo; vale só para os terminais do chat.
- **Abrir o arquivo.** O rodapé mostra o caminho com botão de copiar; abrir pelo
  visualizador do Claudinei não entra (a pasta fica fora do escopo dele).

## Verificação

- Testes do servidor: validação e limites da ferramenta; gravação no arquivo;
  broadcast; acesso por projeto.
- Testes da interface: a coluna desenha os blocos, abre/fecha pelo botão,
  atualiza ao chegar estado novo, e a bolinha do botão.
- Ensaio numa instância isolada com os CLIs reais: uma tarefa longa de verdade
  (barata) — o agente chama a ferramenta nos marcos e a coluna acompanha; um
  pedido rápido não gera acompanhamento.

## Deixado para quem constrói

- Limites de tamanho (título, nota, número de tarefas…).
- O texto da descrição da ferramenta (inglês, como as demais; até ~2000
  caracteres, que é o teto de descrição de ferramenta do Claude Code).
- Ícones, espaçamentos e as chaves de i18n (pt-BR, en, es).
