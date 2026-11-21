# Desfazer o que o agente fez: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada mensagem que entra num terminal ganha um ponto de restauração tirado com o git (sem tocar no que o operador usa), um diff real do que mudou na pasta e um "Desfazer" que só sobrescreve depois de comparar antes, depois e agora. "Editar" numa mensagem do operador passa a voltar de fato a conversa (Claude e Codex), com ou sem os arquivos.

**Architecture:**
- **Retrato** (`server/src/checkpoint/`, módulo novo e sem dependência do resto do servidor): plumbing do git com índice próprio e refs ocultas, diff entre retratos e a restauração com as três comparações.
- **Turnos** (`server/src/undo/`, módulo novo): um rastreador observa o manager por um único gancho (`TurnObserver`), abre um trecho por mensagem, pede os marcos a uma fila por repositório e grava tudo em tabelas novas. Um serviço calcula a atribuição entre terminais, a prévia e a escrita do desfazer, o refazer, as notas ao agente e a retenção. Outro serviço faz a volta da conversa por motor (adaptadores Claude e Codex).
- **Ganchos curtos nos arquivos compartilhados.** O manager ganha o observador, `liveSession` e `relaunch` (com o id novo segurado até o primeiro result). O Codex ganha três métodos e um evento. O Claude só repassa `extraArgs`. Na web, o ChatView desenha as linhas dos turnos e troca o lápis por um diálogo; o resto mora em `web/src/undo/` e `web/src/components/undo/`.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 + git ≥ 2.43 (servidor); React + zustand + i18next (web); vitest com repositórios git temporários e os CLIs falsos (`server/test/fake-claude.mjs`, `server/test/fake-codex.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-20-desfazer-turno-design.md`, com as "Decisões de quem escreveu" e as "Decisões da checagem do construtor" do fim. Onde divergem, valem os fatos dos ensaios com os CLIs reais (`/tmp/onda-c/ensaios-resultado.md`), já incorporados aqui:
- no Claude, o corte usa o `parentUuid` da entrada do transcript da mensagem editada (o `uuid` da própria entrada a manteria);
- o Codex `thread/revert` troca o arquivo de rollout (mesmo `threadId`).

O ensaio com CLI real já foi feito: nenhuma tarefa abre sessão real.

## Global Constraints

- **O git do operador fica intocado.**
  - Nada de commit no branch, `git add` no índice dele, stash, mudança de `HEAD`, branch, checkout ou `gc`.
  - Na pasta do operador só rodam:
    - de leitura: `rev-parse`, `ls-files`, `diff`/`diff-tree`, `cat-file`, `symbolic-ref -q`, `for-each-ref`;
    - de escrita: `add`/`rm --cached`, sempre com `GIT_INDEX_FILE=<git-dir>/claudinei-index`; `write-tree`; `commit-tree`; `update-ref`, só em `refs/claudinei/…`;
    - `merge-file -p`, só sobre arquivos temporários.
  - Ambiente de todo git: `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, sem `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` herdados, autor e committer `Claudinei <claudinei@localhost>`.
- **Nomes:**
  - índice próprio: `<git-dir>/claudinei-index`, semeado da primeira vez com uma cópia de `<git-dir>/index`;
  - ref: `refs/claudinei/<chave>/<n>`. A `<chave>` são os 16 primeiros hexadecimais do sha1 do caminho real de `git rev-parse --show-toplevel`. Worktrees ligados têm chaves diferentes; `<n>` cresce por chave.
- **Limites:**
  - solto (não rastreado e não ignorado) entra no retrato até **2 MB** (`2 * 1024 * 1024`);
  - **retrato limitado** acima de **5.000** soltos ou **200 MB** somados;
  - diff para em **2.000 linhas** por arquivo;
  - retenção de **30 dias** e **200 turnos por terminal** (projeto + motor), na subida e a cada 24 h.
- **O retrato nunca atrasa o envio.** No caminho síncrono do envio só há gravação no SQLite. O git roda depois, numa fila única por repositório, um por vez. Retrato que falha não bloqueia o turno: o turno fica "sem ponto de restauração" com o motivo.
- **Turno, para os arquivos, é cada mensagem** (origem operador, Claudinei, tarefa, agendamento, goal). O turno que o motor abre sozinho ganha origem `engine`. Mensagem que entra no meio do turno fecha o trecho anterior e abre o seguinte num marco só. A compactação não gera marco.
- **Textos ao agente** (inglês, verbatim; constantes em `shared/undo.ts`):
  - `FILES_REVERTED_PREFIX = '[Claudinei: files reverted]'`, com o texto `${FILES_REVERTED_PREFIX}: The operator reverted the file changes of an earlier turn: <arquivos>. Re-read them before editing.`. `<arquivos>` são os caminhos relativos ao topo, separados por `, `, até 30, seguidos de ` and <n> more`.
  - `CONVERSATION_REWOUND_PREFIX = '[Claudinei: conversation rewound]'`, com o texto `${CONVERSATION_REWOUND_PREFIX}: Files still contain changes made after this point.`
  - A nota vai **na frente** da mensagem seguinte, separada por `\n\n`. Não é envio próprio e não entra em `server/src/queue/next-send.ts`, que este plano não modifica.
- **Quem vê o quê.**
  - O administrador vê tudo.
  - Os outros veem e desfazem só arquivos dentro da pasta do projeto do terminal. O resto vira `hiddenOutside: N`, sem nome nem conteúdo.
  - Na espera, terminal sem acesso aparece como "outro terminal" (`terminal: null`).
- **Motores na volta da conversa.**
  - Claude: `--resume <id> --resume-session-at <parentUuid> --fork-session --session-id <uuid novo>`. Com `parentUuid` nulo, abre sessão nova. O id novo só vai ao banco no primeiro `result`.
  - Codex: `thread/revert {threadId, beforeTurnId}`. Se recusar, `thread/fork {threadId, lastTurnId, excludeTurns: true}` e o terminal passa ao id novo.
  - Codex em mensagem do meio do turno (`turn/steer`): as duas opções desligadas.
  - OpenCode e Kimi: desligados, com "O <motor> não deixa o Claudinei voltar a conversa".
  - `--resume-drops-turn`, a trava extra da spec, não é usado: os ensaios não o cobriram, e o corte já vem do `--resume-session-at`.
- **Interface sem GPU** (AGENTS.md): nada de animação nem `backdrop-filter` nos componentes novos. O diff só é buscado ao abrir. Todo texto ao operador vai em `pt-BR`, `en` e `es`.
- **Ambiente:**
  - `N24=/usr/local/n/versions/node/24.15.0/bin`;
  - servidor: `cd server && PATH=$N24:$PATH npx vitest run <arquivo>` e `cd server && PATH=$N24:$PATH npx tsc --noEmit`;
  - web: `cd web && npx vitest run <arquivo>` e `cd web && npx tsc -b`, sem commitar `web/tsconfig.tsbuildinfo`;
  - nunca `npm install` no worktree (os `node_modules` são symlinks);
  - commits com `git add <arquivos explícitos>` e a mensagem terminando em `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Ensaio** só na porta **9196**, com dados em `/tmp/claudinei-e2e-desfazer`. Nunca a 9105. Nunca reiniciar o serviço do Claudinei.

## Review Focus

1. **O git do operador no meio de uma operação.** Um marco tirado com `.git/index.lock` presente (o operador no meio de um commit), com stash existente e em `HEAD` destacado funciona. Ele não apaga nem cria o lock do operador, e o índice, o stash, os branches e o `HEAD` ficam byte a byte iguais. Teste na Task 2.
2. **O arquivo muda entre a prévia e a escrita.** O operador abre a tela de desfazer, o editor salva o arquivo e ele confirma. A escrita reconfere o "agora" na seção síncrona e devolve `undo_changed` (409) com a prévia nova, sem escrever nada. Teste na Task 4 (motor) e na Task 9 (serviço).
3. **Caminhos estranhos e links simbólicos.** Os casos:
   - `dir com espaço/ação -x.txt` e nome começando com `-`: tudo com `-z` e `--`;
   - um link simbólico criado no turno: desfazer apaga o link, não o alvo;
   - um link trocado por arquivo comum: volta a ser link.

   Testes nas Tasks 3 e 4.
4. **Repositório sem commit e `HEAD` destacado.** Num `git init` sem commit, o marco sai com `head: null` e `branch: null`, e o diff e o desfazer funcionam. Teste na Task 2.
5. **O Claude volta a conversa e morre antes de responder.** O processo novo sai antes do primeiro `result`. O banco segue com o id antigo (sem "resume de id fantasma"), o web não recebe o id novo e reviver retoma a conversa antiga. Teste na Task 7.

---

### Task 1: Git sem efeitos colaterais e o repositório de uma pasta

**Files:**
- Create: `server/src/checkpoint/git.ts`, `server/src/checkpoint/repo.ts`
- Test: `server/test/checkpoint-repo.test.ts`, `server/test/helpers/git-repo.ts`, este com o ajudante de testes: cria um repo temporário com commit inicial e `git config user.*` local

**Interfaces:**
- Produces:
  ```ts
  // git.ts
  export class GitError extends Error { code: number; stderr: string; args: string[] }
  export interface GitResult { code: number; stdout: Buffer; stderr: string }
  export function git(cwd: string, args: string[], opts?: {
    indexFile?: string; input?: string | Buffer; allowFail?: boolean; maxBuffer?: number /* padrão 64 MB */
  }): Promise<GitResult>                     // execFile('git'), ambiente das Global Constraints; código ≠ 0 sem allowFail → GitError
  export function splitZ(buf: Buffer): string[]   // saída -z → lista, sem o vazio final
  // repo.ts
  export interface RepoInfo { top: string; gitDir: string; commonDir: string; key: string }
  export function repoKeyOf(top: string): string  // sha1(top).hex.slice(0, 16)
  export function resolveRepo(path: string): Promise<RepoInfo | null>  // null: fora de git, repo bare, git ausente
  export function createRepoResolver(ttlMs?: number /* 60_000 */): {
    get(path: string): Promise<RepoInfo | null>
    peek(path: string): RepoInfo | null | undefined   // undefined = ainda não resolvido
  }
  ```
  `resolveRepo` usa uma chamada só: `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`. O `--git-common-dir` relativo é resolvido contra a pasta; `top` passa por `realpath`.
- `helpers/git-repo.ts`:
  ```ts
  export function makeRepo(files?: Record<string, string>): { dir: string; run(...args: string[]): string; write(rel: string, body: string | Buffer): void; cleanup(): void }
  ```

- [ ] **Step 1: Escrever os testes que falham** em `checkpoint-repo.test.ts`:
  - `subpasta do repo resolve para o mesmo topo e a mesma chave`: `resolveRepo(dir + '/a/b')` tem `top === realpath(dir)`;
  - `pasta sem git devolve null` e `repo bare devolve null`;
  - `worktree ligado tem chave e gitDir próprios e o mesmo commonDir`: via `git worktree add`;
  - `git() não herda GIT_DIR nem GIT_INDEX_FILE do processo`: com `process.env.GIT_INDEX_FILE='/tmp/x'` definido, `git(dir, ['rev-parse','--git-path','index'])` aponta para o índice do repo;
  - `código diferente de zero vira GitError com stderr; allowFail devolve o código`;
  - `resolver guarda por ttl e peek diz undefined antes de resolver`.
- [ ] **Step 2: Rodar e ver falhar.** `cd server && PATH=$N24:$PATH npx vitest run test/checkpoint-repo.test.ts`: FAIL, módulo inexistente.
- [ ] **Step 3: Implementar `git.ts` e `repo.ts`.**
- [ ] **Step 4: Rodar e ver passar**, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(desfazer): git sem efeitos colaterais e o repositório de uma pasta`.

### Task 2: O marco (retrato) e a fila por repositório

**Files:**
- Create: `server/src/checkpoint/snapshot.ts`, `server/src/checkpoint/serial.ts`
- Test: `server/test/checkpoint-snapshot.test.ts`

**Interfaces:**
- Consumes: `git`, `splitZ`, `RepoInfo` (Task 1).
- Produces:
  ```ts
  export const SNAPSHOT_LIMITS = { untrackedMaxBytes: 2 * 1024 * 1024, limitedFiles: 5000, limitedBytes: 200 * 1024 * 1024 }
  export interface UntrackedEntry { path: string; size: number; mtimeMs: number }
  export function refName(key: string, n: number): string           // `refs/claudinei/${key}/${n}`
  export interface Snapshot {
    ref: string; commit: string; head: string | null; branch: string | null
    mode: 'full' | 'limited'
    big: UntrackedEntry[]                // soltos > 2 MB, fora do retrato (nos dois modos)
    listing: UntrackedEntry[] | null     // modo limitado: a lista inteira dos soltos; completo: null
  }
  export function takeSnapshot(repo: RepoInfo, n: number, opts?: { previousListing?: UntrackedEntry[] | null; limits?: typeof SNAPSHOT_LIMITS }): Promise<Snapshot>
  export function deleteRefs(repo: RepoInfo, refs: string[]): Promise<void>   // `update-ref --stdin` com linhas `delete <ref>`; só aceita refs/claudinei/
  // serial.ts
  export function createSerialQueue(): { run<T>(key: string, fn: () => Promise<T>): Promise<T>; idle(key?: string): Promise<void> }
  ```
- **Algoritmo de `takeSnapshot`** (decisão deste plano):
  1. Sem `<gitDir>/claudinei-index`, copia `<gitDir>/index` para lá, se existir.
  2. Soltos: `git ls-files -o --exclude-standard -z`, com o índice **do operador** (só leitura) e `lstat` de cada um (tamanho e `mtimeMs`). Passando de 5.000 ou 200 MB, o modo é `limited`.
  3. Com o índice próprio, `git add -u` (atualiza e remove o que já está nele).
  4. Lista a acrescentar:
     - no modo completo: soltos ≤ 2 MB, mais o que está no índice do operador e falta no próprio (`ls-files -z` dos dois);
     - no modo limitado: os soltos ≤ 2 MB **ausentes de `previousListing`** (criados desde o marco anterior), mais o mesmo complemento do índice do operador.

     Vai num `git add --pathspec-from-file=- --pathspec-file-nul`.
  5. `git rm --cached -q --pathspec-from-file=- --pathspec-file-nul` em quem está no índice próprio e não está no do operador nem na lista do passo 4. São os soltos que cresceram além de 2 MB, sumiram ou passaram a ser ignorados. No modo limitado, os soltos que já estão no índice próprio continuam: foram criados durante turnos.
  6. Depois:
     - `write-tree` com o índice próprio;
     - `commit-tree <tree> -m "claudinei <n>"`, sem pai;
     - `update-ref <ref> <commit>`;
     - `rev-parse -q --verify HEAD` (`head`) e `symbolic-ref -q --short HEAD` (`branch`). Repo sem commit e `HEAD` destacado devolvem null.
  7. Submódulo entra como o commit apontado (é o que o `add` faz).

- [ ] **Step 1: Escrever os testes que falham:**
  - `marco não muda índice, stash, HEAD, branches nem reflog do operador`: compara o sha do `.git/index`, `git stash list`, `git for-each-ref refs/heads refs/stash` e `git rev-parse HEAD` antes e depois. Com um arquivo modificado e outro em `git add`;
  - `marco com .git/index.lock presente funciona e não mexe no lock` (Review Focus 1);
  - `marco em HEAD destacado e em repo sem commit: head e branch null quando não há, e o diff-tree entre dois marcos do repo sem commit lista o arquivo novo` (Review Focus 4);
  - `mudança feita "pelo Bash" entra`: `fs.writeFileSync` direto, `git diff-tree` entre dois marcos lista o arquivo;
  - `.gitignore respeitado`: `node_modules/x.js` fora do tree;
  - `solto de 2 MB + 1 byte fica fora e vai em big; com 2 MB exatos entra`;
  - `solto que cresce além de 2 MB sai do índice próprio no marco seguinte`;
  - `retrato limitado`: com `limits.limitedFiles = 3` e 4 soltos, `mode === 'limited'`, `listing.length === 4` e o tree só tem os rastreados. O marco seguinte com `previousListing` inclui o solto criado depois e não inclui os antigos;
  - `submódulo entra como gitlink (modo 160000)`;
  - `ref fica em refs/claudinei/<chave>/<n> e não aparece em git branch nem git log`;
  - `fila serial: duas chamadas na mesma chave não se sobrepõem; chaves diferentes rodam juntas`;
  - `deleteRefs recusa ref fora de refs/claudinei/`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar `snapshot.ts` e `serial.ts`.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(desfazer): marco do git com índice próprio e refs ocultas`.

### Task 3: Diff entre marcos

**Files:**
- Create: `server/src/checkpoint/diff.ts`
- Test: `server/test/checkpoint-diff.test.ts`

**Interfaces:**
- Consumes: `git`, `Snapshot`, `UntrackedEntry` (Tasks 1–2).
- Produces:
  ```ts
  export type FileStatus = 'added' | 'modified' | 'deleted' | 'mode' | 'submodule' | 'too_big' | 'unsnapshotted'
  export interface FileChange { path: string; status: FileStatus; added: number; removed: number; binary: boolean; size?: number }
  export interface MarkSide { commit: string; big: UntrackedEntry[]; listing: UntrackedEntry[] | null }
  export function changedFiles(repo: RepoInfo, from: MarkSide, to: MarkSide): Promise<FileChange[]>
  export interface FileDiff { path: string; binary: boolean; sizeKb?: number; text: string; truncated: boolean }
  export function fileDiff(repo: RepoInfo, fromCommit: string, toCommit: string, path: string, maxLines?: number /* 2000 */): Promise<FileDiff>
  export function commitExists(repo: RepoInfo, commit: string): Promise<boolean>   // `cat-file -e`; false = "retrato perdido"
  ```
- `changedFiles`:
  - `git diff-tree -r -z --no-renames --raw --numstat <from> <to>`. O modo `160000` vira `submodule`; só bit de execução vira `mode`; numstat `-\t-` vira `binary`.
  - Sobre os caminhos que não estão no tree, cruza `big` e `listing` dos dois lados:
    - ausente antes, ou tamanho/mtime diferente, e grande → `too_big` com `size`;
    - presente nas duas listagens do modo limitado, com tamanho/mtime diferente e fora do tree → `unsnapshotted`.
- `fileDiff`: `git diff --no-ext-diff --no-color -U3 <from> <to> -- <path>`. Corta em `maxLines` com `truncated: true`. Para binário, `cat-file -s` do lado novo vira `sizeKb`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `added, modified, deleted e mode com +/− do numstat`;
  - `binário: binary true, sem linhas, e fileDiff dá sizeKb`;
  - `solto grande criado no intervalo aparece como too_big com o tamanho`;
  - `limitado: solto antigo que mudou aparece como unsnapshotted; criado no turno aparece como added`;
  - `submódulo que avançou aparece como submodule`;
  - `fileDiff corta em 2000 linhas com truncated`, com um arquivo de 2.500 linhas;
  - `caminho com espaço, acento e começando com "-"` (Review Focus 3);
  - `commitExists falso depois de apagar a ref e rodar git gc --prune=now no repo do teste`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(desfazer): diff entre marcos, com grandes, limitados e submódulos`.

### Task 4: As três comparações e a escrita

**Files:**
- Create: `server/src/checkpoint/restore.ts`
- Test: `server/test/checkpoint-restore.test.ts`

**Interfaces:**
- Consumes: `git`, `RepoInfo`.
- Produces:
  ```ts
  export interface BlobState { sha: string; mode: '100644' | '100755' | '120000' }
  export interface RestoreItem { path: string; before: BlobState | null; after: BlobState | null }   // null = não existia
  export type RestoreVerdict = 'revert' | 'already' | 'conflict'
  export interface RestorePlanItem {
    path: string; verdict: RestoreVerdict
    mergeable: boolean          // só em conflict: o inverso do turno aplica sem choque
    nowDigest: string | null    // sha1 dos bytes do disco + modo; null = ausente
    sinceTurn?: string          // conflict: diff unificado de "depois" → "agora" (≤ 2000 linhas)
  }
  export function blobStatesAt(repo: RepoInfo, commit: string, paths: string[]): Promise<Map<string, BlobState>>  // `ls-tree -z <commit> -- …`
  export function planRestore(repo: RepoInfo, items: RestoreItem[]): Promise<RestorePlanItem[]>
  export type RestoreAction = 'revert' | 'merge' | 'force' | 'keep'
  export interface PreparedRestore { repo: RepoInfo; entries: PreparedEntry[] }   // PreparedEntry é interno: bytes-alvo, modo, digest esperado
  export function prepareRestore(repo: RepoInfo, items: RestoreItem[], decisions: Record<string, RestoreAction>, expected: Record<string, string | null>): Promise<PreparedRestore>
  export type RestoreResult = 'reverted' | 'merged' | 'forced' | 'kept' | 'already' | 'changed_since_preview'
  export function applyPrepared(p: PreparedRestore): Array<{ path: string; result: RestoreResult }>   // SÍNCRONO
  ```
- **Comparação por bytes, não por hash do git.** "Antes" e "depois" são lidos com `git cat-file --filters --path=<p> <sha>`, que já aplica smudge, LFS e autocrlf. O link simbólico (`120000`) é lido com `cat-file blob` e comparado com `readlink`. "Agora" é o arquivo do disco com o bit de execução do `lstat`.
  - agora = depois: o alvo é "antes", ou apagar se `before` é null;
  - agora = antes: `already`;
  - o resto: `conflict`.
- **Merge** (`mergeable` e a ação `merge`): `git merge-file -p <agora> <depois> <antes>` em arquivos temporários de `os.tmpdir()`. Código 0 dá `mergeable: true`; conflito ou binário dá `false`.
- **`applyPrepared` é síncrono de propósito.** Nenhum envio do Node cabe no meio. Para cada entrada:
  1. relê o disco e confere o digest esperado; diferente dá `changed_since_preview` e não escreve;
  2. escreve com `writeFileSync` + `chmodSync`, cria as pastas e recria o link com `symlinkSync`. Apagar usa `unlinkSync`; pasta vazia que sobrar fica;
  3. a ação `keep` não toca o arquivo.

- [ ] **Step 1: Escrever os testes que falham:**
  - `agora = depois volta ao antes`;
  - `agora = antes fica already`;
  - `conflito com merge limpo`: o turno muda a linha 2 e alguém depois a linha 9; `mergeable` true e `merge` mantém a linha 9 e desfaz a 2;
  - `conflito com choque`: os dois na mesma linha; `mergeable` false;
  - `force volta ao antes e perde o depois`; `keep não escreve`;
  - `arquivo criado no turno é apagado` e `apagado no turno é recriado com o conteúdo e o modo`;
  - `bit de execução volta`;
  - `link simbólico criado no turno: desfazer remove o link e não o alvo`, `link trocado por arquivo volta a ser link` (Review Focus 3);
  - `comitado entre o turno e o desfazer`: depois do `git commit` do operador, desfazer volta os arquivos e `git status` mostra a reversão sem commit; `HEAD` igual;
  - `checkout para outro branch com o arquivo diferente dá conflict`;
  - `changed_since_preview`: escrever no arquivo entre `prepareRestore` e `applyPrepared` não sobrescreve (Review Focus 2);
  - `autocrlf=true: arquivo com CRLF no disco conta como igual ao depois`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(desfazer): três comparações, merge do inverso e escrita síncrona`.

### Task 5: Tabelas, store e os textos compartilhados

**Files:**
- Modify: `server/src/db.ts`: tabelas novas no fim do `openDb`, com `CREATE TABLE IF NOT EXISTS`, como as demais.
- Create: `server/src/undo/store.ts`, `shared/undo.ts`
- Test: `server/test/undo-store.test.ts`, `server/test/undo-shared.test.ts`

**Interfaces:**
- Tabelas:
  ```sql
  undo_marks (id INTEGER PK, repo_key TEXT NOT NULL, n INTEGER NOT NULL, repo_top TEXT NOT NULL, ref TEXT NOT NULL,
    commit_sha TEXT NOT NULL, head_sha TEXT, branch TEXT, mode TEXT NOT NULL,           -- 'full' | 'limited'
    kind TEXT NOT NULL,       -- 'turn_start'|'message'|'turn_end'|'undo_pre'|'undo_post'|'terminal_open'|'terminal_close'|'boot'
    active TEXT NOT NULL DEFAULT '[]',   -- ids dos turnos ativos logo DEPOIS deste marco
    big TEXT NOT NULL DEFAULT '[]', listing_hash TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(repo_key, n))
  undo_listings (hash TEXT PRIMARY KEY, data BLOB NOT NULL)        -- JSON de UntrackedEntry[] em gzip; deduplicado pelo sha1
  undo_turns (id INTEGER PK, local_id TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    engine TEXT NOT NULL, born_session_id TEXT, conversation_id TEXT,
    origin TEXT NOT NULL,     -- 'operator'|'claudinei'|'task'|'schedule'|'goal'|'engine'|'interactive'
    text_key TEXT, mid_turn INTEGER NOT NULL DEFAULT 0, anchor TEXT,   -- anchor: id do turno do Codex
    repo_key TEXT, repo_top TEXT, start_mark INTEGER, end_mark INTEGER,
    end_kind TEXT,            -- 'result'|'interrupted'|'cut'|'dead'|'stopped'|'restart'|'uncertain'
    snapshot TEXT NOT NULL,   -- 'pending'|'ok'|'late'|'failed'|'no_git'|'lost'
    snapshot_error TEXT, limited INTEGER NOT NULL DEFAULT 0, declared TEXT NOT NULL DEFAULT '[]', summary TEXT,
    rewound_at TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT)
  undo_runs (id INTEGER PK, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, engine TEXT NOT NULL,
    kind TEXT NOT NULL,       -- 'undo' | 'redo'
    turn_ids TEXT NOT NULL, repo_key TEXT NOT NULL, pre_mark INTEGER, post_mark INTEGER, files TEXT NOT NULL,
    redo_of INTEGER, redone_at TEXT, created_at TEXT DEFAULT (datetime('now')))
  undo_notes (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, engine TEXT NOT NULL,
    files TEXT NOT NULL, PRIMARY KEY (project_id, engine))
  ```
  Índices: `undo_turns(project_id, engine, id)`, `undo_turns(local_id, id)` e `undo_marks(repo_key, n)`.
- `store.ts`, `createUndoStore(db)` com os métodos abaixo. `MarkRow`, `TurnRow`, `RunRow`, `NewTurn` e `NewRun` espelham as colunas em camelCase, com o JSON já parseado. `export type UndoStore = ReturnType<typeof createUndoStore>` e `export type MarkKind = 'turn_start' | 'message' | 'turn_end' | 'undo_pre' | 'undo_post' | 'terminal_open' | 'terminal_close' | 'boot'`.
  ```ts
  nextMarkN(repoKey: string): number
  insertMark(m: Omit<MarkRow, 'id' | 'createdAt'>): number;  mark(id: number): MarkRow | undefined
  marksRange(repoKey: string, fromN: number, toN: number): MarkRow[]          // ordenado por n
  latestMarks(repoKey: string, limit: number): MarkRow[]
  putListing(entries: UntrackedEntry[]): string;  listing(hash: string): UntrackedEntry[] | null
  openTurn(t: NewTurn): number;  turn(id: number): TurnRow | undefined
  setStart(id, markId: number | null, snapshot: TurnRow['snapshot'], error?: string, limited?: boolean): void
  setEnd(id, markId: number | null, endKind: EndKind, conversationId: string | null): void
  markLate(id): void;  setAnchor(id, anchor: string): void;  addDeclared(id, paths: string[]): void
  setSummary(id, s: TurnSummary): void;  setSnapshot(id, s, error?): void
  openTurns(): TurnRow[];  terminalTurns(projectId: number, engine: string): TurnRow[]    // por id
  markRewound(ids: number[]): void;  setConversation(ids: number[], conversationId: string): void
  insertRun(r: NewRun): number;  run(id): RunRow | undefined;  lastRunFor(turnId: number): RunRow | undefined;  setRedone(id): void
  addNote(projectId, engine, files: string[]): void;  takeNote(projectId, engine): string[] | null   // une as listas; take apaga
  ```
- `shared/undo.ts`:
  ```ts
  export const FILES_REVERTED_PREFIX = '[Claudinei: files reverted]'
  export const CONVERSATION_REWOUND_PREFIX = '[Claudinei: conversation rewound]'
  export function filesRevertedNote(paths: string[]): string      // texto das Global Constraints (30 + " and <n> more")
  export const CONVERSATION_REWOUND_NOTE: string
  export function withNote(note: string, text: string): string    // `${note}\n\n${text}`
  export function stripNotes(text: string): { notes: Array<{ kind: 'files_reverted' | 'conversation_rewound'; body: string }>; rest: string }
  export function turnKey(text: string): string
  export type TurnOrigin = 'operator' | 'claudinei' | 'task' | 'schedule' | 'goal' | 'engine' | 'interactive'
  export type EndKind = 'result' | 'interrupted' | 'cut' | 'dead' | 'stopped' | 'restart' | 'uncertain'
  export interface TurnSummary { files: number; added: number; removed: number; outside: number; uncertain: number; unsnapshotted: number }
  export interface TurnDto {
    id: number; localId: string; projectId: number; engine: string; origin: TurnOrigin; key: string | null; midTurn: boolean
    state: 'running' | 'ok' | 'late' | 'failed' | 'no_git' | 'lost'; stateReason?: string; limited: boolean
    endKind: EndKind | null; summary: TurnSummary | null; lastRun: { id: number; redone: boolean } | null
    startedAt: string; endedAt: string | null
  }
  ```
  As demais DTOs (`UndoPreview`, `PreviewFile`, `UndoRunDto`, `IntervalDto`, `RewindOptionsDto`, `RewindTarget`, `RewindResultDto`) também moram aqui. Os campos estão nas Tasks 9, 12 e 13.
- **`turnKey`** (decisão deste plano; servidor e web precisam da mesma chave):
  1. `stripNotes(text).rest`;
  2. tira **um** envelope no começo, `/^\[[^\]\n]{1,200}\]:?\s*/` (`[Task from …]:`, `[Agendamento: … #n]`, `[Claudinei: goal]:` …);
  3. junta espaços em branco num espaço, `trim`, primeiros 300 caracteres.

- [ ] **Step 1: Escrever os testes que falham:**
  - store: `numeração de marcos por chave`, `listing deduplicado pelo hash`, `openTurns só os sem end`, `takeNote une duas notas e apaga`, `excluir o projeto apaga turnos, desfazeres e notas (cascade)`;
  - shared:
    - `filesRevertedNote com 31 caminhos termina em "and 1 more"`;
    - `turnKey igual para "[Task from X]: faça y" e o corpo "faça y"`;
    - `turnKey tira a nota files reverted e a conversation rewound`;
    - `turnKey de texto do operador começando com "[WIP]" bate dos dois lados`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `test/db.test.ts` e `test/migrations-*.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(desfazer): tabelas de marcos, turnos, desfazeres e notas`.

### Task 6: O rastreador de turnos

**Files:**
- Create: `server/src/undo/types.ts`, `server/src/undo/declared.ts`, `server/src/undo/tracker.ts`
- Test: `server/test/undo-tracker.test.ts`, `server/test/undo-declared.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  ```ts
  // types.ts — o único tipo que o manager importa deste módulo
  export interface UndoCtx { localId: string; projectId: number; engine: string }
  export interface TurnObserver {
    /** Antes de cada mensagem que entra na sessão (menos /compact). Chama `send` com o texto final; o que `send` lança sobe e nada é gravado. */
    onInput(ctx: UndoCtx, text: string, origin: 'operator' | 'claudinei' | 'task' | 'schedule', send: (finalText: string) => void): void
    onStatus(ctx: UndoCtx, status: string, info: { compaction: () => boolean; engineSessionId: string | null; shuttingDown: boolean }): void
    onEvent(ctx: UndoCtx, event: AgentEvent): void
    onInteractive(ctx: UndoCtx, phase: 'open' | 'close'): void
  }
  // declared.ts
  export function declaredPaths(event: AgentEvent, cwd: string): string[]   // absolutos
  // tracker.ts
  export function createTurnTracker(deps: {
    store: UndoStore; resolver: ReturnType<typeof createRepoResolver>; queue: ReturnType<typeof createSerialQueue>
    projectPath(projectId: number): string | null
    holdInput?(ctx: UndoCtx): void          // lança UserError('undo_writing') durante a escrita de um desfazer no repo
    onTurnOpened?(turnId: number): void; onTurnClosed?(turnId: number): void
    log?(m: string): void
  }): TurnObserver & {
    boot(): Promise<void>; idle(): Promise<void>; openSegment(localId: string): number | undefined
    takeMark(repo: RepoInfo, kind: MarkKind): Promise<number>   // marco fora de turno (desfazer); active = trechos abertos do repo
  }
  ```
- **`declaredPaths`**, uma regra para os quatro motores:
  - vale `tool_use` de `assistant` cujo nome casa `/edit|write|patch|replace|create|notebook|file_change/i`;
  - os caminhos vêm de `file_path`, `filePath`, `notebook_path`, `path` e `changes[].path` (o `file_change` do Codex);
  - o input pode vir em string JSON (Kimi);
  - caminho relativo resolve contra `cwd`.
- **Regras do rastreador:**
  - **`onInput`:**
    1. chama `holdInput`;
    2. pega `takeNote` do terminal, monta o texto final e chama `send(final)`;
    3. só depois grava, e só aí a nota é consumida.

    A origem vira `goal` quando o texto começa com `[Claudinei: goal` e `claudinei` vale o resto do `sendAsClaudinei`.
    - Com trecho aberto na sessão: fecha-o e abre o novo com **um** marco `message` (`mid_turn = 1`).
    - Sem trecho aberto: abre com marco `turn_start`.
    - `text_key = turnKey(final)`.
  - **`onStatus('working')`** sem trecho aberto: decide numa microtask. Se `compaction()` é falso e ainda não há trecho, abre trecho `engine` sem texto.
  - **Saída de `working`** (`idle`, `needs_attention`, `dead`, `stopped`): numa microtask, fecha com marco `turn_end`. O fim:
    - `result`, ou `interrupted` se o result veio com subtipo `interrupted`/`error_during_execution`;
    - `cut`, sem result;
    - `dead`;
    - `stopped`, que vira `restart` com `shuttingDown`.

    `conversation_id = info.engineSessionId`. Status de compactação sem trecho é ignorado.
  - **`onEvent`:**
    - `tool_use` antes de o marco de início do trecho terminar → `markLate`;
    - caminhos declarados → `addDeclared`, relativos ao topo;
    - `system`/`turn_started` (Codex, Task 11) → `setAnchor(raw.turnId)` no trecho aberto.
  - **`onInteractive`:** `open` abre trecho `interactive` com marco `terminal_open`; `close` fecha com `terminal_close`.
  - **Pasta sem git:** linha com `snapshot = 'no_git'`, sem marco. Falha do git: `snapshot = 'failed'` com o `message`.
  - **`active` de cada marco:** calculado na hora do pedido (síncrono), a partir dos trechos abertos do mesmo repositório, já com a mudança aplicada.
  - **`boot()`:** todo turno aberto ganha um marco `turn_end` agora e o fim `uncertain`.
  - **`limited`:** o modo do marco de início. O `previousListing` vem do último marco do repositório.

- [ ] **Step 1: Escrever os testes que falham** (repos temporários, observador chamado direto, `idle()` para esperar a fila):
  - `mensagem abre trecho com marco turn_start e o fim fecha com turn_end`;
  - `mensagem no meio do turno fecha o trecho e abre outro num marco só (mid_turn)`;
  - `turno aberto pelo motor ganha origem engine`;
  - `compactação não abre trecho`: `compaction()` verdadeiro;
  - `fins`: `cut` (idle sem result), `interrupted`, `dead`, `restart` com `shuttingDown`;
  - `retrato atrasado`: `tool_use` antes do marco de início pronto (fila travada por uma promessa) → `snapshot = 'late'`;
  - `send que lança não grava trecho nem consome a nota`;
  - `nota files reverted vai na frente uma vez só`: duas mensagens seguidas, só a primeira leva;
  - `holdInput lança e a mensagem não sai`;
  - `pasta sem git grava no_git sem chamar git`;
  - `active: dois terminais no mesmo repo, o marco do segundo início lista os dois`;
  - `boot fecha turno aberto como uncertain`;
  - `interativo: open/close viram um trecho interactive`;
  - declared:
    - `Edit/Write/MultiEdit/NotebookEdit do Claude`;
    - `file_change do Codex com changes[].path`;
    - `edit do OpenCode com filePath`;
    - `ferramenta do Kimi com input em string JSON`;
    - `Bash não declara`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(desfazer): rastreador de turnos por mensagem`.

### Task 7: Ganchos no manager: observador, sessão viva e relançar com id segurado

**Files:**
- Modify: `server/src/claude/manager.ts`. Mudanças pequenas e localizadas:
  - dep `turnObserver`;
  - função interna `sendVia`;
  - uma linha em cada um dos cinco envios;
  - duas linhas no `wire` (status e evento);
  - duas no `openInTerminal` (abrir e o `onExit`);
  - métodos `liveSession` e `relaunch`;
  - a trava do id (`holdEngineId`) no `persist`, no `effectiveEngineSessionId` e no `infoOf`.
- Modify: `server/src/engine/types.ts`: `EngineSessionOptions.extraArgs?: string[]`, uma linha.
- Modify: `server/src/engine/claude-engine.ts`: repassa `extraArgs` ao `ClaudeSession` (que já os acrescenta) e exporta `claudeConfigDir`.
- Test: `server/test/manager-undo-hooks.test.ts`

**Interfaces:**
- Consumes: `TurnObserver`, `UndoCtx` (Task 6).
- Produces:
  ```ts
  // Deps
  turnObserver?: TurnObserver
  // interno
  const sendVia = (entry, localId, text, origin, doSend: (t: string) => void) =>
    deps.turnObserver ? deps.turnObserver.onInput({ localId, projectId: entry.projectId, engine: entry.engine }, text, origin, doSend) : doSend(text)
  // métodos novos
  liveSession(localId: string): EngineSession | undefined
  relaunch(localId: string, opts: { resumeSessionId: string | null; extraArgs?: string[]; holdEngineId?: boolean }): Promise<SessionInfo>
  ```
- **Os cinco envios passam por `sendVia`:** `send` (operador; o `/compact` não passa), `sendAsClaudinei`, `askAgent`, `sendAndWait` e `dispatchTask`, com as origens que cada um já grava. A ordem de hoje se mantém: o `entry.origin` e o `onOperatorMessage` continuam depois do envio aceito.
- **`wire`:**
  - `session.on('status')` chama `turnObserver.onStatus(ctx, status, { compaction: () => !!live.get(localId)?.compactTurn, engineSessionId: session.sessionId ?? null, shuttingDown })`;
  - `session.on('event')` chama `onEvent`.

  Os dois ficam em `try/catch`, como os demais ganchos.
- **`openInTerminal`:** `onInteractive('open')` depois do `persist(... 'in_terminal' ...)`; `onInteractive('close')` no `onExit` que volta a `stopped`.
- **`relaunch`:**
  1. lê a linha da sessão; para a sessão viva (`await stop()`, `live.delete`);
  2. `makeSession` com os dados da linha, `continueLatest: false`, `resumeSessionId` e `extraArgs`;
  3. `wire(..., { holdEngineId })`.

  Com a trava:
  - o `persist` grava `null` no id (o `COALESCE` mantém o antigo) e não chama `recordThread`;
  - `effectiveEngineSessionId` e `infoOf` devolvem o id do banco;
  - o primeiro evento `result` da sessão solta a trava, grava o id e publica o `session_status`;
  - morte antes disso deixa o banco com o id antigo.

- [ ] **Step 1: Escrever os testes que falham** (fake-claude via `sessionFactory`, observador espião):
  - `os cinco envios chamam onInput com a origem certa e mandam o texto final que ele devolve`;
  - `onInput que lança: send do operador lança e onOperatorMessage não é chamado`;
  - `/compact não passa pelo observador; o status working dele chega com compaction() verdadeiro`;
  - `onStatus e onEvent chegam com localId, projectId e engine`;
  - `openInTerminal chama onInteractive open e o onExit chama close` (lançador falso);
  - `relaunch passa extraArgs e resumeSessionId ao sessionFactory e mantém o localId`;
  - `relaunch com holdEngineId: antes do primeiro result o banco e o session_status mostram o id antigo; depois, o novo` (fake com `FAKE_SESSION_ID`);
  - `relaunch com trava e processo que morre antes do result: banco com o id antigo e project_threads sem o novo` (mensagem `crash`; Review Focus 5);
  - `buildClaudeArgs + extraArgs: claude-engine repassa extraArgs ao ClaudeSession`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `manager.test.ts`, `manager-restart.test.ts`, `engine-manager.test.ts`, `claude-engine.test.ts`, `next-send-order.test.ts`, `goal.test.ts` e `routes-orchestrator.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(desfazer): ganchos do manager para turnos e relançar com id segurado`.

### Task 8: Atribuição entre terminais e o resumo do turno

**Files:**
- Create: `server/src/undo/attribution.ts`
- Test: `server/test/undo-attribution.test.ts`

**Interfaces:**
- Consumes: `changedFiles` (Task 3), store (Task 5).
- Produces:
  ```ts
  export type FileClass = 'own' | 'uncertain'
  export interface AttributedFile extends FileChange { class: FileClass; overlapped: boolean; inProject: boolean }
  export interface Viewer { isAdmin: boolean }
  export function attributeTurn(repo: RepoInfo, store: UndoStore, turn: TurnRow, projectRel: string): Promise<AttributedFile[]>
  export function summarize(files: AttributedFile[], viewer: Viewer): TurnSummary   // não-admin conta só inProject; o resto em outside
  export function listIntervals(store: UndoStore, repoKey: string, limit?: number /* 50 */): Array<{ from: MarkRow; to: MarkRow; kind: 'between' | 'undo' }>
  ```
- **Regras** (spec, "Vários terminais na mesma pasta"):
  1. Os intervalos de T são os pares seguidos de `marksRange(start, end)`.
  2. Se todo intervalo tem `active === [T]`, há um `changedFiles` só (início→fim) e tudo é `own`.
  3. Senão, há um `changedFiles` por intervalo; o arquivo que mudou num intervalo com outros ativos fica:
     - `own`, se T declarou o caminho e nenhum outro ativo declarou;
     - `uncertain`, se ninguém declarou;
     - `overlapped = true` e `own`, se outro ativo declarou (decisão: mexido por outro terminal na janela vira conflito na prévia).
  4. O resultado final usa o diff líquido início→fim. Arquivo que mudou e voltou não entra.
  5. `inProject`: o caminho começa com `projectRel` (o caminho do projeto relativo ao topo; vazio = repo inteiro).
  6. Intervalos de `listIntervals`: `active` vazio no marco `from`; `kind: 'undo'` quando `from.kind === 'undo_pre'`.

- [ ] **Step 1: Escrever os testes que falham** (dois terminais simulados com o rastreador da Task 6 e escrita direta no disco):
  - `turno sozinho: tudo own`;
  - `sobrepostos, caminho declarado só por A: own em A, fora de B`;
  - `sobrepostos sem declaração: uncertain nos dois`;
  - `os dois declararam: overlapped`;
  - `mudança fora de turno vira intervalo between e não entra em nenhum turno`;
  - `arquivo que mudou e voltou no turno não aparece`;
  - `summarize de não-admin: fora da pasta do projeto vira outside`;
  - `subagente dentro do turno conta como o turno` (escrita sem declaração com um ativo só → `own`).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(desfazer): atribuição entre terminais da mesma pasta`.

### Task 9: O serviço de desfazer e refazer

**Files:**
- Create: `server/src/undo/service.ts`
- Test: `server/test/undo-service.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces (DTOs em `shared/undo.ts`):
  ```ts
  export interface PreviewFile { path: string; class: FileClass; verdict: RestoreVerdict; mergeable: boolean; overlapped: boolean; checked: boolean; sinceTurn?: string }
  export interface UndoPreview {
    token: string                       // sha1 dos nowDigest em ordem; o apply recusa se mudou
    turnIds: number[]
    blockedBy: { kind: 'working' | 'in_terminal'; terminal: string | null } | null
    branchChanged: { from: string | null; to: string | null } | null
    files: PreviewFile[]                // own e uncertain; uncertain nasce checked=false; overlapped vira conflict
    notUndoable: FileChange[]           // too_big, unsnapshotted, submodule
    hiddenOutside: number
  }
  export interface UndoRunDto { id: number; kind: 'undo' | 'redo'; turnIds: number[]; files: Array<{ path: string; result: RestoreResult }>; redone: boolean }
  export function createUndoService(deps: {
    db: Db; store: UndoStore; resolver; queue; manager: Pick<SessionManager, 'list'>
    projects: { get(id: number): { id: number; name: string; path: string } | undefined }
    canSee(viewer: ViewerFull, projectId: number): boolean
    broadcast(m: object): void
    takeMark(repo: RepoInfo, kind: MarkKind): Promise<number>    // o `takeMark` do rastreador (Task 6)
    onWriteEnd?(repoTop: string): void                           // a Task 10 liga ao cutucão do árbitro
  }): {
    summarizeTurn(turnId: number): Promise<void>                 // grava summary e publica { type: 'undo_turn', ... }
    turnFiles(turnId: number, viewer: ViewerFull): Promise<{ files: AttributedFile[]; hiddenOutside: number }>
    turnDiff(turnId: number, path: string, viewer: ViewerFull): Promise<FileDiff>
    preview(turnIds: number[], viewer: ViewerFull): Promise<UndoPreview>
    apply(turnIds: number[], req: { token: string; decisions: Record<string, RestoreAction> }, viewer: ViewerFull, opts?: { note?: boolean }): Promise<UndoRunDto>
    previewRedo(runId: number, viewer: ViewerFull): Promise<UndoPreview>
    redo(runId: number, req: { token: string; decisions: Record<string, RestoreAction> }, viewer: ViewerFull): Promise<UndoRunDto>
    holdInput(ctx: UndoCtx): void                                // para o rastreador: lança UserError('undo_writing') no repo em escrita
    holds(projectId: number, engine: string): boolean            // para o árbitro: repo em escrita
  }
  export interface ViewerFull { isAdmin: boolean; projectIds: number[] | 'all' }
  ```
- **Prévia com vários turnos** (Editar a partir daqui, Task 13): para cada arquivo, "antes" é o marco de início do **primeiro** turno da lista que o mexeu e "depois" é o marco de fim do **último**.
- **Bloqueio:**
  - alguma sessão viva de projeto cuja pasta resolve ao mesmo topo está `working`;
  - ou alguma sessão `in_terminal` de projeto do mesmo topo.

  O nome que aparece é o do projeto, ou `null` sem acesso.
- **`branchChanged`:** o `branch`/`head` do marco de fim do último turno, comparado com o de agora.
- **`apply`:**
  1. Recusa com `UserError`:
     - `undo_blocked` com bloqueio;
     - `undo_unavailable` se algum turno está em `late`/`failed`/`no_git`/`lost`/`running`;
     - `undo_changed` (409, com `preview` no corpo) se o `token` não bate.
  2. Liga a escrita do repo (`holdInput`/`holds`).
  3. `takeMark('undo_pre')` e `prepareRestore`.
  4. Na seção síncrona: reconfere o bloqueio e roda `applyPrepared`.
  5. `takeMark('undo_post')`.
  6. Desliga a escrita e grava o `undo_runs`.
  7. Com `opts.note !== false`, `addNote(projeto, motor, revertidos)`.
  8. Publica `{ type: 'undo_run', projectId, engine, run }` e chama `onWriteEnd(repo.top)`. Também chama `onWriteEnd` se a escrita falhar no meio.
- **Retrato perdido:** `turnFiles`, `turnDiff` e `preview` conferem `commitExists` nos marcos do turno. Faltando algum, gravam `setSnapshot(id, 'lost')` e respondem `UserError('snapshot_lost')`.
- **Refazer:** desfazer de novo, com `before = pre_mark` e `after = post_mark`, só nos arquivos com `reverted`/`merged`/`forced`, com as mesmas três comparações. Marca `redone_at` no run original. Não gera nota.

- [ ] **Step 1: Escrever os testes que falham:**
  - `prévia: own marcado, uncertain desmarcado, overlapped vira conflict`;
  - `apply volta os arquivos e grava a nota uma vez`;
  - `bloqueado com outro terminal working no mesmo repo e com in_terminal; nome vira null sem acesso`;
  - `token velho: 409 undo_changed sem escrever` (Review Focus 2);
  - `turno late ou failed: undo_unavailable`;
  - `turno antigo com turno depois mexendo no mesmo arquivo: cai em conflict`;
  - `branchChanged depois de checkout`;
  - `refazer volta o que o desfazer tirou; com o arquivo mexido depois, conflict`;
  - `holdInput lança durante a escrita e holds fica verdadeiro`;
  - `não-admin: arquivo fora do projeto não entra na prévia e fica em hiddenOutside; turnDiff de caminho fora recusa com forbidden_path`;
  - `várias turnIds: cada arquivo volta ao início do primeiro turno que o mexeu`;
  - `ref apagada: turnFiles grava lost e responde snapshot_lost`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(desfazer): prévia, desfazer e refazer com as três comparações`.

### Task 10: Retenção, subida, rotas e ligação no servidor

**Files:**
- Create: `server/src/undo/retention.ts`, `server/src/routes/undo.ts`, `server/src/undo/index.ts`, este com a montagem `createUndo(...)` que junta store, rastreador, serviço e retenção
- Modify:
  - `server/src/app.ts`:
    - `onUndoReady` no `AppDeps`;
    - criação do conjunto de desfazer;
    - `registerUndoRoutes`;
    - `holds` ganha `|| undo.holds(projectId, engine)`.
  - `server/src/index.ts`:
    - `turnObserver` do manager delegando a `undo?.tracker`;
    - `undo.boot()` depois do listen;
    - `setInterval` diário (`unref`) da retenção, desligado no shutdown.
- Test: `server/test/undo-retention.test.ts`, `server/test/routes-undo.test.ts`

**Interfaces:**
- `retention.ts`:
  ```ts
  export function runRetention(deps: { store; db; resolver; now?: () => number; maxAgeDays?: 30; perTerminal?: 200 }): Promise<{ turns: number; marks: number }>
  ```
  1. Apaga turnos com `ended_at` mais velho que 30 dias e os que passam dos 200 mais novos por (`project_id`, `engine`).
  2. Apaga os desfazeres cujos turnos sumiram.
  3. Um marco fica se:
     - é início ou fim de turno restante;
     - está dentro da janela de um turno restante (mesma chave, `n` entre o início e o fim);
     - ou é `pre_mark`/`post_mark` de um desfazer restante.

     O resto sai do banco e do git (`deleteRefs`).
  4. Listagens sem marco somem.

  Nunca roda `gc`.
- **Rotas** (`registerUndoRoutes(app, { undo, rewind?, manager, db })`):
  - a autorização segue `requireProjectAccess` no projeto do turno ou da sessão;
  - o `ViewerFull` sai de `req.authUser`, e sem auth vale admin;
  - lista de turnos ids de terminais diferentes → 400 `undo_mixed_terminals`.

  | Método e rota | Corpo | Resposta |
  |---|---|---|
  | `GET /api/undo/terminals/:localId/turns` | — | `{ git: boolean; turns: TurnDto[]; outside: TurnDto[]; interactive: TurnDto[]; intervals: IntervalDto[] }` |
  | `GET /api/undo/turns/:id/files` | — | `{ files: AttributedFile[]; hiddenOutside: number; warnings: string[] }` |
  | `GET /api/undo/turns/:id/diff?path=` | — | `FileDiff` |
  | `GET /api/undo/intervals/:from/:to/files` e `/diff?path=` | — | idem, para "Mudanças entre turnos" |
  | `POST /api/undo/preview` | `{ turnIds }` | `UndoPreview` |
  | `POST /api/undo/apply` | `{ turnIds, token, decisions }` | `UndoRunDto` ou 409 `{ code: 'undo_changed', preview }` |
  | `POST /api/undo/runs/:id/redo/preview` e `/redo` | idem | idem |

  - `turns` traz os turnos da conversa atual: `conversation_id` igual ao id da sessão e `rewound_at` nulo.
  - `outside` traz os demais do terminal ("Fora da conversa atual").
  - `IntervalDto = { from: number; to: number; kind: 'between' | 'undo'; at: string }`.
- **Ligações:**
  - o rastreador chama `undo.summarizeTurn` no `onTurnClosed`;
  - o serviço cutuca `nextSend.poke` dos terminais do repo quando a escrita termina (referência mutável, como o `taskWake`);
  - mensagens WS: `undo_turn` (com `projectId` e `localId`) e `undo_run` (com `projectId`), filtradas pelo `canSee` de `ws.ts` sem mudança, porque ambas trazem `projectId`.

- [ ] **Step 1: Escrever os testes que falham:**
  - retenção:
    - `turno de 31 dias some e a ref dele também`;
    - `o 201º turno do terminal some`;
    - `marco dentro da janela de turno restante fica`;
    - `pre/post de desfazer restante ficam`;
    - `excluir o terminal apaga os turnos e a retenção apaga as refs`;
  - rotas com `app.inject`:
    - `não-admin sem acesso ao projeto: 403`;
    - `não-admin com acesso: arquivos fora da pasta do projeto viram hiddenOutside`;
    - `apply com turnos de dois terminais: 400`;
    - `apply com token velho: 409 com a prévia nova`;
    - `turns separa conversa atual, fora da conversa e interativos`;
  - ligação:
    - `subida fecha turno aberto como uncertain` (via `startAfterListen` ou `undo.boot` no teste do app);
    - `holds do árbitro verdadeiro durante a escrita`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `routes-orchestrator.test.ts`, `next-send-order.test.ts`, `restart-boot.test.ts` e `auth-rbac.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(desfazer): retenção, rotas e ligação no servidor`.

### Task 11: O Codex sabe voltar a conversa

**Files:**
- Modify: `server/src/engine/codex/codex-session.ts`:
  - no `turn/started`, emite `{ kind: 'system', subtype: 'turn_started', raw: { turnId } }`;
  - três métodos novos.
- Modify: `server/src/engine/codex/rollout.ts`: `forgetRollout(root, threadId)` limpa o `rolloutCache` daquele thread.
- Modify: `server/test/fake-codex.mjs`: `thread/revert` (responde `{ thread: { id, turns: [] }, … }` e notifica `thread/reverted`), `thread/fork` (devolve `{ thread: { id: 'FORK-' + n } }`; recusa sem `excludeTurns` com -32600) e `thread/turns/list` (pagina os turnos guardados em memória).
- Create: `server/src/undo/rewind-codex.ts`
- Test: `server/test/codex-rewind.test.ts`

**Interfaces:**
- `CodexSession`:
  ```ts
  revertConversation(beforeTurnId: string): Promise<void>     // ensureReady; recusa com operação em curso; 'thread/revert' { threadId, beforeTurnId }
  forkConversation(lastTurnId: string): Promise<string>         // 'thread/fork' { threadId, lastTurnId, excludeTurns: true, cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' } → thread.id
  listTurns(): Promise<Array<{ id: string; userTexts: string[] }>>  // 'thread/turns/list' { threadId, sortDirection: 'desc', itemsView: 'full', limit: 20, cursor }, até acabar; textos dos itens userMessage (content[].type === 'text')
  ```
  Formas conferidas no protocolo gerado (`codex app-server generate-ts`, 0.159.2: `ThreadRevertParams`, `ThreadForkParams.excludeTurns`, `ThreadTurnsListParams`, `Turn.items`, `UserInput`).
- `rewind-codex.ts`:
  ```ts
  export type CodexCut = { kind: 'codex'; beforeTurnId: string; previousTurnId: string | null; midTurn: boolean }
  export function locateCodexCut(turns: Array<{ id: string; userTexts: string[] }>, key: string, occurrence: number): CodexCut | null
  export function createCodexRewind(deps: { manager: Pick<SessionManager, 'liveSession' | 'relaunch' | 'revive' | 'get'> }): RewindAdapter
  ```
  - `locateCodexCut` procura de trás para frente a `occurrence`-ésima ocorrência de `turnKey(texto) === key`. `midTurn` é verdadeiro quando o texto não é o primeiro `userMessage` do turno.
  - `apply`:
    1. revive se a sessão não está viva;
    2. `revertConversation(beforeTurnId)`, e depois `forgetRollout(sessionsRoot(), threadId)`;
    3. se der `CodexRpcError`: com `previousTurnId`, `forkConversation(previousTurnId)` e `manager.relaunch(localId, { resumeSessionId: novo })`; sem ele, `relaunch(localId, { resumeSessionId: null })`.
    4. Devolve `{ newConversationId?: string }`.
- `RewindAdapter` (em `server/src/undo/rewind.ts`, criado aqui só com o tipo):
  ```ts
  export interface RewindAdapter {
    locate(ctx: { localId: string; projectPath: string; engineSessionId: string | null; turn?: TurnRow }, key: string, occurrence: number): Promise<ConversationCut | null>
    apply(ctx: { localId: string; projectPath: string; engineSessionId: string | null }, cut: ConversationCut): Promise<{ newConversationId?: string }>
  }
  export type ConversationCut = CodexCut | ClaudeCut
  ```
  O `locate` do Codex prefere o `anchor` do turno gravado (`ctx.turn`, com `mid_turn`) e só cai no `listTurns` sem ele.

- [ ] **Step 1: Escrever os testes que falham:**
  - `turn/started emite system turn_started com o id`;
  - `revertConversation manda thread/revert com beforeTurnId e o thread segue o mesmo`;
  - `revert recusado cai no fork com excludeTurns e relaunch no id novo`;
  - `editar o primeiro turno com revert recusado abre conversa nova`;
  - `locateCodexCut: mensagem de steer (segundo userMessage do turno) dá midTurn`;
  - `occurrence 1 pega a penúltima ocorrência do mesmo texto`;
  - `forgetRollout faz findRolloutCached varrer de novo` (dois arquivos `rollout-…-<id>.jsonl` e `…-<id>_<novo>.jsonl`, o novo mais recente).
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `codex-session.test.ts`, `codex-rollout.test.ts`, `codex-engine.test.ts` e `engine-integration.test.ts`.
- [ ] **Step 5: Commit** `feat(desfazer): o Codex volta a conversa com thread/revert, ou fork se recusar`.

### Task 12: O Claude sabe voltar a conversa

**Files:**
- Create: `server/src/undo/rewind-claude.ts`
- Test: `server/test/claude-rewind.test.ts`, `server/test/fixtures/rewind-transcript.jsonl` (transcript pequeno com mensagens repetidas, `isMeta`, tool_result, `isSidechain` e resumo de compactação)

**Interfaces:**
- Consumes: `transcriptPath` (`server/src/history.ts`), `claudeConfigDir` (Task 7), `manager.relaunch` (Task 7), `turnKey`.
- Produces:
  ```ts
  export type ClaudeCut = { kind: 'claude'; parentUuid: string | null }
  export function findClaudeCut(transcriptFile: string, key: string, occurrence: number): Promise<ClaudeCut | null>
  export function claudeForkArgs(atUuid: string, newSessionId: string): string[]
    // ['--resume-session-at', atUuid, '--fork-session', '--session-id', newSessionId]; os dois validados como uuid
  export function createClaudeRewind(deps: { manager: Pick<SessionManager, 'relaunch' | 'get'>; newId?: () => string }): RewindAdapter
  ```
- **`findClaudeCut`** lê o transcript linha a linha. Vale a entrada com:
  - `type === 'user'`;
  - sem `isMeta`, `isSidechain` ou `isCompactSummary`;
  - conteúdo de texto, sem `tool_result` e sem `<command-name>`.

  Procura de trás para frente a `occurrence`-ésima entrada com `turnKey(texto) === key` e devolve o `parentUuid` dela (ensaio C2: o corte é inclusivo, então é a entrada anterior). Não achou → null.
- **`apply`:**
  - com `parentUuid`: `relaunch(localId, { resumeSessionId: <id atual>, extraArgs: claudeForkArgs(parentUuid, novo), holdEngineId: true })` e devolve `{ newConversationId: novo }`;
  - com `parentUuid` nulo (primeira mensagem): `relaunch(localId, { resumeSessionId: null, holdEngineId: true })`.
- **Rótulo da conversa:** o serviço de volta (Task 13) guarda em memória `{ localId, newId, keptTurnIds }`. No `onTurnClosed` de um turno com `conversation_id === newId`, chama `setConversation(keptTurnIds, newId)`. Se o serviço reiniciar antes, esses turnos ficam em "Fora da conversa atual", ainda desfazíveis.

- [ ] **Step 1: Escrever os testes que falham:**
  - `findClaudeCut devolve o parentUuid da mensagem, não o uuid` (ensaio C2);
  - `ignora isMeta, isSidechain, tool_result e resumo de compactação`;
  - `occurrence conta de trás para frente entre textos iguais`;
  - `primeira mensagem: parentUuid null`;
  - `texto que não existe: null`;
  - `claudeForkArgs recusa valor que não é uuid`;
  - `apply chama relaunch com --resume do id atual, os args do fork e holdEngineId` (manager espião);
  - `apply da primeira mensagem relança sem resume`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(desfazer): o Claude volta a conversa com --resume-session-at e --fork-session`.

### Task 13: Editar a partir daqui (serviço e rotas)

**Files:**
- Modify: `server/src/undo/rewind.ts` (o tipo veio da Task 11): `createRewindService`
- Modify:
  - `server/src/routes/undo.ts`: duas rotas;
  - `server/src/undo/index.ts`: monta o serviço com `{ claude, codex }`; o `onTurnClosed` do rastreador chama também `rewind.onTurnClosed`;
  - `server/src/app.ts`: `holds` ganha `|| rewind.holds(...)`, na mesma linha da Task 10.
- Modify: `server/test/fake-claude.mjs`: dois comportamentos, `escreve:<rel>=<texto>` (grava o arquivo na pasta e emite `tool_use` Write com `file_path`) e `bash-escreve:<rel>=<texto>` (grava sem declarar).
- Test: `server/test/undo-rewind.test.ts`

**Interfaces:**
- DTOs (em `shared/undo.ts`):
  ```ts
  export interface RewindTarget { turnId?: number; text: string; occurrence: number }    // occurrence 0 = a última com essa chave
  export type RewindMode = 'conversation' | 'conversation_and_files'
  export type RewindReason = 'engine_unsupported' | 'codex_mid_turn' | 'anchor_not_found' | 'no_git' | 'no_snapshot' | 'snapshot_late' | 'snapshot_lost' | 'no_session'
  export interface Availability { enabled: boolean; reason?: RewindReason; params?: Record<string, string> }
  export interface RewindOptionsDto { engine: string; conversation: Availability; files: Availability & { preview?: UndoPreview }; filesTouched: boolean; working: boolean }
  export interface RewindResultDto { conversationRewound: boolean; run?: UndoRunDto; error?: { code: string; message: string } }
  ```
- Serviço:
  ```ts
  export function createRewindService(deps: {
    manager: SessionManager; store: UndoStore; undo: UndoService; adapters: Record<string, RewindAdapter>   // { claude, codex }
    projects; nextSend: () => NextSend | undefined; waitFreeMs?: number /* 15_000 */
  }): {
    options(localId: string, target: RewindTarget, viewer: ViewerFull): Promise<RewindOptionsDto>
    execute(localId: string, req: { target: RewindTarget; mode: RewindMode; editedText: string; token?: string; decisions?: Record<string, RestoreAction> }, viewer: ViewerFull): Promise<RewindResultDto>
    holds(projectId: number, engine: string): boolean     // terminal em volta: o árbitro não entrega nada
    onTurnClosed(turnId: number): void                     // rótulo da conversa do Claude (Task 12)
  }
  ```
  Rotas:
  - `POST /api/undo/terminals/:localId/rewind/options` com `{ target }` → `RewindOptionsDto`;
  - `POST /api/undo/terminals/:localId/rewind` com `{ target, mode, editedText, token?, decisions? }` → `RewindResultDto`.
- **`options`:**
  - motor sem adaptador → `conversation` e `files` desligados com `engine_unsupported`;
  - `locate` nulo → `anchor_not_found`;
  - Codex com `midTurn` → os dois desligados com `codex_mid_turn`.
  - O trecho é o turno do alvo (`turnId` ou o `occurrence`-ésimo com a chave, de trás para frente, entre os turnos da conversa atual) mais todos os seguintes do terminal na conversa atual.
  - `files` fica desligado:
    - sem git (`no_git`);
    - sem turno gravado para o alvo (`no_snapshot`);
    - com algum turno do trecho em `late`/`failed`/`lost`.

    Ligado, traz a `preview` (Task 9).
  - `filesTouched`: algum turno do trecho tem `summary.files > 0` ou caminhos declarados.
- **`execute`, na ordem da spec:**
  1. Liga `holds` do terminal.
  2. Se a sessão está `working`: `manager.interrupt` e espera ficar livre (até `waitFreeMs`, senão `UserError('rewind_turn_stuck')`).
  3. Arquivos (`conversation_and_files`): `undo.apply(turnIds, { token, decisions }, viewer, { note: false })`. Se falhar, para aqui, sem tocar na conversa.
  4. Conversa: `adapter.locate` + `apply`. Se falhar, devolve `{ conversationRewound: false, run, error }`; os arquivos desfeitos ficam desfeitos.
  5. `markRewound` nos turnos do trecho. Com `newConversationId` do Codex (fork), `setConversation` nos anteriores na hora; no Claude, guarda o rótulo pendente.
  6. Texto: com `mode === 'conversation'` e `filesTouched`, vai `withNote(CONVERSATION_REWOUND_NOTE, editedText)`; senão, `editedText`. Sai em `manager.send(localId, texto, { echo: true })`, que pausa o goal e passa pelo rastreador como mensagem do operador.
  7. Desliga `holds` e chama `nextSend.poke`.

- [ ] **Step 1: Escrever os testes que falham** (manager real com o fake-claude, adaptador Claude com o `relaunch` espiado, repo temporário):
  - `options: kimi e opencode desligados com engine_unsupported e o motor nos params`;
  - `options: sem git, files desligado com no_git e conversation ligado`;
  - `options: mensagem anterior ao recurso (sem turno gravado) tem conversation ligado e files no_snapshot`;
  - `execute conversation: relança com o corte e manda o texto com a nota conversation rewound quando o trecho mexeu em arquivos`;
  - `execute conversation sem mudanças: texto sem nota`;
  - `execute conversation_and_files: arquivos primeiro (sem nota files reverted), depois a conversa, depois o envio` (ordem conferida pelos espiões);
  - `cancelar na prévia de arquivos não faz nada`: `token` velho → 409 e a conversa intacta;
  - `falha da volta no motor: run devolvido, conversationRewound false e nada enviado`;
  - `com o agente trabalhando: interrompe antes e espera livre`;
  - `holds verdadeiro durante a volta: a fila do operador não entrega no meio` (item na fila e `onSessionAvailable` disparado no meio);
  - `turnos do trecho vão para fora da conversa atual e continuam desfazíveis`;
  - `mensagem do operador pausa o goal` (goal ativo → `paused` com `operator`);
  - `escreve: e bash-escreve: do fake geram turno com diff; só o primeiro declara`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar a suíte do servidor inteira (`PATH=$N24:$PATH npx vitest run`) e `npx tsc --noEmit`. A falha intermitente conhecida do orchestrator se confere rodando o arquivo isolado.
- [ ] **Step 5: Commit** `feat(desfazer): editar a partir daqui volta a conversa e os arquivos`.

### Task 14: Web: dados dos turnos, notas no chat e posição das linhas

**Files:**
- Create: `web/src/undo/api.ts`, `web/src/undo/undoStore.ts`, `web/src/undo/attachTurns.ts`, `web/src/undo/declared.ts`
- Modify:
  - `web/src/chat/applyEvent.ts`: as duas notas viram itens `claudinei_message` antes do `user_text`;
  - `web/src/types.ts`: `reason: 'files_reverted' | 'conversation_rewound'`;
  - `web/src/App.tsx`: uma linha, `applyUndoWsMessage(msg)` ao lado do `applyWsMessage`;
  - `web/src/components/MessageBlock.tsx`: desenho das duas notas no `case 'claudinei_message'`, uma linha discreta;
  - `web/src/i18n/{pt-BR,en,es}.ts`: chaves `undo.*`.
- Test: `web/src/test/undo-attach.test.ts`, `web/src/test/undo-store.test.ts`, `web/src/test/applyEvent.test.ts` (casos novos), `web/src/test/undo-declared.test.ts`

**Interfaces:**
- `api.ts`: um `fetch…`/`post…` por rota das Tasks 10 e 13, com o `req` de `web/src/api.ts`, exportado para reuso. O 409 `undo_changed` chega como erro com `code` e `preview`.
- `undoStore.ts` (zustand próprio):
  ```ts
  interface UndoState {
    byLocal: Record<string, { git: boolean; turns: TurnDto[]; outside: TurnDto[]; interactive: TurnDto[]; intervals: IntervalDto[] } | undefined>
    load(localId: string): Promise<void>
    upsertTurn(t: TurnDto): void
  }
  export const useUndoStore: UseBoundStore<StoreApi<UndoState>>
  export function applyUndoWsMessage(msg: any): void   // 'undo_turn' → upsertTurn; 'undo_run' → load dos terminais carregados daquele projeto
  ```
  Recarrega ao reconectar: assina o mesmo evento que o `resyncOnReconnect` usa.
- `attachTurns.ts`:
  ```ts
  export interface TurnPlacement { turn: TurnDto; afterIndex: number; itemIndex: number | null }
  export function attachTurns(items: ChatItem[], turns: TurnDto[]): TurnPlacement[]
  export function occurrenceOf(items: ChatItem[], index: number): { key: string; occurrence: number }
  ```
  **Regra (decisão deste plano):**
  1. Os itens do lado do operador são comparados por `turnKey(item.text)`:
     - `user_text` sem `fromSubagent`/`fromEngine`;
     - `task_message` e `scheduled_message`;
     - `claudinei_message`, menos `files_reverted` e `conversation_rewound` (notas grudadas na mensagem seguinte, não turnos).
  2. Os turnos são casados do mais novo ao mais velho com o item casável mais recente antes do último casado.
  3. A linha vai depois do último item do bloco: o item antes do próximo item do lado do operador, ou o fim da lista.
  4. Turno sem texto (`engine`) ou não casado vai logo depois da linha do turno anterior casado.
  5. `interactive` não vai no chat.
- `declared.ts`:
  ```ts
  export interface DeclaredChange { path: string; kind: 'edit' | 'written' | 'patch' | 'path_only'; pairs?: Array<{ old: string; new: string }>; diff?: string }
  export function declaredChanges(items: ChatItem[]): DeclaredChange[]   // tool_call do bloco do turno, mesma regra de nomes da Task 6
  ```
  - Edit e MultiEdit dão `pairs`;
  - Write dá `written`, sem diff;
  - `file_change` do Codex dá o `diff` de cada `changes[]`;
  - `edit` do OpenCode dá `pairs` de `oldString`/`newString`;
  - o resto, `path_only`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `attachTurns`:
    - `casa do mais novo ao mais velho com textos repetidos`;
    - `linha depois do último item do bloco`;
    - `turno engine vai depois do anterior`;
    - `task_message e scheduled_message casam pela chave do corpo`;
    - `item sem turno não ganha linha`;
    - `occurrenceOf conta de trás para frente`;
  - `applyEvent`: `nota files reverted vira claudinei_message files_reverted e o user_text fica sem ela`, e o mesmo para `conversation rewound`;
  - store: `undo_turn insere e atualiza pelo id`, `undo_run recarrega o terminal do projeto`;
  - declared: `Write vira written sem diff`, `file_change traz o diff`, `Bash não entra`.
- [ ] **Step 2: Rodar e ver falhar.** `cd web && npx vitest run src/test/undo-attach.test.ts …`
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `src/test/applyEvent.test.ts` e `src/test/i18n.test.tsx`, depois `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(desfazer): web conhece os turnos, as notas e onde desenhar as linhas`.

### Task 15: Web: a linha do turno e o painel de mudanças

**Files:**
- Create: `web/src/components/undo/TurnLine.tsx`, `web/src/components/undo/ChangesPanel.tsx`, `web/src/components/undo/UnifiedDiff.tsx`, `web/src/components/undo/undo.css`
- Modify:
  - `web/src/components/ChatView.tsx`:
    - `useUndoStore.load(localId)` ao abrir a sessão;
    - `attachTurns` num `useMemo`;
    - no `renderNode`, as `TurnLine` cujo `afterIndex` é o último índice do nó;
    - o estado do painel aberto.
  - `web/src/i18n/{pt-BR,en,es}.ts`
- Test: `web/src/test/undo-turn-line.test.tsx`, `web/src/test/undo-changes-panel.test.tsx`

**Interfaces:**
- `TurnLine({ turn, items, onOpen, onUndo, onRedo })`:
  - Com git e `summary.files + summary.uncertain > 0`: "3 arquivos · +40 −12 · Ver mudanças · Desfazer". Com `lastRun` desfeito e não refeito, troca "Desfazer" por **Refazer**.
  - Selos:
    - `late`: "retrato atrasado", com o Desfazer desligado;
    - `failed`: "sem ponto de restauração: <motivo>";
    - `lost`: "retrato perdido";
    - `endKind === 'uncertain'`: "fim incerto";
    - `limited`: "Esta pasta tem muitos arquivos fora do git; ponha-os no .gitignore para o retrato completo";
    - `outside > 0`: "N arquivos fora deste projeto".
  - `no_git`: com `declaredChanges` do bloco não vazio, "Mudanças declaradas pelo agente · N arquivos · Ver" e o aviso fixo "Sem git: mudanças feitas por comandos não aparecem e não dá para desfazer". Sem declarações, nada.
  - Turno `running` ou sem mudanças: nada.
- `ChangesPanel({ localId, focus: { turnId } | { interval } | { declared: DeclaredChange[] }, onClose })`: modal, sem animação.
  - **Esquerda:** seções com a árvore de arquivos (pastas recolhíveis, +/− por arquivo):
    - o turno em foco;
    - "Pode ser de outro terminal" (`uncertain`);
    - "Fora da conversa atual" (`outside`);
    - "Mudanças entre turnos" e "Desfeito" (`intervals`);
    - "Feito no terminal interativo" (`interactive`).
  - **Direita:** o diff do arquivo clicado, buscado na hora (`GET …/diff`), desenhado por `UnifiedDiff`:
    - linhas `+`/`-`/contexto, sem realce de sintaxe;
    - aviso de corte em 2.000 linhas;
    - "binário, N KB";
    - `too_big`: "grande demais para o retrato" com o tamanho;
    - `unsnapshotted`: "mudou, sem retrato";
    - `submodule`: "submódulo mudou".
  - **Rodapé de ajuda:** as refs ocultas não aparecem em `git branch` nem `git log`, mas aparecem em `git log --all` e iriam num `git push --mirror`.
  - **Com `declared`:** sem rede; usa `pairs` com o `DiffView` existente e `diff` com o `UnifiedDiff`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `linha com resumo e botões; Refazer depois de desfeito`;
  - `retrato atrasado desliga o Desfazer`;
  - `sem git: linha declarada só com declarações e o aviso fixo`;
  - `turno sem mudanças não desenha linha`;
  - `o painel não busca diff antes do clique` (o `fetch` espiado só é chamado ao clicar no arquivo);
  - `binário e corte de 2000 linhas mostram o aviso`;
  - `seções: incertos, fora da conversa, entre turnos e interativo`;
  - `ChatView desenha a linha depois do último item do bloco` (em `chatview.test.tsx` ou arquivo novo);
  - `nenhum estilo novo usa animation, transition ou backdrop-filter`: lê `undo.css` e os `style` dos componentes, como o `sidebar-css.test.ts`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `chatview.test.tsx`, `chat-virtual.test.tsx` e `perf-render.test.tsx`, depois `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(desfazer): linha do turno e painel de mudanças`.

### Task 16: Web: a tela de desfazer e refazer

**Files:**
- Create: `web/src/components/undo/UndoDialog.tsx`
- Modify: `web/src/components/ChatView.tsx` (abre o diálogo a partir da `TurnLine`), `web/src/i18n/{pt-BR,en,es}.ts`
- Test: `web/src/test/undo-dialog.test.tsx`

**Interfaces:**
- `UndoDialog({ request: { turnIds: number[] } | { redoRunId: number }, onClose, onDone(run: UndoRunDto) })`:
  - busca a prévia ao abrir; com `blockedBy`, o botão fica desligado com "Esperando o turno de <terminal> terminar" (`null` → "outro terminal") e um "Tentar de novo" que rebusca;
  - `branchChanged` no topo: "O branch mudou desde o turno (era X, agora Y)";
  - listas:
    - "Vão voltar": os `revert`/`already`, marcados;
    - "Pode ser de outro terminal": `uncertain`, desmarcados, cada um com "ver diff";
    - "Conflitos": cada um mostra o `sinceTurn` e as três escolhas, "desfazer só as linhas do turno" (só com `mergeable`), "voltar ao antes mesmo assim (perde o que mudou depois)" e "manter como está".

      Um conflito de cada vez: o seguinte abre quando o atual tem escolha. O botão final só liga com todos escolhidos.
    - "Não dá para desfazer": `notUndoable`, sem caixa;
    - "N arquivos fora deste projeto".
  - Confirmar manda `{ token, decisions }`. O incerto desmarcado vai como `keep`, o marcado como `revert` (ou a escolha do conflito, se der).
  - O 409 `undo_changed` troca a prévia pela nova com o aviso "Os arquivos mudaram desde que você abriu esta tela".

- [ ] **Step 1: Escrever os testes que falham:**
  - `bloqueado mostra a espera com o nome ou "outro terminal"`;
  - `incerto nasce desmarcado e marcar manda revert`;
  - `conflitos um de cada vez; sem mergeable não há "só as linhas do turno"`;
  - `confirmar só liga com todos os conflitos escolhidos`;
  - `409 troca a prévia e avisa`;
  - `branch mudou aparece no topo`;
  - `refazer usa o mesmo diálogo com redoRunId`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar**, depois `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(desfazer): tela de desfazer com incertos e conflitos por arquivo`.

### Task 17: Web: editar a partir daqui

**Files:**
- Create: `web/src/components/undo/EditFromHereDialog.tsx`
- Modify:
  - `web/src/components/MessageBlock.tsx`: `onEdit?: (text: string, key?: string) => void`, repassando `item.key`;
  - `web/src/components/ChatView.tsx`: `handleEdit` abre o diálogo com `occurrenceOf`. Some o `ConfirmDialog` de editar durante o turno, porque o aviso passa para dentro do diálogo novo;
  - `web/src/i18n/{pt-BR,en,es}.ts`: `chat.editWorkingMsg` deixa de dizer que a conversa "recomeça dela" e vira "Editar interrompe o turno em andamento." nas três línguas;
  - `web/src/test/chat-edit.test.tsx`: atualizado ao fluxo novo.
- Test: `web/src/test/undo-edit-from-here.test.tsx`, `web/src/test/chat-edit.test.tsx`

**Interfaces:**
- `EditFromHereDialog({ localId, target: RewindTarget, initialText, onClose })`:
  - campo de texto com a mensagem;
  - busca `rewind/options` ao abrir;
  - três botões, **Voltar só a conversa**, **Voltar a conversa e os arquivos** e **Copiar para o campo** (o `requestEdit` de hoje).
  - Opção desligada mostra o motivo traduzido de `RewindReason`:
    - `engine_unsupported`: "O <motor> não deixa o Claudinei voltar a conversa";
    - `codex_mid_turn`: o Codex só volta turnos inteiros e esta mensagem entrou no meio de um;
    - `no_git`, `no_snapshot`, `snapshot_late`: sem retrato.
  - Com `working`: "Editar interrompe o turno em andamento."
  - "Voltar a conversa e os arquivos" abre o `UndoDialog` em modo de seleção (sem rede própria: devolve `{ token, decisions }`) e só então manda o `rewind`.
  - **Antes do envio:** a web corta o chat local a partir do item editado (ação nova `truncateFrom(localId, index)` no store do chat, pequena) e manda o `rewind`.
  - **Resposta:**
    - `conversationRewound: false`: recarrega o histórico (limpa `historyLoadedFor`), põe o texto editado no campo (`requestEdit`) e mostra "A conversa não voltou: <erro>. Os arquivos desfeitos ficam desfeitos; use Refazer se quiser trazê-los.";
    - sucesso: o eco da mensagem chega pelo WS. No Claude, o id novo chega depois do primeiro result e o histórico recarrega sozinho.

- [ ] **Step 1: Escrever os testes que falham:**
  - `Kimi/OpenCode: as duas opções desligadas com o motivo e Copiar para o campo funciona`;
  - `Codex no meio do turno: as duas desligadas com o motivo`;
  - `sem git: só a conversa ligada`;
  - `voltar só a conversa corta o chat local e manda rewind com mode conversation`;
  - `voltar a conversa e os arquivos passa pela tela de desfazer antes`;
  - `falha da conversa: texto volta ao campo e o aviso aparece`;
  - `agente trabalhando: o aviso de interrupção aparece dentro do diálogo e não há mais o ConfirmDialog antigo`;
  - `o texto "recomeça a conversa a partir dela" não existe mais em nenhuma língua`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar a suíte da web inteira (`npx vitest run`) e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(desfazer): editar a partir daqui com as duas voltas e copiar para o campo`.

### Task 18: Ensaio numa instância isolada (porta 9196)

**Files:** nenhum de produção. Scripts em `/tmp/claudinei-e2e-desfazer-scripts/`, repositório descartável em `/tmp/claudinei-e2e-desfazer-repo` (`git init` com dois commits) e uma pasta sem git em `/tmp/claudinei-e2e-desfazer-solta`.

- [ ] **Step 1: Subir a instância:**
  - `CLAUDINEI_PORT=9196`, `CLAUDINEI_DB=/tmp/claudinei-e2e-desfazer/claudinei.db`, `CLAUDINEI_UPLOADS=/tmp/claudinei-e2e-desfazer/uploads`, `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs` e `CLAUDINEI_CODEX_BIN=<worktree>/server/test/fake-codex.mjs`;
  - sem `CLAUDINEI_HERMES_*`;
  - web construída antes; `PATH=$N24:$PATH`.

  Banco novo, sem cópia do real. Se usar cópia, neutralizar antes:
  - `schedules.enabled`;
  - em `terminal_state`: autostart, `auto_resume`, `auto_resume_limit`, `interrupted_*`, `limit_hit_at`, `limit_resets_at` e `limit_action='none'`.
- [ ] **Step 2: Diff e desfazer.** Dois terminais Claude no repo descartável:
  1. mandar `escreve:a.txt=um` no primeiro: a linha "1 arquivo · +1 −0" aparece;
  2. `bash-escreve:b.txt=dois`: aparece também (mudança via comando);
  3. Ver mudanças: o diff só carrega no clique;
  4. Desfazer: os arquivos voltam e o `git status` do operador está igual ao de antes, sem nada em stash nem commit novo;
  5. a mensagem seguinte leva a nota `files reverted` (ver no transcript do fake);
  6. Refazer: os arquivos voltam ao estado do turno.
- [ ] **Step 3: Conflito e bloqueio.**
  1. Depois de um turno, editar `a.txt` à mão. O Desfazer mostra o conflito com as três escolhas.
  2. Com o segundo terminal em `demorada`, o Desfazer do primeiro mostra "Esperando o turno de <terminal> terminar".
  3. Abrir o segundo em "Abrir no terminal": continua bloqueado.
- [ ] **Step 4: Editar a partir daqui.**
  1. No Claude, "Voltar só a conversa" na penúltima mensagem: o chat corta, a mensagem editada sai com a nota `conversation rewound` e o fake recebe `--resume-session-at`, `--fork-session` e `--session-id`. Registrar os args do fake num arquivo pelo script do ensaio.
  2. No Codex, "Voltar só a conversa": o fake recebe `thread/revert`.
  3. Num terminal OpenCode ou Kimi falso: as duas opções desligadas com o motivo.
- [ ] **Step 5: Pasta sem git.** `escreve:x.txt=oi` na pasta solta mostra "Mudanças declaradas pelo agente" e o aviso fixo, sem Desfazer.
- [ ] **Step 6: Queda.**
  1. `kill -9` no PID da 9196 durante `demorada` e subir de novo: o turno aparece com "fim incerto" e o desfazer funciona.
  2. Capturas de tela da linha, do painel, da tela de conflito e do diálogo de editar, com o Playwright.
  3. Derrubar a instância e apagar `/tmp/claudinei-e2e-desfazer*`.

---

## Arquivos existentes que este plano modifica

| Arquivo | Task | Tamanho da mudança |
|---|---|---|
| `server/src/db.ts` | 5 | tabelas novas no fim |
| `server/src/claude/manager.ts` | 7 | dep `turnObserver`, `sendVia` + 1 linha em 5 envios, 2 no `wire`, 2 no `openInTerminal`, `liveSession`, `relaunch` e a trava do id (`persist`, `effectiveEngineSessionId`, `infoOf`) |
| `server/src/engine/types.ts` | 7 | `extraArgs?: string[]` em `EngineSessionOptions` |
| `server/src/engine/claude-engine.ts` | 7 | repassar `extraArgs`; exportar `claudeConfigDir` |
| `server/src/engine/codex/codex-session.ts` | 11 | evento `turn_started` + 3 métodos |
| `server/src/engine/codex/rollout.ts` | 11 | `forgetRollout` |
| `server/src/app.ts` | 10, 13 | montagem, rotas, `onUndoReady`, `holds` |
| `server/src/index.ts` | 10 | `turnObserver`, subida e retenção diária |
| `server/test/fake-claude.mjs`, `server/test/fake-codex.mjs` | 13, 11 | comportamentos novos |
| `web/src/App.tsx` | 14 | uma linha no WS |
| `web/src/chat/applyEvent.ts`, `web/src/types.ts` | 14 | duas notas |
| `web/src/components/MessageBlock.tsx` | 14, 17 | desenho das notas; `onEdit` com a chave |
| `web/src/components/ChatView.tsx` | 15, 16, 17 | linhas no `renderNode`, painel, diálogos; sai o `ConfirmDialog` de editar |
| `web/src/store.ts` | 17 | ação `truncateFrom` |
| `web/src/i18n/pt-BR.ts`, `en.ts`, `es.ts` | 14–17 | chaves `undo.*` e `chat.editWorkingMsg` |
| `web/src/test/chat-edit.test.tsx` | 17 | fluxo novo |

`session.ts` do Claude não muda: ele já acrescenta `extraArgs`. `server/src/queue/next-send.ts` não muda.
