# Mensagem no terminal errado — design

## Por quê

O operador às vezes manda, num terminal, uma mensagem que é de outro projeto.
O agente costuma perceber e entrega a tarefa ao outro terminal (`dispatch_task`
do Hermes), mas depois segue tratando o assunto alheio como se fosse dali — e
o terminal se contamina com um tema que não é dele. Nenhuma instrução diz ao
agente para perguntar antes nem o que fazer com o assunto depois.

## Objetivo

Quando uma mensagem não combina com o projeto (e o grupo/setor) do terminal, o
agente **não age**: pergunta ao operador, numa pergunta só, com quatro saídas:

1. **Encaminhar e esquecer aqui** — entrega ao projeto certo e, daqui em diante,
   desconsidera o assunto neste terminal.
2. **Encaminhar e seguir aqui também** — entrega e continua tratando o assunto.
3. **É daqui mesmo** — falso alarme; segue normalmente.
4. **Mandei errado, ignore** — não encaminha e desconsidera o assunto.

"Ignorar" = o agente passa a desconsiderar o assunto (decisão do operador). A
mensagem continua na conversa; não se barra nada antes do envio.

## Não-objetivos

- Classificar mensagens no Claudinei antes de entregá-las ao agente.
- Tela nova no Claudinei para isso (caminho 3, descartado).
- Mudar as sessões já abertas: a regra vale para sessões iniciadas depois.

## Anti-objetivos

- Perguntar à toa: mensagem ambígua ou que cita outro projeto de passagem
  (comparação, referência, pedido para consultar outro agente) **não** dispara a
  pergunta. Só quando o pedido em si parece ser trabalho de outro projeto.
- Encaminhar sem perguntar.

## Abordagens consideradas

1. **Regra no Hermes (escolhida pelo operador).** O servidor MCP Hermes, que
   todos os motores (Claude, Codex, Kimi, OpenCode) já carregam por sessão,
   passa a entregar um texto de orientação (`instructions` do MCP) com o projeto
   do terminal, o grupo/setor dele e os demais projetos, mais a regra acima. Um
   lugar só; risco: algum motor ignorar as `instructions` do MCP.
2. Regra no prompt de sistema de cada motor: mais firme, mas quatro
   implementações para o mesmo texto. Fica como plano B **só** para o motor que
   comprovadamente ignorar as `instructions`.
3. Ferramenta Hermes nova + painel do Claudinei com botões em todos os motores:
   experiência uniforme, bem mais trabalho. Descartada.

## Como (decidido)

- O Hermes, ao subir, busca na API do Claudinei quem é o projeto da sessão
  (nome, grupo, setor) e a lista dos outros projetos (nome, grupo, setor), e
  monta as `instructions` com isso e com a regra. Sem API (erro/timeout curto),
  sobe com a regra genérica, sem os nomes — nunca deixa de subir.
- A pergunta: no Claude, pela ferramenta de pergunta dele (`AskUserQuestion`),
  que o Claudinei já mostra com botões no painel de perguntas; nos outros
  motores, em texto, com as quatro opções numeradas.
- Ao encaminhar, usa `dispatch_task` com a mensagem do operador reescrita de
  forma autocontida (o outro agente não vê esta conversa).
- Depois de "esquecer"/"ignore", o agente não retoma o assunto por conta própria
  e, se o operador voltar a ele, pergunta de novo em vez de assumir.

## Verificação

- Testes do Hermes: as `instructions` trazem o projeto, o grupo/setor, os outros
  projetos e a regra; sem API, sobem com a regra genérica.
- Conferir em cada motor (CLI real, conversa curta e barata) que a orientação
  chega: mensagem claramente de outro projeto → o agente pergunta em vez de agir.
  Motor que ignorar → plano B só nele.

## Deixado para quem constrói

- O texto exato da regra (curto, em inglês como as descrições das ferramentas,
  pedindo que a pergunta saia no idioma do operador).
- O formato do endpoint que entrega projeto/grupo/setor ao Hermes.
