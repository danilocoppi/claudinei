# Dois terminais na mesma pasta, com contextos separados

Data: 2026-09-18
Status: aprovado (aguardando plano de implementação)

## Problema

Uma pasta só pode ter um terminal. São dois bloqueios independentes.

**O bloqueio explícito.** `projects.path` é `UNIQUE` (`server/src/db.ts:11`).
Criar o segundo terminal apontando para a mesma pasta falha no `INSERT`, e a tela
de novo terminal mostra o erro cru do SQLite
(`web/src/components/NewProjectModal.tsx`).

**O bloqueio real, que sobreviveria à remoção do `UNIQUE`.** Em cinco pontos o
servidor resolve a conversa a retomar como "a mais recente **desta pasta**", sem
olhar de quem ela é. Com dois terminais na mesma pasta, cada um pegaria a
conversa do outro:

| # | Onde | O que faz hoje |
|---|------|----------------|
| 1 | `manager.start` → `session.ts:90` / `codex-session.ts:47` | sessão nova com `continueLatest` chama `claude --continue` ou `latestThreadForCwd(pasta)` |
| 2 | `manager.revive` (`manager.ts:463`) | sessão sem id próprio revive com `continueLatest: row.continue_latest !== 0` |
| 3 | `manager.openInTerminal` (`manager.ts:558-566`) | sem id no banco, cai em `latestConversationId(pasta)` |
| 4 | `onExit` do terminal (`manager.ts:626-635`) | re-resolve `latestConversationId(pasta)` e **persiste** via `persist(localId, 'stopped', nextId)` |
| 5 | `GET /api/sessions/:localId/history` (`routes/sessions.ts:201`) | prévia de sessão sem id lê `latestConversationId(pasta)` |

O ponto 4 é o mais grave: os outros quatro mostram conversa alheia enquanto
duram, mas ele **grava no banco** o id do vizinho, de forma permanente.

O mecanismo de isolamento, por outro lado, já existe e funciona: toda engine
sabe retomar uma conversa específica por id — Claude `--resume <id>`, Codex
`resume <id>`, Kimi `-r <id>`, OpenCode `--session <id>`. O que falta não é
capacidade de isolar, é parar de resolver por pasta.

## Solução

Dois terminais na mesma pasta são **dois projetos** (dois cards na sidebar),
cada um com sua sessão por engine, seu mural, suas tarefas, seus agendamentos e
suas ações. Nada de "abas de contexto" dentro de um card.

O segundo terminal de uma pasta **nasce com conversa nova**. Não existe
`--continue` que saiba dizer "a última conversa desta pasta, exceto as do
vizinho" — então a divergência começa no nascimento, e daí em diante cada
terminal retoma por id próprio.

A regra que substitui o `--continue` em pasta compartilhada é uniforme para
todos os cards dela: **retoma o último thread deste projeto** (por id, via
`project_threads`), ou abre conversa nova se o projeto ainda não tem thread
nenhum. Não há "card privilegiado" — ver a decisão correspondente abaixo.

Consequência preservada de propósito: **uma pasta com um único terminal continua
se comportando exatamente como hoje**, inclusive o `--continue`.

## Decisões

**Dois cards, não abas.** O modelo de dados já é por projeto: sessões, mural,
tarefas, agendamentos, ações e permissões todos referenciam `projects(id)`. Um
segundo card herda isolamento em todos eles de graça. Abas de contexto dentro de
um card exigiriam uma dimensão nova em sete tabelas.

**Conversa nova no segundo terminal, sempre.** Ver acima.

**Em pasta compartilhada, `--continue` vira `--resume` do próprio thread — para
todos os cards, sem exceção.** A alternativa seria privilegiar o card mais antigo
da pasta, deixando só ele com `--continue`. Ela não funciona: assim que o
vizinho conversa, a conversa dele passa a ser a mais recente da pasta, e o
`--continue` do card "privilegiado" entregaria justamente o contexto alheio que
esta mudança existe para evitar. A regra uniforme não perde nada: enquanto o
card era o único da pasta, seu último thread próprio **é** a conversa que o
`--continue` traria.

**A pasta compartilhada é do operador, não do sistema.** Dois agentes escrevendo
na mesma pasta podem colidir (`index.lock` do git, build concorrente). O
Claudinei avisa e não impede: quem cria dois terminais na mesma pasta está
pedindo isso deliberadamente.

**Uma pasta, dois murais.** Mural, tarefas, agendamentos, ações e permissões por
usuário são por card. Duas entradas para a mesma pasta terão dois de cada. É o
preço de serem terminais independentes, e é o comportamento que "dois cards"
implica.

**Nada de deduplicar caminho.** `/home/eu/proj` e `/home/eu/proj/` (ou um
symlink para a mesma pasta) continuam sendo projetos distintos para o banco,
como já são hoje. Normalizar caminho é problema separado e não é resolvido aqui.

## Migração: o parque instalado

Há Claudineis rodando em outras máquinas, com outros usuários. A atualização
chega como binário novo, e a migração tem que acontecer sozinha, antes de
qualquer código tocar o banco.

**Onde roda.** Em `openDb` (`server/src/db.ts:64`), chamada uma única vez em
`server/src/index.ts:116`, antes do serviço de auth, do gerenciador de sessões e
das rotas. Trocar o binário é suficiente: nenhum script solto, nenhum passo
manual.

**Por que o padrão atual não serve.** As migrações existentes são
`try { ALTER TABLE ... } catch {}` — inofensivas se falharem no meio, porque
adicionar coluna é uma instrução. Remover `UNIQUE` no SQLite exige recriar a
tabela: cinco instruções. Uma queda entre a terceira e a quarta deixaria a
instalação **sem a tabela `projects`**.

**Detecção pelo estado real do schema.** Os bancos existentes não registram
quais migrações já rodaram (não há `user_version` em uso), então um contador
introduzido agora teria que adivinhar o passado. A migração pergunta ao próprio
SQLite se ainda existe índice único sobre `path`
(`PRAGMA index_list(projects)`, `origin='u'`) e só age se existir. Isso acerta
nos três estados do parque: banco antigo, banco já migrado, instalação nova
(que passa a nascer sem a restrição, pelo `SCHEMA`).

**Cópia de segurança antes, uma vez só.** Primeira migração destrutiva do
projeto, rodando em máquinas que não podemos inspecionar. Antes da recriação, o
banco é copiado com `VACUUM INTO` para `<dbPath>.bak-<timestamp>` — cópia
consistente sem parar nada e sem depender do estado do WAL. Custa o tamanho do
banco em disco, uma vez na vida da instalação. É o único caminho de volta que
existe remotamente.

**Atômica.** Nesta ordem:

```
PRAGMA foreign_keys = OFF      (fora de transação: dentro é no-op)
BEGIN
  CREATE TABLE projects_new (... path TEXT NOT NULL ... )   -- sem UNIQUE
  INSERT INTO projects_new (<colunas>) SELECT <colunas> FROM projects
  DROP TABLE projects
  ALTER TABLE projects_new RENAME TO projects
  CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)
  PRAGMA foreign_key_check     -- precisa vir vazio
COMMIT
PRAGMA foreign_keys = ON
```

Se o processo morrer no meio ou o `foreign_key_check` acusar problema, o próximo
boot encontra o banco como estava. Não existe estado intermediário visível.

**`<colunas>` vem do banco, não de uma lista fixa.** `PRAGMA table_info(projects)`
em tempo de execução. `SELECT *` quebraria se a ordem das colunas divergisse
entre máquinas, e uma lista fixa quebraria no próximo `ALTER TABLE projects` que
alguém escrever. A migração fica **depois** das alterações de coluna existentes
(`sort_order`, `group_id`, `sector_id`), senão copiaria os dados antes de elas
existirem.

**O índice que sai precisa de substituto.** O `UNIQUE` também servia de índice
para busca por caminho, e o aviso de pasta compartilhada vai contar terminais por
caminho. Daí o `idx_projects_path` não-único acima.

**Falha não derruba o serviço.** Se a transação falhar, o rollback já devolveu o
banco íntegro; o boot continua, com registro em destaque no log. Derrubar o
Claudinei de um usuário remoto por causa de uma funcionalidade opcional seria
pior que não tê-la — o único sintoma visível é a pasta repetida continuar
recusada, com a mensagem clara da fase 3.

**Sem caminho de volta automático.** Uma versão anterior do binário lê o banco
migrado sem erro: ela só voltaria a recusar pasta repetida no `INSERT`, e dois
cards já criados para a mesma pasta continuariam funcionando (nada na versão
antiga depende do `UNIQUE` para ler). Se o operador quiser o estado exato
anterior, existe o arquivo `.bak-<timestamp>`.

## Isolamento: de quem é cada conversa

**Tabela nova: `project_threads`.**

```sql
CREATE TABLE IF NOT EXISTS project_threads (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  engine     TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, engine, thread_id)
)
```

Por que não bastam as sessões: a limpeza automática mantém só as 5 últimas
sessões finalizadas por projeto (`manager.ts:330-340`), então o `claude_session_id`
de uma conversa antiga desaparece do banco — e a conversa continua existindo no
disco da engine, pronta para ser confundida com a do vizinho. `project_threads`
guarda a memória de posse independentemente do ciclo de vida da sessão.

**Alimentação em um único ponto:** `persist` (`manager.ts:156`) é o único lugar
que grava um id de conversa em `sessions` (o `UPDATE ... = NULL` de
`resolveResume` só descarta id fantasma). Quando `persist` recebe um id não
nulo, registra também em `project_threads`. Todos os cinco pontos problemáticos
lidam com sessões que um dia passam por `persist`.

**Duas consultas derivadas:**

- **`exclude`** — os ids que pertencem a **outros** projetos com o mesmo
  caminho. É o conjunto a descartar.
- **`ownLatest`** — o último thread **deste** projeto e engine
  (`seen_at DESC`), usado no lugar do `--continue` em pasta compartilhada.

**Assinatura nova nas engines** (`server/src/engine/types.ts:90`):

```ts
latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null
```

Parâmetro opcional: quem chama sem ele (e uma pasta com um terminal só) vê o
comportamento de hoje. Quatro implementações a ajustar — claude, codex, kimi,
opencode — mais o dublê de teste. O `exclude` participa da chave do cache do
OpenCode (`opencode-engine.ts:44`), senão duas consultas diferentes se atropelam.

**Os cinco pontos, com a correção:**

1. **`start`** — em pasta compartilhada, `continueLatest` é traduzido para
   `resumeSessionId: ownLatest` (ou conversa nova, se o projeto não tem thread).
   Pasta com um terminal só: intocada, segue com `--continue`.
2. **`revive`** — mesma tradução: sem id próprio na linha da sessão e em pasta
   compartilhada, tenta `ownLatest` antes de desistir; nunca `--continue`.
3. **`openInTerminal`** — o fallback passa o `exclude`, então nunca abre a
   conversa do vizinho.
4. **`onExit`** — passa o `exclude`, e se o resultado for nulo mantém o
   `resumeId` anterior em vez de adotar o que achou. É a correção que evita
   corrupção permanente.
5. **Prévia de histórico** — mostra a conversa que a sessão vai de fato retomar:
   em pasta compartilhada, o `ownLatest`; em pasta com um terminal só, o
   `latestConversationId` de hoje. Sem conversa própria, devolve vazio em vez da
   conversa alheia.

## Interface

**Criar terminal em pasta já usada passa a ser permitido**, com aviso em uma
linha: a pasta já tem terminal e este começa com conversa nova. É aviso, não
erro — o botão continua ativo.

**Indicador de pasta compartilhada** no cabeçalho do chat, discreto, para o
operador nunca se perguntar se está no card certo.

Textos nos três idiomas (`pt-BR`, `en`, `es`). Abas de engine, sidebar e o resto
ficam intactos: tudo ali já trabalha por id de projeto.

## Testes

**Migração** — banco no estado antigo, com dados nas sete tabelas que dependem de
`projects` (sessions, mural, tasks×2, user_projects, schedules, actions):
`openDb` duas vezes (a segunda não faz nada), nada se perde, `foreign_key_check`
vazio, numeração de ids não regride, o `.bak` existe. E: banco já migrado não é
tocado; instalação nova nasce sem a restrição.

**Isolamento** — dois projetos na mesma pasta; nenhum dos dois recebe
`--continue`; o card sem thread próprio nasce em conversa nova e o card com
thread retoma o **seu** por `--resume`; os fallbacks de `openInTerminal`,
`onExit` e prévia de histórico não devolvem thread alheio; `onExit` não grava id
de outro terminal; pasta com um terminal só mantém o comportamento atual (teste
de regressão explícito para cada um dos cinco pontos).

**Interface** — modal aceita pasta repetida e mostra o aviso; indicador aparece
só quando a pasta é compartilhada.

**Verificação real** — dois terminais na mesma pasta nesta máquina, conversa
distinta em cada um, provando que não se cruzam depois de reiniciar o serviço.

## Fora de escopo

- Normalizar ou deduplicar caminhos (symlink, barra final).
- Impedir ou coordenar escrita concorrente de dois agentes na mesma pasta.
- Unificar mural/tarefas/agendamentos entre cards da mesma pasta.
- Abas de contexto dentro de um card.
- `PRAGMA user_version` como registro de migrações (detecção por estado resolve
  o caso presente; introduzir um contador exigiria inventariar o passado).
