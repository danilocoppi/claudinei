# Bateu o limite — design

Projeto 6 do roteiro `docs/superpowers/roteiro-ideias-t3code.md`, inspirado no
"Resume at reset" e no "Snooze until reset" do T3 Code. Usa o projeto 1, o
reinício sem prejuízo (`server/src/restart/*`).

## Por quê

Quando o Claude bate no limite de uso, seja a janela de 5 h ou a semanal, o
turno para no meio e o terminal fica parado com uma mensagem de erro no chat.
O Claudinei não percebe:

- o terminal não ganha nenhum aviso;
- nada acontece quando a janela reabre;
- o agendamento que bate no limite é gravado como `ok`, com o texto do erro como
  resultado (`scheduler.ts:101-106`: `sendAndWait` resolve com qualquer
  `result`, inclusive de erro).

Hoje o operador precisa lembrar de voltar a cada terminal depois do horário de
reabertura e mandar "continue".

## Objetivos

1. Perceber, por terminal, que o turno parou porque o Claude bateu no limite, e
   saber quando a janela reabre.
2. Mostrar no terminal um aviso com dois botões:
   - **Continuar quando reabrir**: arma a retomada para o horário de reabertura;
   - **Adiar até reabrir**: tira o aviso do caminho até a reabertura, sem mandar
     nada.
3. Um interruptor por terminal, **desligado por padrão**: "Continuar sozinho
   quando o limite reabrir". Ligado, a retomada é armada sem clique.
4. Quando a janela reabre, a retomada armada envia ao agente uma mensagem fixa
   do Claudinei, e o turno continua.
5. O agendamento que bate no limite passa a ser gravado como erro, sem contar
   como falha seguida.

## Não-objetivos

- Detectar o limite no Codex, no Kimi e no OpenCode. Eles só informam o uso por
  consulta periódica e não avisam no turno. Fica para uma versão seguinte.
- Prever o limite antes de bater nele. O card de uso da lateral já mostra o
  ritmo.
- Trocar de motor para fugir do limite. Isso é do projeto 11.
- Reenviar a última mensagem do operador: a retomada usa a mensagem fixa.
- O agendamento tentar de novo na reabertura: a próxima execução acontece no
  horário normal dele.

## Anti-objetivos

- **Gastar tokens sem o operador querer.** Nada é enviado sem clique, exceto com
  o interruptor ligado, e ele vem desligado.
- **Ciclo de retomadas.** No máximo **uma tentativa automática por janela**. Se
  a retomada bater no limite de novo, volta o aviso e espera o operador.
- **Disparo em massa na reabertura.** Vários terminais armados para o mesmo
  horário não podem subir todos de uma vez: usam os lotes do projeto 1.
- **Armar retomada para um horário que já passou.** Se o horário de reabertura
  é desconhecido ou já passou, não há retomada armada, só o aviso com Continuar.

## Abordagens consideradas

1. **No servidor, no estado do terminal (escolhida).** O servidor detecta o
   limite no stream do Claude e guarda o estado na tabela `terminal_state` do
   projeto 1. Um relógio no servidor dispara na reabertura e é rearmado na
   subida, o que garante que a retomada funciona com o navegador fechado e
   depois de reiniciar o serviço.
2. No navegador. Descartada: nada acontece com a aba fechada, e cada aba
   aberta dispararia sozinha.
3. Como agendamento de uso único. Descartada: os agendamentos são do operador,
   aparecem na tela de Agendas e mandam texto livre. Misturar retomadas de limite
   ali polui a lista e não aproveita o aviso nem os lotes do projeto 1.

## Como (decidido com o operador)

### Detecção (só Claude nesta versão)

- **Sinal principal:** um `rate_limit_event` com `status: 'rejected'` chega no
  stream **daquele** terminal durante o turno. O `rate_limit_info` traz a
  janela e o `resetsAt` (ver `usage.ts:205-227`, que já lê esses campos para o
  card). A sessão guarda o maior `resetsAt` entre as janelas rejeitadas, em
  epoch segundos.
- **Confirmação:** o turno termina com `result` de erro. Se não chegou o evento,
  vale o casamento do texto do erro de limite no `result` ou na mensagem de
  assistant marcada `isApiErrorMessage`, no mesmo molde do `detectAuthExpired`
  (`claude/session.ts:565-577`). Nesse caso o horário vem da última janela
  `rejected` conhecida em `usage.ts`, ou fica desconhecido.
- A sessão expõe a marca como `usageLimit: { resetsAt: number | null }`, da mesma
  forma que `authExpired` chega ao `SessionInfo`. O manager grava o estado no
  terminal.

### Estado no terminal

- Colunas novas em `terminal_state`:
  - `limit_hit_at`;
  - `limit_resets_at`;
  - `limit_action`, com os valores `none` | `armed` | `snoozed`;
  - `limit_tries`;
  - `auto_resume_limit` (o interruptor, `DEFAULT 0`).
- **Conflito de nome:** `HoldReason 'limit'` já significa "retomado 3 vezes sem
  concluir" no projeto 1. Este estado é separado da marca de interrupção do
  reinício e usa o prefixo `limit_*` no banco e `usageLimit` no código e no
  DTO.
- Um terminal pode estar interrompido pelo reinício e com limite batido ao mesmo
  tempo. O limite manda: a retomada do reinício não envia nada enquanto
  `limit_resets_at` estiver no futuro.

### O aviso e os botões

- Usa o mesmo lugar e o mesmo estilo do aviso de interrompido
  (`InterruptedNotice`): acima do campo de mensagem, sem animação. O texto é
  "O Claude bateu no limite de uso. A janela reabre às 15:00 (daqui a 2 h 10
  min)." Com o horário desconhecido, a frase sobre a reabertura não aparece.
- **Continuar quando reabrir** muda para `armed`. O aviso passa a dizer
  "Retomada armada para 15:01" e ganha um botão **Cancelar**.
- **Adiar até reabrir** muda para `snoozed`, e o aviso some. O cartão da lateral
  mostra uma marca estática "limite até 15:00", do mesmo jeito da marca de
  interrompido. Na reabertura a marca some. Nada é enviado, e o terminal fica
  como estava.
- **Continuar agora** aparece sempre: manda a mensagem na hora, para quando o
  operador sabe que o limite já voltou.
- Com o interruptor ligado, a detecção já arma direto, e o aviso aparece em
  `armed`.
- Mandar qualquer mensagem pelo campo limpa o estado de limite, como no
  projeto 1.

### Na reabertura

- Um relógio no servidor dispara 60 s depois do `resetsAt` de cada terminal em
  `armed`. Na subida, os horários são relidos do banco e o relógio é rearmado.
  Um horário que já passou dispara já na subida, entrando nos lotes do projeto 1.
- O disparo reaproveita o caminho do `resumeTerminal` do projeto 1:
  - sobe a sessão, se não estiver de pé;
  - não envia se ela estiver trabalhando;
  - envia com `sendAsClaudinei`;
  - religa tarefas encaminhadas;
  - aumenta `limit_tries`.
- Se o limite ainda estiver ativo, ou se a retomada bater no limite de novo, o
  estado volta a `none` com o aviso. A segunda tentativa só acontece com clique.
- `limit_tries` zera quando um turno termina sem erro.

### A mensagem de retomada

- O texto ao agente é fixo e em inglês:
  `[Claudinei: resume after usage limit]: The usage limit window reopened. Continue where you left off; check the current state of the files before redoing anything.`
- No chat, ela aparece como cartão "Claudinei" com texto traduzido, no mesmo
  molde da mensagem do reinício (`applyEvent` reconhece o prefixo).

### Agendamentos

- Um turno de agendamento que termina por limite é gravado como `error`, com
  `countFailure: false` e erro "limite de uso do Claude" (mesmo tratamento do
  `RESTART_FAIL_TEXT`, `scheduler.ts:113`).
- O agendamento não tenta de novo na reabertura. O terminal recebe o aviso como
  qualquer outro, e o operador decide.

## Decisões de quem escreveu (o operador confere na leitura)

- Só o Claude nesta versão. É o único que avisa no turno e diz quando reabre.
- 60 s de folga depois do `resetsAt`, porque o relógio do servidor e o da conta
  podem divergir.
- Uma tentativa automática por janela.
- O agendamento não repete na reabertura: a próxima execução segue o horário.
- "Adiar até reabrir" só esconde o aviso e marca o cartão. Se o projeto 4 (triagem
  da lista) trouxer o "adiar" da lateral, os dois podem se alinhar depois; este
  projeto não depende dele.
- O limite tem prioridade sobre a retomada do reinício quando os dois acontecem
  juntos.
- O botão "Continuar agora" existe além dos dois pedidos.

## Verificação

- **Testes do servidor:**
  - detecção pelo `rate_limit_event` rejeitado e pelo texto do `result`, com o
    CLI falso ganhando os modos `limite` e `limite-sem-evento`;
  - transições `none`/`armed`/`snoozed`, incluindo cancelar;
  - relógio rearmado na subida e disparo atrasado;
  - teto de uma tentativa;
  - limite tem prioridade sobre o reinício;
  - agendamento gravado como erro sem contar falha;
  - uma mensagem do operador limpa o estado.
- **Testes da interface:**
  - aviso com horário e sem horário;
  - os três botões;
  - estado armado com Cancelar;
  - marca do cartão quando adiado;
  - interruptor no ⚙;
  - cartão do Claudinei traduzido.
- **Ensaio numa instância isolada (porta 9199) com o CLI falso:** limite batido,
  armar, relógio curto (o `resetsAt` do falso fica a 1 min) e retomada. Com o
  Claude real, só se houver um limite real à mão, porque não dá para provocar
  um limite sem gastar a janela.

## Deixado para quem constrói

- O texto exato que o Claude CLI escreve ao bater no limite. Conferir num
  transcript real em `~/.claude/projects` e cobrir as variantes conhecidas,
  "usage limit reached" e "You've hit your limit".
- Os nomes exatos das colunas e do campo no DTO de `terminal_state`.
- O formato da hora no aviso (local, 24 h no pt-BR).
- As chaves de i18n em pt-BR, en e es.
