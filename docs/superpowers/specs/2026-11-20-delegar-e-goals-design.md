# Delegar e ser acordado + Goals — design

Projetos 10 e 12 do roteiro `docs/superpowers/roteiro-ideias-t3code.md` (inspirados
no `delegate_task` com "a pai acorda sozinha com o resultado" e nos goals do T3
Code). Uma trilha só: o 10 primeiro, o 12 em cima dele.

## Por quê

- **Delegar.** Quem delega com `dispatch_task` recebe só um id e precisa ficar
  chamando `list_tasks` para saber se acabou (a descrição da ferramenta manda
  fazer isso). Na prática o agente esquece, ou gasta turnos perguntando, e o
  operador vira o mensageiro entre terminais. Além disso a tarefa **falha
  sozinha aos 10 minutos** (`dispatchTask(..., timeoutMs = 600_000)` em
  `server/src/claude/manager.ts`), mesmo com o outro agente ainda trabalhando.
- **Goals.** Hoje o agente para ao fim de cada turno. Trabalho longo com um
  critério claro de pronto ("todos os testes verdes", "a página igual ao
  print") exige o operador mandando "continua" a cada parada.

## Objetivos

1. Quando uma tarefa encaminhada termina (concluída ou falha), o terminal que a
   encaminhou recebe uma mensagem do Claudinei com o resultado — sem polling.
2. A tarefa deixa de falhar por tempo.
3. `/goal <critério>` faz o terminal seguir turno após turno até o próprio
   agente declarar que cumpriu, com teto e paradas seguras.
4. O objetivo e a contagem de turnos ficam à vista (coluna de acompanhamento e
   cartão da lateral).

## Não-objetivos

- `ask_agent` continua como está (síncrono, 2 min).
- Perguntas do agente filho subindo para quem delegou (o T3 faz) — fora.
- Um segundo agente julgando o goal (opção b) ou o operador confirmando a cada
  rodada (opção c) — o operador escolheu: o próprio agente declara.
- Goals em subagentes; goals no terminal interativo ("Abrir no terminal").

## Anti-objetivos

- Acordar no meio de um turno, atropelando o que o agente estava fazendo.
- Subir processo e gastar tokens sem o operador querer: terminal parado só é
  revivido com "Retomar trabalho interrompido" ligado.
- Laço infinito de goal: teto de 20 turnos e paradas em erro, limite de uso e
  qualquer mensagem do operador.
- Inflar as instructions do Hermes (orçamento de 4096 caracteres do Claude, já
  quase cheio em `server/src/hermes/instructions.ts`): tudo novo vai em
  descrição de ferramenta e no texto das mensagens do Claudinei.

## Abordagens consideradas

1. **Servidor do Claudinei, no fim de turno (escolhida).** O aviso usa o mesmo
   mecanismo da mensagem "do Claudinei" do reinício e do limite
   (`manager.sendAsClaudinei`, cartão traduzido na tela); o goal é conduzido
   pelo servidor a cada `result` (`onTurnResult`) e encerrado por uma ferramenta
   nova do Hermes. Vale igual nos quatro motores.
2. Ganchos de parada (Stop hook) do Claude Code — só existem no Claude.
   Descartada.
3. Para o aviso, o agente ficar esperando (`ask_agent` longo) — trava o turno de
   quem delega, que é o contrário de delegar. Descartada.

## Como (decidido com o operador)

### Parte 1 — Delegar e ser acordado

**Quem é acordado.** O terminal de origem da tarefa: `fromProjectId` +
`fromEngine` da linha de `tasks`. Tarefa sem origem (`fromProjectId` nulo,
criada pelo operador) não acorda ninguém. `fromEngine` nulo: usa a sessão viva
mais recente daquele projeto; sem nenhuma, não acorda.

**A mensagem.** Texto fixo do Claudinei, em inglês para o agente, com selo
reconhecido pela tela (como `[Claudinei: resume after restart]`):
`[Claudinei: task result]: Task #<id> sent to <Projeto> completed|failed.` +
o resultado cortado em ~4000 caracteres; se cortado, termina com
`(full text: list_tasks #<id>)`. Na tela vira um cartão "Resultado da tarefa
#id de <Projeto>", traduzido, com o corpo dobrável.

**Quando entregar.**
- Sessão de origem **livre** (idle/needs_attention): entrega na hora.
- **Trabalhando**: espera o turno acabar (gancho `onSessionAvailable`, hoje só
  com `projectId` — passa a informar também o motor). Nunca entra no meio do
  turno.
- **Parada**: com "Retomar trabalho interrompido" ligado naquele terminal,
  revive (o mesmo `bringUp` do reinício) e entrega; desligado, o terminal mostra
  um aviso "A tarefa #id terminou" com **Continuar** (revive + entrega) e ×.
- **Em limite de uso**: espera; entrega quando o terminal voltar a ficar livre
  depois da reabertura.
- Várias pendentes para o mesmo terminal saem **numa mensagem só**, em lista.

**Persistência.** O estado do aviso fica na própria linha da tarefa (pendente,
entregue, dispensado), para sobreviver a reinício: na subida, avisos pendentes
voltam à fila de entrega (respeitando as mesmas regras acima).

**Fim do prazo de 10 minutos.** A tarefa termina quando o turno do destino
termina (como hoje); morte ou parada do destino continuam fechando como falha;
reinício continua religando (projeto 1); limite de uso no destino continua
fechando como falha com o texto do limite (projeto 6). Sem outro prazo: uma
tarefa cujo turno não acaba fica `in_progress`, visível em `list_tasks` e no
painel de tarefas com o tempo decorrido.

**Ferramentas.** A descrição de `dispatch_task` (e `list_tasks`) passa a dizer
que o agente será acordado com o resultado e não precisa ficar consultando.

### Parte 2 — Goals (`/goal`)

**Comandos** (interceptados no servidor, como o `/compact` em `manager.send`,
para todos os motores):
- `/goal <critério>` — inicia (ou substitui) o objetivo do terminal e manda ao
  agente a mensagem de partida: o critério, que ele deve seguir turno a turno e
  que, quando estiver **inteiramente** cumprido, deve chamar `goal_done` com a
  evidência. Conta como mensagem do operador.
- `/goal resume` — reativa um objetivo pausado ou que bateu o teto, com novos
  20 turnos.
- `/goal stop` — encerra.

**O laço.** A cada fim de turno do terminal com objetivo ativo e não declarado:
manda `[Claudinei: goal]: Continue toward the goal: <critério>. Turn n/20. When
it is fully met, call goal_done with the evidence.` (cartão traduzido na tela).
Todo turno conta, inclusive os disparados por aviso de tarefa ou retomada.

**`goal_done` (Hermes).** `goal_done({ evidence })` marca o objetivo como
cumprido, guarda a evidência e encerra o laço. Sem objetivo ativo no terminal,
volta erro legível. A descrição diz que só o agente principal chama.

**Paradas.** O objetivo **pausa** (sem mensagem) quando: o operador manda
qualquer mensagem que não seja `/goal`; o turno termina com erro; o terminal
bate no limite de uso; o operador interrompe (Esc). Ao chegar a 20 turnos sem
`goal_done`, para com o motivo "teto". Pausado ou no teto, o terminal mostra um
aviso com o motivo e **Retomar** (= `/goal resume`).

*Fila do operador (decidido na integração da onda B):* o item enfileirado de
propósito (**Alt+Enter**) não pausa o objetivo: sai antes do continue (lugar 3
antes do 6), e o laço segue depois dele; o turno do item não conta. Já o
**Enviar agora** e o **Enter com o motor ocupado** (Kimi e OpenCode, em que o
Enter no meio do turno só pode ir à fila) são o operador falando: saem como
mensagem dele e pausam o objetivo uma vez, com o motivo "você mandou uma
mensagem". A interrupção que o Enviar agora faz no Kimi e no OpenCode não
pausa como Esc.

**À vista.** O estado do goal é do servidor (não vem do `update_progress` do
agente): a coluna de acompanhamento ganha um bloco "Objetivo" no topo (critério,
turno n/20, estado, evidência quando cumprido), e o cartão da lateral um selo
estático "🎯 n/20" (sem animação — AGENTS.md).

## Decisões de quem escreveu (o operador confere na leitura)

- **Aviso de tarefa e goal no mesmo fim de turno:** o aviso pendente tem
  prioridade; o "continue" sai no fim do turno seguinte. Nunca as duas mensagens
  juntas.
- **Goal e reinício:** o objetivo fica gravado. Com "retomar" ligado, a retomada
  do reinício conta como turno e o laço segue; desligado, o objetivo continua
  ativo e o laço só volta depois do Continuar.
- **Goal e limite de uso:** pausa ao bater o limite. Se a retomada na reabertura
  estiver armada (projeto 6), ela reativa o objetivo e conta como turno; senão o
  operador usa `/goal resume`.
- **Goal num terminal que delega:** o aviso da tarefa acorda o agente e o turno
  conta para o objetivo — é como o "pai acorda sozinho" do T3 em vários turnos.
- **Mensagens do Claudinei não pausam o goal** e não contam como mensagem do
  operador (o mesmo `sendAsClaudinei` do reinício).
- **Dispensar (×) um aviso de tarefa** não apaga o resultado: o agente ainda o
  lê em `list_tasks`.
- **Motor escondido (projeto 2):** o aviso vai ao motor de origem mesmo se ele
  estiver fora da lista; a aba aparece enquanto houver aviso pendente, como no
  aviso de reinício.

## Verificação

- Servidor: aviso entregue ao terminal de origem (livre, trabalhando → espera,
  parado com/sem "retomar", em limite, várias pendentes numa mensagem, reinício
  com aviso pendente); tarefa sem origem não acorda; corte em 4000 com o
  rodapé; nenhuma tarefa falha por tempo; `/goal` inicia/substitui/resume/stop;
  laço até `goal_done`; teto 20; pausas (operador, erro, limite, interrupção);
  prioridade do aviso sobre o "continue"; `goal_done` sem objetivo = erro.
- Web: cartões "Resultado da tarefa" e "Objetivo" traduzidos; aviso com
  Continuar/×; bloco Objetivo na coluna; selo na lateral sem animação.
- Ensaio numa instância isolada com o CLI falso (dois terminais: um delega, o
  outro termina; goal que termina com `goal_done` e um que bate o teto).

## Deixado para quem constrói

- Nomes de colunas, tabelas e o formato exato do estado do aviso e do goal.
- Os textos exatos (agente em inglês; tela em pt-BR, en, es).
- Como o CLI falso simula o `goal_done` nos testes.

## Decisões depois da revisão do desenho (de quem escreveu)

- **Goal esperando tarefas delegadas não gira em falso.** Enquanto o terminal do goal tiver tarefas suas em andamento ou na fila (`from_project_id` + `from_engine`), o laço **não** manda "continue": o goal fica "esperando tarefas" (estado visível na coluna e no selo) e não gasta turnos. O aviso do resultado acorda o terminal e conta como turno do goal; daí o laço volta.
- **Turnos que não são do goal não contam no teto**: tarefa de outro agente, agendamento e auto-compactação rodam no meio do goal sem consumir os 20 turnos.
- **Resultado pendente com o terminal no limite de uso:** fica guardado até o terminal voltar a trabalhar por iniciativa do operador ou da retomada armada do limite; o Claudinei nunca gasta tokens sozinho só para entregar um resultado. Com horário de reabertura desconhecido, segue guardado (aparece no aviso do limite: "1 resultado de tarefa esperando").

## Ordem única do "próximo envio" de um terminal (combinada entre as trilhas da onda B)

Quando um turno termina e a sessão fica livre, um único árbitro por terminal escolhe o que vai a seguir, nesta ordem:
1. auto-compactação (não conta como turno);
2. mensagem de retomada do Claudinei (reinício/limite), quando houver;
3. próximo item da fila do operador (projeto 5);
4. aviso de resultado de tarefa delegada por este terminal (projeto 10);
5. tarefa de outro agente para este terminal (fila existente do orchestrator);
6. "continue rumo ao objetivo" do goal (projeto 12) — sempre por último.
Enquanto houver aviso aberto esperando o operador (reinício sem retomada automática, ou limite), os itens 3 a 6 seguram. As duas trilhas implementam cada uma a sua parte respeitando esta ordem; a integração as junta num árbitro só.
