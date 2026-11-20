# Motores por terminal — design

Projeto 2 do roteiro `docs/superpowers/roteiro-ideias-t3code.md`.

## Por quê

Nas palavras do operador: "No terminal ligar quais agentes se vai usar ali,
assim o header não fica aparecendo todos os instalados, pois na grande maioria
se usa 1 ou 2 no máximo."

Hoje o cabeçalho de todo terminal mostra uma aba por motor que o Claudinei
conhece (`web/src/components/EngineTabs.tsx`, que percorre `store.engines`).
Isso inclui motores que nem estão instalados, que aparecem com o selo "não
instalada". Num terminal onde só se usa o Claude, as outras três abas só ocupam
largura e confundem.

## Objetivos

1. Cada terminal tem a sua lista de motores. Só eles aparecem no cabeçalho e
   nas listas de escolha daquele terminal.
2. O operador liga e desliga motores do terminal sem sair do chat.
3. Os terminais que já existem começam enxutos: só com os motores já usados
   neles.

## Não-objetivos

- Esconder ou desinstalar motores no Claudinei inteiro. A lista é por
  terminal.
- Mudar o roteamento entre agentes. `dispatch_task` e `ask_agent` continuam
  escolhendo a primeira sessão livre do projeto, de qualquer motor.
- Preferências por usuário. A lista é do terminal e vale para todos.

## Anti-objetivos

- **Perder de vista um agente vivo.** Um motor escondido que tem sessão viva
  continua com aba até a sessão parar. Sem isso, o operador não teria como ver
  ou encerrar a sessão.
- **Terminal sem nenhum motor.** Ninguém conseguiria abrir conversa nele.
- **Gasto ou processo escondido.** Um motor escondido não sobe sozinho com o
  Claudinei.

## Abordagens consideradas

1. **Lista de motores gravada no próprio terminal (escolhida).** Uma coluna
   `engines` em `projects` guarda a lista. Ao migrar, ela é preenchida com os
   motores já usados no terminal. É simples, viaja junto com o terminal (como
   `heads_up`) e trata bem um motor recém-instalado.
2. Um "visível" por motor em `terminal_state` (a tabela do projeto 1, uma linha
   por projeto + motor). Descartada porque obriga a decidir linha a linha o que
   significa "sem linha", o que complica o caso de um motor recém-instalado e o
   de um terminal novo. Além disso, aquela tabela trata de reinício, não de
   aparência.

## Como (decidido com o operador)

### Onde fica e como se edita

- `projects.engines`: lista JSON de ids de motor, em ordem.
- O formulário "editar terminal" (`NewProjectModal.tsx`, aberto pelo menu ⋮ do
  cartão) ganha caixas de marcar com os motores. O mesmo formulário, na
  criação, já traz a seleção padrão (ver as decisões abaixo).
- No fim das abas do cabeçalho fica um botão "+" que lista os motores
  escondidos do terminal, inclusive os não instalados, marcados como tal.
  Escolher um motor o acrescenta à lista do terminal, e a aba aparece na hora.
  Retirar um motor é pelo formulário. O "+" só acrescenta.

### O que a lista controla

- **As abas do cabeçalho do chat e da barra do terminal interativo**
  (`EngineTabs`, usada em `ChatView.tsx` e `TerminalView.tsx`) mostram só os
  motores da lista, mais os que tiverem sessão viva naquele terminal.
- **Listas de escolha de motor:**
  - iniciar sessão (`StartSessionModal`);
  - o menu de motor do cartão da lateral (`EnginePickerMenu`, aberto em
    `Sidebar.tsx`);
  - a lista de motor do editor de agendamentos (`ScheduleEditor.tsx`).

  Todas oferecem só os motores da lista.
- **"Iniciar com o Claudinei"** (projeto 1, `restart/boot.ts`): um motor fora
  da lista não sobe sozinho, mesmo com o interruptor ligado.
- **Motores não instalados** nunca aparecem como aba, a menos que tenham sessão
  viva. Na lista do formulário e no "+" eles aparecem com o selo "não
  instalada".

### O que a lista não controla

- Sessão viva: mantém a aba até parar, e continua alcançável por
  `dispatch_task` e `ask_agent`.
- Agendamento já preso a um motor que foi escondido: continua rodando nesse
  motor (`scheduler.ts`). Só a lista do editor deixa de oferecê-lo para novos
  agendamentos.
- Trabalho interrompido (projeto 1): uma sessão interrompida estava viva, então
  o aviso e a retomada continuam valendo para o motor dela, mesmo fora da
  lista.

### Terminais existentes (decidido pelo operador: "2: A")

Na migração, cada terminal recebe como lista os motores **já usados nele**. Se
nunca usou nenhum, recebe só o Claude.

## Decisões de quem escreveu (o operador confere na leitura)

- **O que conta como "já usado".** Ter linha em `sessions` ou em
  `project_threads` para aquele projeto + motor. `project_threads` sobrevive à
  poda das sessões antigas (`manager.ts` guarda só 5 por projeto), então cobre
  motores usados há mais tempo. A ordem da lista segue a ordem de
  `store.engines` (Claude, Codex, Kimi, OpenCode).
- **Pelo menos um motor.** O formulário não deixa salvar sem nenhum, e o
  servidor recusa uma lista vazia.
- **Terminal novo.** Começa só com o Claude. Se o Claude não estiver instalado,
  começa com o primeiro motor instalado.
- **Motor recém-instalado.** Não aparece sozinho em nenhum terminal. Fica
  disponível no "+" e no formulário. É o que o operador pediu: só o que ele
  ligou.
- **Lista com motor desconhecido** (motor removido do Claudinei numa versão
  futura): o id é ignorado na exibição e preservado no banco.
- **Quem pode mudar.** Quem tem acesso ao terminal, como acontece com os
  avisos "You should know" (`PATCH /api/projects/:id/heads-up`).

## Verificação

- **Testes do servidor:**
  - migração: terminal com sessões de Claude e Codex fica com os dois;
    terminal só com `project_threads` de Kimi fica com o Kimi; terminal sem
    nada fica com o Claude;
  - lista vazia recusada;
  - acesso por projeto (403);
  - "iniciar com o Claudinei" ignora motor fora da lista.
- **Testes da interface:**
  - abas mostram só a lista, mais o motor fora dela com sessão viva;
  - o "+" lista os escondidos e acrescenta;
  - formulário com as caixas;
  - listas de escolha filtradas (iniciar sessão, menu do cartão, agendamento);
  - agendamento existente com motor escondido continua listado no editor dele.
- **Ensaio numa instância isolada (porta 9199)**, com cópia do banco: os
  terminais migram com os motores certos, e o cabeçalho fica com uma ou duas
  abas.

## Deixado para quem constrói

- O formato exato da coluna (JSON) e da rota (rota própria, como a de
  `heads-up`, ou dentro do `PATCH` do terminal).
- O visual do "+" e do selo "não instalada" no menu.
- Os textos e as chaves de i18n (pt-BR, en, es).
