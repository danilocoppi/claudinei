# Desfazer o que o agente fez — desenho

Projeto 9 do roteiro `docs/superpowers/roteiro-ideias-t3code.md`: ponto de
restauração por turno, diff do turno e "editar a partir daqui". Inspirado no T3
Code, que grava o estado dos arquivos em refs Git ocultas ao fim de cada turno.

## Por quê

- **Não há como voltar atrás.** Quando o agente estraga arquivos, o operador
  desfaz na mão, pelo `git`, sem saber ao certo o que aquele turno mexeu.
- **O diff de hoje engana.** O cartão da ferramenta mostra o `old_string`/
  `new_string` que o agente mandou (`web/src/components/ToolCallCard.tsx:32`), não
  o arquivo de verdade; o Write aparece como diff a partir do vazio. O que o Bash,
  um gerador de código ou o `npm` mudam não aparece em lugar nenhum. O Codex manda
  `file_change` sem diff na tela; Kimi e OpenCode, nada reconhecido.
- **"Editar mensagem" promete o que não faz.** O texto diz que a conversa
  "recomeça dela" (`web/src/i18n/en.ts:267`), mas `requestEdit`
  (`web/src/store.ts:648`) só copia o texto para o campo; a mensagem nova entra no
  fim da mesma conversa.
- **O limite conhecido.** No T3, reverter arquivos só vale em worktree isolado. No
  Claudinei vários terminais trabalham na mesma pasta: reverter às cegas apaga o
  trabalho de outro agente.

## Objetivos

1. **Diff do turno** em toda pasta com git: quais arquivos o turno mudou, com +/−
   e o conteúdo, incluindo o que mudou via Bash.
2. **Desfazer turno**: volta só os arquivos daquele turno ao estado de antes dele.
   Se alguém mexeu depois no mesmo arquivo, pergunta arquivo por arquivo,
   mostrando a diferença. Nunca sobrescreve calado.
3. **Editar a partir daqui** com duas opções: "voltar só a conversa" ou "voltar a
   conversa e os arquivos", usando o mecanismo de cada motor.
4. Nas pastas sem git, mostrar o que o turno mudou quando o agente declarou, sem
   desfazer.

## Não-objetivos

- Restaurar a pasta inteira, desfazer commits ou mexer no histórico do branch.
- Usar o checkpoint próprio do Claude (`rewind_files`, `--rewind-files`): ele só
  cobre as ferramentas de edição do Claude, não o Bash, e não existe nos outros
  motores. O retrato do git vale igual para os quatro.
- Backup de arquivos em pasta sem git.
- Arquivos ignorados pelo `.gitignore` (`node_modules`, `dist`, `.env`): ficam
  fora do retrato, do diff e do desfazer.

## Anti-objetivos

- Commit no branch do operador, mexer no índice dele (`git add`), no stash ou em
  `HEAD`.
- Atrasar o envio da mensagem ao agente por causa do retrato.
- Encher o `.git` do operador com gigabytes de arquivos não rastreados.
- Interface pesada sem GPU: nada de animação; o diff só carrega ao abrir.

## Abordagens consideradas

1. **Retrato do git com índice temporário e refs ocultas (escolhida, decisão 3a).**
   Pega tudo que mudou na pasta, inclusive via Bash, e não toca no que o operador
   usa no git.
2. Checkpoint nativo de cada motor. Só o Claude tem, só para as ferramentas dele.
   Descartada.
3. Cópia de arquivos numa pasta do Claudinei. Reinventa o git e não serve para
   pastas grandes. Descartada.

## Desenho

### O retrato (servidor)

Um módulo novo (`server/src/checkpoint/`) tira o **retrato** de uma pasta com plumbing do git, sem tocar no que o operador usa:

- índice próprio em `<git-dir>/claudinei-index` (via `GIT_INDEX_FILE`), semeado da primeira vez com uma cópia do índice do operador, para o git só reler os arquivos que mudaram;
- `git add -A` nesse índice (respeita o `.gitignore`, inclui não rastreados), `git write-tree`, `git commit-tree` e `git update-ref refs/claudinei/<pasta>/<n>`;
- `<pasta>` é um hash do caminho real do topo do repositório (`git rev-parse --show-toplevel`). Worktrees ligados ao mesmo repositório têm chaves diferentes;
- cada retrato guarda também o `HEAD` e o branch do momento.

A unidade é o **repositório**, não o terminal: um terminal em `/repo` e outro em `/repo/server` são a mesma pasta para tudo que segue. O retrato cobre o repositório inteiro, porque o agente às vezes mexe fora da subpasta dele.

Os retratos de um mesmo repositório passam por uma fila única no servidor (um por vez). Medido nos maiores repositórios do operador (até 2.219 arquivos rastreados): `git status` leva de 7 a 18 ms.

**Quando.** O Claudinei tira um retrato, chamado **marco**, a cada início e a cada fim de turno de qualquer terminal daquele repositório. O início é quando a sessão passa a `working`, sem esperar: o agente não mexe em arquivo antes da primeira resposta do modelo, que leva segundos. Se a primeira chamada de ferramenta do turno chegar antes de o marco de início ficar pronto, o turno fica marcado "retrato atrasado": o diff aparece com esse aviso, e o desfazer fica desligado. O fim de turno é qualquer fim: `result`, interrompido, cortado sem `result` (`onCutEnd`), sessão morta ou parada. Compactação não gera marco.

### O que entra no retrato e o custo

- Arquivos rastreados: sempre.
- Não rastreados e não ignorados: entram se tiverem até 2 MB cada. Os maiores ficam fora; o diff lista o caminho e o tamanho ("grande demais para o retrato"), sem desfazer.
- **Pasta com muito arquivo solto.** Se os não rastreados passarem de 5.000 arquivos ou 200 MB, a pasta entra em **retrato limitado**. Caso real: uma pasta do operador tem 29.484 arquivos soltos, que somam 8,9 GB. No modo limitado, o marco de início guarda o conteúdo dos rastreados e só a lista de caminhos, tamanhos e datas dos soltos. O de fim guarda também os soltos **criados** no turno (até 2 MB cada). Um solto que já existia e mudou aparece no diff como "mudou, sem retrato", sem desfazer. A tela explica: "Esta pasta tem muitos arquivos fora do git; ponha-os no .gitignore para o retrato completo". A contagem é refeita a cada marco (só listar, sem ler conteúdo).
- Submódulos: o retrato guarda só o commit apontado. O que muda dentro deles aparece como "submódulo mudou", sem desfazer.
- Filtros do repositório (LFS, `autocrlf`) agem como num `git add` normal.

**Retenção.** Um marco fica enquanto algum turno guardado o usar. Ficam os turnos dos últimos 30 dias, até 200 por terminal. Terminal excluído perde os dele. A limpeza roda na subida do serviço e uma vez por dia: apaga as refs, e o próprio `git gc` do operador libera o espaço depois (refs fora de `refs/heads` não ganham reflog, então nada segura os objetos). O Claudinei nunca roda `gc` na pasta do operador.

### Vários terminais na mesma pasta

Os marcos formam uma **linha do tempo do repositório**. Entre dois marcos seguidos há um **intervalo**, e o servidor sabe quais turnos estavam ativos em cada um. A mudança de um arquivo num intervalo pode ser:

- **do turno**: só aquele turno estava ativo no intervalo;
- **compartilhada**: havia outros turnos ativos. Ela é do turno se as ferramentas dele declararam aquele caminho (Edit/Write/MultiEdit do Claude, `fileChange` do Codex, as de edição do OpenCode e do Kimi quando trazem o caminho) e as dos outros não. Senão fica **incerta**;
- **fora de turno**: nenhum turno ativo. É o operador no editor, um subagente ou Bash em segundo plano depois do `result`, ou outro programa.

O diff do turno mostra o que é dele e, à parte, "Pode ser de outro terminal", com as incertas. As mudanças fora de turno aparecem como um bloco próprio entre os turnos ("Mudanças entre turnos"), só para ver. Subagentes que rodam dentro do turno (Task do Claude, subagentes do Codex) contam como o turno: o diff não separa o que cada um fez. O terminal derivado do projeto 11 (`/fork`) é só mais um terminal na mesma pasta; a regra não depende de quem nasceu de quem.

### Diff do turno (web)

- No fim de cada turno com mudanças, uma linha discreta: "3 arquivos · +40 −12 · Ver mudanças · Desfazer".
- **Ver mudanças** abre um painel com a árvore de arquivos (+/− por arquivo) e o diff de cada um, buscado no servidor só ao abrir. Para no limite de 2.000 linhas por arquivo, com aviso; arquivo binário mostra "binário, N KB".
- O diff sai de `git diff-tree` entre os marcos, por arquivo. O servidor ganha rotas para o resumo por turno, o diff de um arquivo e o desfazer. O resumo vai junto com o fim do turno pelo WebSocket.

### Desfazer turno

Para cada arquivo do turno, o servidor compara três versões: **antes** (marco de início), **depois** (marco de fim) e **agora** (a pasta):

- agora = depois: volta ao "antes". Se o arquivo não existia antes, apaga. Também volta o bit de execução;
- agora = antes: já está desfeito e fica como está;
- agora diferente dos dois: **conflito**. A tela mostra o que mudou desde o turno e oferece "desfazer só as linhas do turno" (um `git merge-file` do inverso; só aparece quando dá certo sem conflito), "voltar ao antes mesmo assim (perde o que mudou depois)" ou "manter como está". Um arquivo de cada vez.

**Antes de escrever**, uma tela lista os arquivos que vão voltar, os incertos (desmarcados; o operador marca um a um, vendo o diff) e os conflitos. Ninguém do repositório pode estar no meio de um turno. Se algum terminal estiver `working`, o botão fica desligado com "Esperando o turno de <terminal> terminar". O mesmo vale para terminal aberto em "Abrir no terminal" naquela pasta, porque o Claudinei não vê os turnos dele. Durante a escrita, o servidor segura o início de turnos no repositório (alguns segundos, no máximo).

**Refazer.** Logo antes de escrever, o servidor tira um marco "antes do desfazer". O cartão do turno ganha **Refazer**, que volta esses arquivos com as mesmas três comparações.

Turno antigo pode ser desfeito mesmo com turnos depois dele. Os arquivos que os turnos seguintes mexeram caem em conflito e são perguntados.

**Commit ou checkout no meio.** A comparação é com a pasta, não com o `HEAD`. Se o operador comitou o turno, o desfazer volta os arquivos e deixa a mudança sem commit, para ele comitar a reversão. Se trocou de branch, os arquivos diferentes viram conflito. A tela avisa no topo: "O branch mudou desde o turno (era X, agora Y)". O desfazer nunca roda `git` que mexa em branch ou índice.

**O agente fica sabendo.** Depois de desfazer só os arquivos, a próxima mensagem ao terminal, venha de onde vier, leva na frente uma nota curta do Claudinei: `[Claudinei: files reverted]: The operator reverted the file changes of an earlier turn: <arquivos>. Re-read them before editing.` A nota não é um envio próprio e não entra na ordem do próximo envio.

### Editar a partir daqui

Na mensagem do operador, **Editar** abre o texto para edição com duas escolhas: **Voltar só a conversa** e **Voltar a conversa e os arquivos**. A segunda desfaz os arquivos de todos os turnos daquela mensagem até o último. Cada arquivo volta ao estado do início do primeiro turno do trecho que o mexeu, com as mesmas três comparações e a mesma tela. Sem git, ou sem retrato em algum desses turnos, ela fica desligada com o motivo. A ordem é: arquivos primeiro (cancelar ali não faz nada), depois a conversa, depois o envio do texto editado. Com o agente trabalhando, a tela avisa que vai interromper o turno antes, como hoje. O aviso enganoso some.

Por motor (confirmado no `--help`, no binário instalado ou no protocolo gerado com `codex app-server generate-ts`; sem abrir sessão):

- **Claude (2.1.328).** Reabre a sessão com `--resume <id> --resume-session-at <uuid> --fork-session`, em modo `-p`, que é como o Claudinei já roda (`server/src/claude/session.ts:80`). Os dois primeiros são opções escondidas do `--help`: "only messages up to and including the chain entry with <message.id>". O `<uuid>` é a última entrada do transcript antes da mensagem editada. O `--fork-session` deixa o transcript antigo intacto, e a sessão ganha id novo. O id novo só vai para o banco depois que o primeiro turno dele responder, para não cair no "resume de id fantasma". Editar a primeira mensagem abre uma sessão nova. Quando o trecho descartado é só o último turno, o `--resume-drops-turn <uuid do prompt>` serve de trava extra: ele recusa se houver mensagem enfileirada ou aviso de tarefa no meio.
- **Codex (0.159.2).** `thread/revert { threadId, beforeTurnId }` no app-server. Ele troca o histórico pelo trecho antes daquele turno e não mexe em arquivos. Se a conversa for do formato antigo e recusar, usa `thread/fork { threadId, lastTurnId }` com o turno anterior e passa o terminal para o id novo. O id do turno sai do `turn/started` (`codex-session.ts:237`) ou do `thread/turns/list`.
- **OpenCode.** O `opencode run` que o Claudinei usa não tem como voltar a conversa. O binário traz `/session/{id}/fork` e `/session/{id}/revert` no servidor HTTP dele. O revert do OpenCode também mexe nos arquivos e não passa por estas regras, então não é usado. O plano começa com um ensaio do fork numa mensagem com `opencode serve` temporário. Se der certo, "voltar só a conversa" vira fork e o terminal segue com `--session <id novo>`. Se não der, as duas opções ficam desligadas.
- **Kimi (0.38.0).** O `/undo` e o `/fork` existem só dentro da interface do próprio Kimi. O `kimi -p` não tem como voltar a conversa. As duas opções ficam desligadas.

**Motor sem volta da conversa.** As duas opções aparecem desligadas, com "O <motor> não deixa o Claudinei voltar a conversa". Sobra **Copiar para o campo**, que é o comportamento de hoje com o nome certo. O **Desfazer** do turno continua valendo, porque não depende do motor.

**Mensagens que acompanham a volta.** "Voltar só a conversa" com turnos que mexeram arquivos manda junto com o texto editado: `[Claudinei: conversation rewound]: Files still contain changes made after this point.` O texto editado sai como mensagem do operador, na hora, sem passar pelo árbitro do próximo envio, como um Enter com a sessão livre. Por isso pausa o goal, como qualquer mensagem do operador. A fila do operador fica como está. Enquanto a volta roda, o terminal fica ocupado, e o árbitro não entrega nada no meio.

### Ordem do próximo envio

Nada deste projeto entra na ordem de `server/src/queue/next-send.ts`. O desfazer não manda mensagem. As duas notas (`files reverted`, `conversation rewound`) vão grudadas na mensagem seguinte, e o texto editado é um envio direto do operador.

### Pastas sem git (decisão 5a)

Não há retrato nem desfazer. No fim do turno aparece "Mudanças declaradas pelo agente", com os arquivos que as ferramentas declararam e o diff quando ele existe:

- Edit/MultiEdit do Claude: o diff vem dos trechos enviados;
- Write do Claude: aparece como "arquivo escrito", sem diff falso;
- Codex: o `diff` do `fileChange`;
- OpenCode e Kimi: o diff quando a ferramenta traz o texto antigo e o novo; senão só o caminho.

O aviso fixo diz: "Sem git: mudanças feitas por comandos não aparecem e não dá para desfazer". Se nenhuma ferramenta declarou nada, a linha não aparece.

### Dados

Tabelas novas (os nomes ficam para quem constrói):

- **marcos**: repositório, número, ref, commit, `HEAD`/branch, modo (completo ou limitado), turnos ativos e hora;
- **turnos**: sessão, projeto, motor, origem (operador, Claudinei, tarefa, agendamento, goal), marcos de início e fim, tipo de fim (`result`, interrompido, cortado, morto, reinício, fim incerto), âncora no motor (uuid do Claude, turno do Codex, mensagem do OpenCode), estado do retrato (ok, atrasado, limitado, falhou e por quê) e o resumo (+/−, arquivos);
- **desfazeres**: turnos, arquivos e resultado de cada um, marco "antes do desfazer" e se foi refeito.

## Erros e bordas

- **Retrato falhou** (sem `git`, disco cheio, `.git` só de leitura, repositório corrompido): o turno segue normal; a linha diz "sem ponto de restauração" e o motivo. Nunca bloqueia o turno.
- **Serviço caiu no meio do turno**: na subida, o turno aberto ganha o marco de fim na hora e o fim "incerto". O diff tem esse aviso; o desfazer funciona com as três comparações, que protegem do que mudou depois.
- **Abrir no terminal** (`in_terminal`): o Claudinei tira um marco ao abrir e outro ao voltar. Tudo no meio vira um bloco "Feito no terminal interativo", com diff e desfazer.
- **Operador editando durante o turno**: a mudança conta como do turno, porque não há como separar. A proteção são a tela de confirmação e as três comparações.
- **Repositório apagado ou clonado de novo**: as refs somem; os turnos ficam "retrato perdido", sem diff nem desfazer.
- **Refs ocultas fora do Claudinei**: não aparecem em `git branch` nem em `git log`, mas aparecem em `git log --all` e iriam num `git push --mirror`. A tela de ajuda explica.
- **Turnos anteriores ao recurso**: sem retrato e sem desfazer. "Voltar só a conversa" funciona quando o motor dá a âncora (uuid no transcript do Claude, `thread/turns/list` do Codex).
- **Volta da conversa falhou no motor**: os arquivos já desfeitos ficam desfeitos, com Refazer à mão. A tela diz que a conversa não voltou, e o texto editado fica no campo, sem envio.

## Testes

- Servidor, com repositórios git de verdade em pasta temporária: o marco não muda o índice, o stash, o `HEAD` nem os branches do operador; o diff pega a mudança feita via Bash; `.gitignore` respeitado; solto de 2 MB+ fica fora; entrada e saída do retrato limitado (arquivo novo entra, solto antigo vira "sem retrato"); submódulo.
- As três comparações: volta, já desfeito, conflito com "só as linhas do turno" limpo e com choque; arquivo criado (apaga) e apagado (recria); bit de execução; Refazer; commit e checkout entre o turno e o desfazer.
- Dois terminais com turnos sobrepostos: atribuição pelo caminho declarado, incerta sem declaração, desfazer bloqueado com o outro `working` ou `in_terminal`; mudança fora de turno.
- Fins de turno: interrompido, cortado, morto, serviço caído (fim incerto), retrato atrasado; retenção (30 dias, 200 por terminal, terminal excluído).
- Motores: os argumentos do Claude (`--resume-session-at`, `--fork-session`, id novo só depois do primeiro turno); Codex `thread/revert` e a volta para `thread/fork`; Kimi e OpenCode desligados (ou o fork do OpenCode, se o ensaio passar); a nota `files reverted` vai na próxima mensagem uma vez só.
- Web: linha do turno, painel de diff carregado só ao abrir, tela de conflito por arquivo, opções desligadas com o motivo, "Copiar para o campo", pasta sem git.
- Ensaio numa instância isolada (porta e banco próprios) com o CLI falso e um repositório descartável. À parte, sem gastar tokens: `--resume-session-at` num transcript copiado e `thread/revert` numa conversa de teste do Codex.

## Fora do escopo / depois

- Usar o checkpoint nativo do Claude nas pastas sem git.
- Separar no diff o que cada subagente fez.
- Desfazer por arquivo direto na árvore do diff, fora da tela de desfazer.
- Volta da conversa no Kimi, se o `kimi -p` ganhar opção para isso.

## Decisões de quem escreveu (o operador confere na leitura)

- **Limites do retrato:** 2 MB por arquivo solto; retrato limitado acima de 5.000 soltos ou 200 MB; retenção de 30 dias e 200 turnos por terminal.
- **"Abrir no terminal" na mesma pasta bloqueia o desfazer**, como um turno em andamento, porque o Claudinei não vê os turnos de lá.
- **Mudança compartilhada sem caminho declarado** fica "incerta" e desmarcada; o operador inclui à mão.
- **A nota "files reverted"** vai na próxima mensagem, sem turno próprio. Assim não gasta tokens, e o agente não edita em cima de um arquivo que mudou sem ele saber.
- **Claude com `--fork-session`** ao voltar a conversa: o transcript antigo fica no disco, e o terminal passa ao id novo.
