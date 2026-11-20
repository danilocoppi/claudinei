# Reinício sem prejuízo — design

Projeto 1 do roteiro `docs/superpowers/roteiro-ideias-t3code.md` (inspirado no
"Continue threads after restarts" do T3 Code).

## Por quê

Reiniciar o `claudinei.service` mata todas as sessões de agente (elas vivem no
cgroup do serviço). Hoje, ao subir, toda sessão que estava ativa vira `dead`; o
operador precisa entrar em cada terminal e clicar em Reviver, e o turno que
estava rodando fica pela metade. Com dezenas de terminais, um reinício custa o
trabalho em andamento de vários agentes (AGENTS.md já exige autorização expressa
para reiniciar por causa disso). O operador também quer que alguns terminais
subam sozinhos sempre que o Claudinei inicia.

## Objetivos

1. **Iniciar com o Claudinei** (por terminal): ao subir, a sessão do terminal
   abre sozinha retomando a última conversa, parada e pronta, sem mandar nada.
2. **Retomar trabalho interrompido** (por terminal): a sessão que estava no meio
   de um turno quando o serviço caiu volta e continua o turno sozinha.
3. Com "retomar" desligado, o terminal interrompido mostra um aviso com o botão
   **Continuar**, que faz a mesma retomada sob demanda.

## Não-objetivos

- Mudar a regra de reinício: reiniciar continua exigindo autorização expressa.
- Recuperar perguntas (AskUserQuestion) ou aprovações abertas no reinício: elas
  se perdem; o aviso mostra a pergunta perdida (ver "Na subida do servidor").
- Recuperar mensagens que estavam na fila do turno (adendos): é do projeto 5
  (fila editável).
- Retomar o terminal interativo ("Abrir no terminal"): sessões `in_terminal`
  continuam como hoje (viram `stopped`).

## Anti-objetivos

- Ciclo de retomadas: um turno que derruba o serviço não pode ser retomado para
  sempre — depois de 3 retomadas seguidas sem o turno terminar, espera o operador.
- Tumulto na subida: dezenas de sessões subindo juntas não podem travar a
  máquina nem disparar dezenas de agentes de uma vez.
- Gastar tokens sem o operador querer: "retomar" vem desligado nos terminais
  existentes; com ele desligado, nada é enviado sem clique.

## Abordagens consideradas

1. **No próprio Claudinei, na subida do servidor (escolhida).** O servidor
   registra quem estava trabalhando e, ao subir, decide o que reviver. Enxerga o
   estado das sessões e os interruptores.
2. Script do systemd depois do start (`ExecStartPost`) chamando a API. Não
   enxerga o estado interno, depende de autenticação de serviço e de tempo de
   subida. Descartada.

## Como (decidido com o operador)

### Interruptores por terminal (projeto + motor)

- Ficam no ⚙ do campo (controles da sessão), ao lado de "Avisos 'You should
  know'", para o motor da aba aberta.
- **Iniciar com o Claudinei**: desligado por padrão.
- **Retomar trabalho interrompido**: desligado nos terminais que já existem e
  também nos novos (o operador pode mudar o padrão depois, fora deste projeto).
- Guardados por projeto + motor (sobrevivem à poda de sessões antigas).

### Registrar quem estava trabalhando

- Reinício normal (SIGINT/SIGTERM): antes de `stopAll`, o servidor marca como
  interrompidas as sessões com turno em andamento (`working`, inclusive
  compactando).
- Queda brusca (SIGKILL, crash, OOM): na subida, sessão persistida como
  `working` conta como interrompida (hoje ela só vira `dead`).
- Uma sessão interrompida guarda o momento da interrupção e um contador de
  retomadas seguidas.
- Pergunta ou aprovação aberta: quando o agente para numa pergunta
  (`pendingQuestion`), ela fica gravada no banco até ser respondida ou o turno
  acabar, para valer também na queda brusca. Na interrupção, a sessão guarda o
  texto dessa pergunta.

### Na subida do servidor

Para cada terminal, nesta ordem de decisão:

1. **Interrompido com pergunta ou aprovação aberta**: nunca retoma sozinho, mesmo
   com retomar ligado, porque o agente seguiria sem a decisão que deixou com o
   operador. Mostra o aviso de interrompido, com a pergunta que se perdeu, e o
   botão Continuar.
2. **Interrompido + retomar ligado**: revive a sessão (resume da própria
   conversa, como o Reviver de hoje) e envia a mensagem de retomada. Se o contador
   já chegou a 3, não retoma: mostra o aviso com Continuar e o motivo ("retomado 3
   vezes sem concluir").
3. **Interrompido + retomar desligado**: mostra o aviso "o trabalho foi
   interrompido pelo reinício" com **Continuar**. Não sobe processo, a menos que
   "Iniciar com o Claudinei" esteja ligado: aí a sessão sobe parada (sem
   mensagem) e o aviso fica do mesmo jeito.
4. **Não interrompido + iniciar com o Claudinei ligado**: revive parado, sem
   mensagem.

O botão **Continuar** revive a sessão se ela não estiver de pé e envia a
mensagem de retomada. Mandar qualquer outra mensagem (que revive como hoje)
também tira o aviso; o mesmo vale para o botão de fechar do aviso.
- As sessões sobem em lotes pequenos (por exemplo 3 por vez, com espera entre
  lotes), primeiro as interrompidas com retomar ligado.

### A mensagem de retomada

- Texto fixo do Claudinei, no idioma do operador, por exemplo: "O serviço do
  Claudinei reiniciou no meio do seu turno. Continue de onde parou; confira o
  estado dos arquivos antes de refazer algo."
- Aparece no chat marcada como vinda do Claudinei (como hoje as tasks
  encaminhadas mostram "Task de …"), não como mensagem do operador.

### Tarefas encaminhadas e agendamentos (decidido pelo operador)

Quando o turno interrompido veio de uma tarefa encaminhada por outro terminal
(`dispatchTask`) ou de um agendamento, quem esperava o resultado também morre no
reinício. A tarefa é **religada** ao turno retomado:

- **Tarefa encaminhada**: no encerramento normal, a parada das sessões não
  fecha a tarefa como "target agent was stopped"; ela fica `in_progress` presa à
  sessão interrompida. Na subida, se o terminal retoma o turno (casos 2 e
  Continuar), a tarefa volta a ser acompanhada: quando o turno retomado termina, a
  tarefa fecha como concluída com o resultado dele, com o mesmo prazo de hoje
  contado a partir da retomada. Se o terminal não retoma sozinho (casos 1, 3 e o
  teto de 3), a tarefa fecha na subida como falha "interrompida pelo reinício do
  Claudinei", e quem encaminhou pode mandar de novo; um Continuar posterior
  retoma o turno, mas não reabre a tarefa.
- **Agendamento**: a execução que estava rodando fecha na subida como erro
  "interrompida pelo reinício do Claudinei" e não dispara de novo sozinha; o
  terminal segue a regra dele (retoma ou mostra o aviso). Isso também corrige um
  defeito de hoje: depois de uma queda, a execução ficava `running` para sempre
  e todos os disparos seguintes do agendamento saíam como `skipped`.
- Perguntas entre agentes (`askAgent`) não são religadas: o prazo delas é de 2
  min e quem perguntou já recebeu erro.

### Contador de retomadas

- Sobe a cada retomada automática; volta a zero quando um turno termina
  normalmente (`result`) ou quando o operador manda uma mensagem.
- Teto: 3.

## Verificação

- Testes do servidor: marca de interrompida no encerramento normal e na queda;
  pergunta aberta gravada e limpa; decisões da subida (os quatro casos acima e o
  teto de 3); lotes; contador zera; tarefa religada fecha como concluída ao fim
  do turno retomado e como falha quando não há retomada; execução de agendamento
  `running` fecha como erro na subida e não trava os disparos seguintes.
- Testes da interface: os dois interruptores; o aviso com Continuar; o aviso some
  ao mandar mensagem; a mensagem de retomada aparece como do Claudinei.
- Ensaio numa instância isolada (porta 9199) com o CLI falso e com o Claude real:
  turno longo em andamento, reinício da instância, retomada automática; e com
  retomar desligado, o botão Continuar.

## Decisões de quem escreveu (o operador confere na leitura)

- Pergunta aberta nunca retoma sozinha (caso 1).
- "Iniciar com o Claudinei" ligado e retomar desligado: a sessão sobe parada e o
  aviso de interrompido aparece (caso 3).
- O aviso pode ser fechado sem continuar.
- Perguntas entre agentes não são religadas.

## Deixado para quem constrói

- Tamanho do lote e espera entre lotes.
- O texto exato da mensagem e do aviso (pt-BR, en, es).
- Como marcar a mensagem como "do Claudinei" (prefixo reconhecido, como o
  `[Task from …]`, ou flag).
- Onde guardar os interruptores e os campos de interrupção no banco.
