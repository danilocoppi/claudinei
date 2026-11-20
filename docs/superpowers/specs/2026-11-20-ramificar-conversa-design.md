# Ramificar a conversa — desenho

Projeto 11 do roteiro `docs/superpowers/roteiro-ideias-t3code.md` (inspirado na conversa lateral, no fork e no
"portable handoff" do T3 Code). Três peças numa trilha só, que dividem duas ferramentas: a **cópia nativa** da
conversa (Claude, Codex e OpenCode sabem fazer) e o **pacote de contexto** (para o Kimi, que não sabe, e para levar a
conversa a outro motor).

## Por quê

- Uma pergunta de lado ("o que essa função faz mesmo?") hoje vai para a conversa principal: suja o contexto, gasta
  janela e, no meio de um turno, atrapalha.
- Tentar um caminho alternativo exige abrir outro terminal e reexplicar tudo.
- Trocar de motor (o Claude bateu no limite, o Codex é melhor nisso) começa do zero: cada aba tem a sua conversa.

Nada disso existe no código: um terminal tem uma conversa viva por motor (`server/src/claude/manager.ts:812-822`), e a
única ponte entre conversas é o operador copiando texto.

## Objetivos

1. `/side <pergunta>` (ou `/btw`): uma cópia descartável da conversa, no mesmo motor, numa coluna à direita do chat;
   **Trazer de volta** leva só a resposta final para a principal.
2. `/fork [nome]`: um terminal novo na mesma pasta, com a cópia da conversa até aquele ponto.
3. **Continuar noutro motor**: o motor novo recebe as mensagens recentes inteiras (até ~16 mil tokens) e a
   referência da conversa original, para buscar o resto se precisar.

## Não-objetivos

- Várias laterais ao mesmo tempo; guardar a lateral depois de fechada; resumo gerado por modelo no pacote.
- Mudar a regra de uma conversa viva por terminal+motor; atalhos de teclado globais novos (são do projeto 14).

## Anti-objetivos

- A lateral mexer na principal: nada dela entra no transcript, na fila, no goal ou na posse de conversas
  (`recordThread`), nem vira "a mais recente da pasta" no `--continue`.
- Gastar tokens sem pedido: só a troca de motor e o `/fork` que cai no pacote (Kimi, ou cópia nativa recusada)
  mandam uma mensagem sozinhos, e os dois são pedidos explícitos do operador.
- Animação nova ou peso sem GPU (AGENTS.md): a coluna lateral não tem rostinho.

## Desenho

### 1. A cópia por motor

Conferido no `--help` de cada CLI e nos tipos gerados do Codex 0.159 (`codex app-server generate-ts`):

| Motor | Como copia | Corte no meio do turno | Lateral "só leitura" |
|---|---|---|---|
| Claude | `--resume <id> --fork-session` | `--resume-session-at <msg>` (flag oculta) | modo `plan` + `--disallowed-tools Edit Write NotebookEdit`; o shell ainda pode escrever |
| Codex | `thread/fork` | `lastTurnId` | `sandbox: 'read-only'` — garantido |
| OpenCode | `run --fork -s <id>` | não tem: usa o pacote | `--agent plan` (nega edição); o shell ainda pode escrever |
| Kimi | não tem: usa o pacote | — | nenhuma: só aviso |

- **No meio de um turno da principal**, a cópia vai **até o último turno fechado**; o que está em andamento não entra.
  Se a CLI recusar a cópia nativa (versão sem a flag, trava de escrita do Codex), cai no pacote, como o Kimi.
- `EngineSessionOptions` (`server/src/engine/types.ts`) ganha `forkFrom` (id de origem + ponto de corte), `readOnly`,
  `ephemeral` e `sessionId` (id escolhido pelo Claudinei); `EngineCapabilities` ganha `fork: 'native' | 'seed'`.
- `Engine` ganha `transcriptRef(projectPath, id)`: o caminho do arquivo da conversa (transcript do Claude, rollout do
  Codex, `wire.jsonl` do Kimi) ou, no OpenCode, o comando `opencode export <id>`.

### 2. O pacote de contexto

Módulo novo `server/src/branch/handoff.ts`, puro e testável:

- Lê o histórico pelo `readPage` (`server/src/history-page.ts:33`), de trás para a frente, a partir do último turno
  fechado, e junta **mensagens inteiras** até ~16 mil tokens (4 caracteres por token: 64 mil caracteres) e no máximo
  100 KB (abaixo dos 120 KB por mensagem do Kimi e do OpenCode).
- Texto do operador e do agente entram inteiros; cada chamada de ferramenta vira uma linha (`→ Bash: npm test`); o
  resultado dela, até 300 caracteres; raciocínio (thinking) fica de fora.
- Mensagem nunca é cortada ao meio, salvo a mais recente quando sozinha passa do orçamento (entra o fim, marcado
  "(início cortado)"). Numa conversa compactada, o resumo da compactação é a mais antiga e a leitura para ali.
- Texto em inglês para o agente, com selo que a tela reconhece: `[Claudinei: context handoff]: This conversation
  continues one held with <Motor> in this same folder. Below are its N most recent messages, whole, oldest first
  (about T tokens). The full conversation is at <referência>; read it only if you need something older. If no request
  follows, reply with one short line confirming you have the context.` Na tela vira o cartão "Contexto trazido do
  <Motor>: N mensagens (~T mil tokens)", dobrado.

### 3. Conversa lateral (`/side`, `/btw`)

**Abrir.** O servidor intercepta `/side` e `/btw` em `manager.send`, como o `/goal` (`manager.ts:880`), inclusive
vindos da fila. Não vão ao agente principal e não contam como mensagem do operador (não pausam o goal). Com texto,
abrem a coluna e mandam a pergunta; sozinhos, abrem a coluna vazia. Sem conversa para copiar (sessão nova, sem id):
"Ainda não há conversa para copiar". Um `/side` com outra lateral aberta pergunta "Fechar a conversa lateral atual e
abrir outra?": é **uma por terminal+motor**.

**Onde roda.** Módulo novo `server/src/branch/side.ts`, um registro em memória à parte: a lateral **não** tem linha em
`sessions` nem entra no `live` do manager, no árbitro do próximo envio, no `recordThread`, nos avisos de reinício e de
limite, na seção "Trabalhando" ou nas notificações. Usa o `createSession` do motor com `forkFrom`, `readOnly`,
`ephemeral`, o modelo e o esforço atuais da principal, e **sem Hermes** (sem `update_progress`, `dispatch_task`,
`goal_done` nem a regra de acompanhamento). Por isso está **fora da ordem do próximo envio**.

**Sem rastro no disco.** Claude com `--no-session-persistence`; Codex com `ephemeral: true`. O OpenCode grava a cópia:
ao fechar, o Claudinei roda `opencode session delete <id>`, e enquanto ela existe entra no conjunto de exclusão do
`latestConversationId`. O Kimi roda num data root só da lateral (ao lado do `kimiHomeFor`,
`server/src/engine/kimi/kimi-home.ts:33`), apagado ao fechar. A tabela `side_threads` anota o que precisa de limpeza;
na subida do serviço, o que sobrou de uma queda é apagado.

**Principal no meio de um turno.** Pode abrir: a cópia vai até o último turno fechado e as duas rodam em paralelo.
**Kimi (e toda lateral que cai no pacote):** a primeira mensagem é o pacote seguido da pergunta, sem turno a mais.
**Arquivos.** A lateral roda na mesma pasta e é sempre "só leitura" no nível que o motor permite (tabela da seção 1).
O cabeçalho da coluna diz qual: "Só leitura" (Codex); "Sem ferramentas de edição — comandos de shell ainda podem
alterar arquivos" (Claude, OpenCode); "Pode alterar arquivos da pasta" (Kimi).

**A coluna (web).** Abre à direita do chat no lugar da `ProgressColumn` (`web/src/components/ChatView.tsx:609`), que
volta quando a lateral fecha; no celular, cobre o chat. Cabeçalho: "Conversa lateral", motor, "cópia até HH:MM", o
aviso de arquivos e ×. Corpo: as mensagens com os mesmos componentes do chat e o ponto de status estático
(`dotClassOf`), sem rostinho nem animação nova. Embaixo, um campo simples (texto e anexos, sem fila): no Claude e no
Codex aceita mensagem no meio do turno; no Kimi e no OpenCode fica desabilitado enquanto trabalha; o Parar interrompe
só a lateral. O servidor guarda em memória os eventos da lateral (até 2 MB), e recarregar a página reabre a coluna
como estava. Trocar de aba de motor mostra a lateral daquele motor, se houver. **Fechar:** × na coluna (confirma só se
ela estiver trabalhando), ou a sessão principal encerrada, o terminal excluído, o serviço reiniciado. Fechar mata o
processo e descarta a cópia.

**Trazer de volta (decidido: rascunho no campo).** Botão no pé da coluna, ativo quando o último turno da lateral
terminou. Acrescenta ao **campo da conversa principal**, depois do que já houver (nunca substitui):

    Da conversa lateral («<pergunta, até 80 caracteres>»):
    <texto da última resposta do agente na lateral>

Só o texto final, sem chamadas de ferramenta; acima de 10 KB ou 100 linhas, vira o anexo `lateral-<hora>.md`, pela
regra do colar grande (`web/src/paste.ts`). A lateral continua aberta. Por que rascunho e não a fila: a resposta é
matéria-prima, e o operador quase sempre quer cortar ou juntar uma instrução; ir direto para a fila (lugar 3) mandaria
texto não revisado e, como "mensagem do operador", ainda mexeria no goal. Como rascunho, **não entra na ordem do
próximo envio**: o operador usa as teclas de sempre (Enter entra no turno atual no Claude e no Codex; Alt+Enter manda
para a fila).

### 4. Ramificar (`/fork [nome]`)

**O que faz.** Interceptado como o `/side`. Cria um terminal novo na **mesma pasta** e uma sessão nele com a cópia
até o último turno fechado. O original segue como estava, mesmo trabalhando. Cada terminal continua com uma conversa
viva por motor. Criar terminal é de admin (`server/src/routes/projects.ts:61`), e o `/fork` também; para os outros:
"Só um administrador pode criar terminais".

**Nome e lugar.** `/fork nome` usa o nome dado; sem nome (ou só espaços), "<original> (ramo)", depois "(ramo 2)" e
assim por diante. Entra logo abaixo do original na lateral, no mesmo grupo e setor, com a mesma cor e o mesmo ícone.
O cabeçalho do chat mostra "ramo de <original>" (coluna nova `projects.forked_from`). A web abre o terminal novo.

**O que herda.** Do terminal: lista de motores (com o motor do ramo garantido nela), cor, ícone, grupo, setor e o
interruptor de avisos. Da sessão viva: motor, modelo, esforço e modo de permissão. **Não herda**: goal, fila do
operador, agendamentos, acompanhamento, tarefas, fixado/triagem, "iniciar com o Claudinei" e "retomar trabalho
interrompido" (desligados).

**Posse da conversa.** Com dois terminais na pasta, os dois passam a usar a conversa própria no lugar do `--continue`
(o `ownResume` da pasta compartilhada, que já existe). No Claude, o Claudinei escolhe o id da cópia de antemão
(`--session-id <uuid>` com `--fork-session`, combinação que a CLI aceita) e o grava na hora; no Codex, o `thread/fork`
devolve o id na partida; no OpenCode, o id sai no primeiro turno (`--fork` só roda com mensagem). Até o primeiro turno
gravar a cópia, a sessão guarda de onde copiar (`sessions.fork_source`): revivida antes disso, copia de novo; e o chat
mostra o histórico do original até o ponto de corte, para não abrir vazio.

**Kimi (e todo `/fork` que cai no pacote).** O terminal novo abre uma conversa nova e recebe o pacote como mensagem do
Claudinei, no lugar 2 da ordem (seção 5).

**Pasta compartilhada.** O ramo e a lateral rodam na pasta do original; a regra de pasta compartilhada é do projeto 9.

### 5. Continuar noutro motor

**Onde fica.** Na aba do motor ativo (`web/src/components/EngineTabs.tsx`), um botão ⇄ ao lado do ⏻: "Continuar
noutro motor". Abre um menu no padrão do "+" (`.sess-pop`) com os outros motores instalados da lista do terminal, cada
um com o estado: "sem conversa"; "ocioso — a conversa atual será encerrada (fica no histórico)"; "trabalhando —
indisponível"; "no limite até HH:MM — indisponível".

**O que acontece.** Rota nova `POST /api/projects/:id/handoff { from, to }`: (1) monta o pacote a partir da conversa
de origem; (2) se o destino tem sessão ociosa, encerra-a (a web confirma antes); (3) abre uma conversa **nova** no
destino (`continueLatest: false`); (4) manda o pacote com `sendAsClaudinei`. A web muda para a aba do destino, onde
aparece o cartão "Contexto trazido do <Motor>". A origem segue viva e como estava; o menu lembra "o <origem> continua
aberto; pare-o se não quiser os dois na pasta". Goal e fila são por terminal+motor e **não** passam para o destino.

**Na ordem do próximo envio.** O pacote é a primeira mensagem da conversa nova e sai na criação, no **lugar 2**, ao
lado da retomada do Claudinei: é mensagem do Claudinei que ocupa a sessão, e uma conversa nova nunca tem retomada
pendente. Os lugares 3 a 6 só vêm depois do turno dele. Se o operador escrever no destino enquanto o pacote roda: no
Claude e no Codex a mensagem entra no mesmo turno (e o agente já responde com o contexto); no Kimi e no OpenCode, vai
para a fila (lugar 3). Destino no limite é recusado antes, então nunca há pacote esperando aviso.

### Dados

- `side_threads (id, project_id, engine, thread_id, created_at)`: só para limpar cópias do OpenCode e do Kimi depois
  de uma queda; o estado vivo da lateral fica em memória. `projects.forked_from` (nulo, `ON DELETE SET NULL`).
- `sessions.fork_source` (JSON: motor, id de origem, ponto de corte), limpo quando o primeiro turno grava a cópia.

## Erros e bordas

- A CLI recusa a cópia nativa: cai no pacote ("cópia pelas mensagens recentes"). Falha de vez: erro como de sessão morta.
- A lateral bate no limite de uso: o erro aparece só na coluna; nada vai para o estado do terminal.
- Pacote acima de 100 KB mesmo com uma mensagem só: corta o início da mais recente até caber.
- `/side`, `/btw` e `/fork` sombreiam os comandos de mesmo nome dos CLIs (o `/btw` do Claude Code, o `/fork` do Codex),
  que no chat sem TUI não servem.
- Reinício do serviço: a lateral aberta some e a subida limpa o que sobrou; um ramo antes do primeiro turno refaz a
  cópia pelo `fork_source`. Sessão no terminal interativo: sem campo, sem `/side` nem `/fork`.

## Testes

- Servidor, argumentos: Claude da lateral (`--fork-session`, `--no-session-persistence`, `--disallowed-tools`, modo
  `plan`, sem `--mcp-config`) e do ramo (`--session-id`); `--resume-session-at` só no meio do turno; Codex
  (`thread/fork` com `sandbox: 'read-only'`, `ephemeral`, `lastTurnId`); OpenCode (`--fork`, `--agent plan`).
- Servidor, pacote: orçamento, mensagens inteiras e em ordem, ferramentas, corte da mais recente, teto de 100 KB,
  referência por motor, resumo da compactação, último turno fechado.
- Servidor, lateral: `/side` e `/btw` interceptados (também da fila) sem mensagem à principal nem pausa do goal; uma
  por terminal+motor; fechar mata e limpa; encerrar a principal fecha a lateral; limpeza na subida; exclusão no
  `latestConversationId`; nada em `sessions` nem em `project_threads`.
- Servidor, ramo: nome e sufixo, posição, grupo e setor, herança, só admin, `fork_source` refeito, prévia, Kimi.
- Servidor, troca de motor: destino trabalhando ou no limite recusa; ocioso é encerrado; pacote antes da fila.
- Web: `side`, `btw` e `fork` no autocompletar (`web/src/slash.ts`); coluna no lugar da de acompanhamento; aviso de
  arquivos por motor; Trazer de volta (acrescenta, vira anexo, desligado trabalhando); menu ⇄; cartão; "ramo de".
- Ensaio em instância isolada com o CLI falso: lateral com a principal trabalhando, Trazer de volta, `/fork`, troca de
  motor. O que o falso não prova (`--resume-session-at`, `--no-session-persistence` com `--fork-session`, `thread/fork`
  com a conversa aberta noutro processo) pede um ensaio curto com o CLI real, só com autorização (gasta tokens).

## Fora do escopo / depois

- Lateral em outro motor (o pacote já permitiria); "ramificar daqui" numa mensagem antiga; "merge back" do ramo.
- Consumo da lateral na página de uso: Claude e Codex efêmeros não deixam arquivo, então não aparecem lá.
- Lateral só leitura no Kimi, se o `--plan` combinar com `-p` (não dá para conferir sem gastar tokens).

## Decisões de quem escreveu (o operador confere na leitura)

- **Trazer de volta vira rascunho no campo**, não item da fila (motivo na seção 3).
- **A lateral é sempre só leitura no nível que o motor deixa, e roda sem Hermes.** Só o Codex garante; Claude e
  OpenCode perdem as ferramentas de edição; o Kimi só avisa.
- **No meio do turno, a cópia vai até o último turno fechado.** No OpenCode, sem ponto de corte, isso força o pacote.
- **O pacote é uma mensagem própria do Claudinei** (um turno curto de confirmação), não grudado na primeira mensagem
  do operador. Destino ocioso tem a conversa encerrada; trabalhando ou no limite, recusa.
- **O `/fork` abre o terminal novo**, "<original> (ramo)", logo abaixo do original; só admin.
