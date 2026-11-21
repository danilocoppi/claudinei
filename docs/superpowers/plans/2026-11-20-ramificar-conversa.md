# Ramificar a conversa: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Três peças. `/side` (ou `/btw`) abre uma cópia descartável e só leitura da conversa numa coluna à direita, e **Trazer de volta** põe a resposta final no campo da principal. `/fork [nome]` cria um terminal irmão na mesma pasta com a cópia até aquele ponto. **Continuar noutro motor** leva as mensagens recentes a outro motor do mesmo terminal.

**Architecture:**
- Quase tudo mora em módulos novos: `server/src/branch/` no servidor e `web/src/branch/` na web.
- Os arquivos compartilhados com os projetos 9 (desfazer turno) e 14 (atalhos) só recebem ganchos curtos:
  - no manager: `turnStartedAt`, `onSessionEnded` e `fork_source` no `start` e no `revive`;
  - nas sessões: uma chamada a um transformador de argumentos do `branch/`;
  - no `ChatInput`: o desvio dos comandos e o "acrescentar ao campo";
  - no `ChatView`: a coluna lateral no lugar da de acompanhamento e o selo "ramo de".
- A lateral vive num registro em memória (`branch/side.ts`), fora do `live` do manager. Por isso não entra em `sessions`, `project_threads`, árbitro, limite nem reinício.
- O pacote de contexto é um módulo puro (`branch/handoff.ts`). Ele serve ao Kimi, à cópia nativa recusada, ao OpenCode no meio do turno e à troca de motor.

**Tech Stack:** Node 24 + TypeScript + Fastify + better-sqlite3 (servidor); React, zustand e i18next (web); vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-ramificar-conversa-design.md`, inclusive "Decisões de quem escreveu" e "Decisões da checagem do construtor". Os fatos de `/tmp/onda-c/ensaios-resultado.md` (resumidos abaixo) prevalecem sobre a spec onde divergem.

**Arquivos existentes que o plano modifica:**
- Servidor:
  - `server/src/engine/types.ts`, `server/src/claude/session.ts`, `server/src/engine/claude-engine.ts`;
  - `server/src/engine/codex/codex-session.ts`, `server/src/engine/codex/codex-engine.ts`;
  - `server/src/engine/opencode/opencode-session.ts`, `server/src/engine/opencode/opencode-engine.ts`;
  - `server/src/engine/kimi/kimi-session.ts`, `server/src/engine/kimi/kimi-home.ts`, `server/src/engine/kimi/kimi-engine.ts`;
  - `server/src/claude/manager.ts`, `server/src/db.ts` (uma linha), `server/src/projects.ts` (DTO), `server/src/project-threads.ts`;
  - `server/src/routes/sessions.ts` (prévia e exclusão), `server/src/app.ts`, `server/src/index.ts`;
  - fakes `server/test/fake-claude.mjs`, `fake-codex.mjs`, `fake-opencode.mjs` e `fake-kimi.mjs`.
- Web:
  - `web/src/slash.ts`, `web/src/types.ts`, `web/src/App.tsx` (uma linha), `web/src/chat/applyEvent.ts`;
  - `web/src/components/ChatInput.tsx`, `ChatView.tsx`, `EngineTabs.tsx`, `MessageBlock.tsx` (um `case`);
  - `web/src/styles.css` e `web/src/i18n/{pt-BR,en,es}.ts`.

## Global Constraints

- **Ambiente** (todo passo de verificação):
  - `N24=/usr/local/n/versions/node/24.15.0/bin`;
  - testes do servidor: `cd server && PATH=$N24:$PATH npx vitest run <arquivo>`;
  - tipos do servidor: `cd server && PATH=$N24:$PATH npx tsc --noEmit`;
  - web: `cd web && npx vitest run <arquivo>`;
  - tipos da web: `cd web && npx tsc -b` (não commitar `web/tsconfig.tsbuildinfo`).
- **Worktree:** `node_modules` são symlinks para o repo principal. **Nunca** rodar `npm install`. Commits só com `git add <arquivos explícitos>`, mensagem terminando em `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Fatos dos ensaios (valem mais que a spec):**
  - **Claude, valor do corte:** `--resume-session-at` recebe o campo `uuid` de uma entrada do transcript `.jsonl`. Nunca o `message.id` `msg_…`: com ele a CLI sai com código 1, "No message found with message.uuid of: msg_…".
  - **Claude, corte inclusivo:** o corte **inclui** a entrada indicada, e o fork copia as entradas com os mesmos `uuid`.
  - **Claude, combinações:** `--session-id <uuid> --resume <S> --fork-session` dá exatamente esse id. `--no-session-persistence` com `--resume --fork-session` não grava transcript.
  - **Claude, rastros dos hooks:** os hooks do usuário deixam `~/.claude/security/security_warnings_state_<id>.json` e `.lock`, e a pasta vazia `~/.claude/session-env/<id>`. A limpeza da lateral apaga esses três do id dela.
  - **Codex, fork efêmero:** `thread/fork` com `ephemeral: true` **exige `excludeTurns: true`**; sem isso, -32600. O fork efêmero tem `path: null` e não deixa rastro. `thread/turns/list` não funciona nele.
  - **Codex, corte e sandbox:** o `lastTurnId` é inclusivo e não pode ser um turno em andamento. `sandbox: 'read-only'` vale. Fork de conversa aberta em outro processo funciona.
  - **Codex, apagar:** `thread/delete` da original falha enquanto existir fork dela. Nada neste plano chama `thread/delete`.
  - **OpenCode:** `run --fork` é booleano, sem ponto de corte. A API HTTP de fork não foi ensaiada e não entra.
- **Ponto de corte ("último turno fechado")**, por motor:
  - **Claude:** a última entrada com `uuid` do transcript. Com a principal trabalhando, a última com `timestamp` anterior ao início do turno em curso (`manager.turnStartedAt`).
  - **Codex:** o `turn_id` da última linha `event_msg` / `task_complete` do rollout.
  - **OpenCode:** sem corte. Com a principal ociosa, `--fork` copia tudo. Trabalhando, cai no pacote.
  - **Kimi:** sempre o pacote.
  - **Sem turno fechado:** sem corte possível, `/side` e `/fork` recusam com `no_conversation`.
- **Pacote de contexto** (constantes em `branch/handoff.ts`):
  - `HANDOFF_BUDGET_CHARS = 64_000` e `HANDOFF_MAX_BYTES = 100 * 1024`, contando o cabeçalho;
  - `TOOL_RESULT_MAX = 300`; tokens = `Math.ceil(chars / 4)` do corpo.
  - **Cabeçalho (verbatim):** `[Claudinei: context handoff]: This conversation continues one held with <Motor> in this same folder. Below are its <N> most recent messages, whole, oldest first (about <T> tokens). The full conversation is at <ref>; read it only if you need something older. If no request follows, reply with one short line confirming you have the context.`
    - `<Motor>` é o `capabilities().label`;
    - `<ref>` é o `transcriptRef`, ou `<engine> conversation <id>` quando não houver.
  - **Corpo:** depois de `\n\n`, uma mensagem por bloco, separadas por `\n\n`. Cada bloco começa por `=== operator ===`, `=== agent ===` ou `=== earlier summary ===` (o resumo da compactação), seguido de `\n` e do texto.
  - **Ferramentas:** cada chamada vira uma linha `→ <nome>: <resumo>`. O resumo é o primeiro de `command`, `file_path`, `path`, `pattern` e `description`; sem nenhum, o JSON do input. Fica numa linha e é cortado em 200 caracteres.
  - **Resultados:** viram `  ← <até 300 caracteres>`, com `…` quando cortados. O thinking fica de fora.
  - **Pedido junto:** o pacote com pedido junto é `<pacote>\n\n=== request ===\n<texto>`.
  - **Corte da mais recente:** quando ela sozinha estoura o orçamento, entra o fim dela, precedido de `(beginning cut off)\n`.
- **Lateral:**
  - uma por terminal+motor, só leitura no nível que o motor deixa, sem Hermes;
  - nunca grava em `sessions` ou `project_threads`, nem passa pelo árbitro do próximo envio;
  - eventos guardados em memória até `SIDE_EVENTS_MAX_BYTES = 2 * 1024 * 1024`, sem os `stream`.
  - Aviso de arquivos por motor:
    - `read_only` no Codex: "Só leitura";
    - `no_edit_tools` no Claude e no OpenCode: "Sem ferramentas de edição — comandos de shell ainda podem alterar arquivos";
    - `can_write` no Kimi: "Pode alterar arquivos da pasta".
- **Trazer de volta:** acrescenta ao campo da principal, nunca substitui:
  - `Da conversa lateral («<pergunta>»):\n<texto>`;
  - a pergunta é a última mensagem do operador na lateral, até 80 caracteres, com `…` quando cortada;
  - acima de 10 240 bytes ou 100 linhas (a régua de `web/src/paste.ts`), o texto vira o anexo `lateral-HHMMSS.md` e o campo recebe o token.
  - Não entra na ordem do próximo envio.
- **Ordem do próximo envio:**
  - o pacote da troca de motor e o do `/fork` que cai no pacote (Kimi, nativo recusado) saem na criação da sessão, como `sendAsClaudinei`: é o **lugar 2**;
  - o pacote do OpenCode "que andou" vai **grudado** na primeira mensagem do operador, sem turno próprio;
  - `/side`, `/btw` e `/fork` **nunca** entram na fila: o campo chama a rota na hora. Um item antigo da fila com esses textos segue como texto comum.
- **Ramo (`/fork`):**
  - **Nome:** `/fork nome` usa o nome dado. Sem nome, ou só com espaços, vira `<original> (ramo)` e depois `(ramo 2)`, `(ramo 3)`, escolhendo o primeiro livre entre os nomes existentes.
  - **Posição:** logo abaixo do original, com a mesma cor, ícone, grupo, setor e `heads_up`.
  - **Motores:** a lista de motores do original, com o motor do ramo garantido nela.
  - **Acesso:** as mesmas linhas de `user_projects`.
  - **Sessão:** herda motor, modelo, esforço e modo de permissão.
  - **Não herda:** goal, fila, agendamentos, acompanhamento, tarefas, triagem e `terminal_state` (fica sem linha, portanto desligado).
  - **Só admin:** 403 com `fork_admin_only`.
- **Erros novos** (código para `serverErrors.<code>`):
  - `no_conversation`: "Ainda não há conversa para copiar";
  - `side_exists`;
  - `side_not_found`;
  - `fork_admin_only`: "Só um administrador pode criar terminais";
  - `handoff_same_engine`;
  - `handoff_engine_unavailable`;
  - `handoff_target_busy`;
  - `handoff_target_limited`.
- **Interface sem GPU** (AGENTS.md):
  - a coluna lateral não tem rostinho nem animação nova; o ponto de status é estático (`dotClassOf`);
  - os textos ao operador ficam em pt-BR, en e es.
- **Ensaio** só na porta **9195**, com dados em `/tmp/claudinei-e2e-ramificar`. Nunca a 9105. Nunca reiniciar o `claudinei.service`.

## Review Focus

1. **A lateral vazando para a principal.** Um `/side` no OpenCode deixa uma sessão no storage até fechar. Nesse tempo, ela não pode virar "a mais recente da pasta":
   - nem no terminal interativo (`foreignThreadIds`);
   - nem na prévia do histórico (`historyConversationId`).

   Nenhuma lateral grava em `sessions` ou `project_threads`. Testes nas Tasks 6 e 7.
2. **Corte com a principal no meio do turno.** Os casos:
   - Claude trabalhando no primeiro turno, sem entrada anterior ao início: recusa com `no_conversation`;
   - Claude com o turno em curso já gravando entradas: nenhuma entra na cópia;
   - Codex com o turno em curso: `lastTurnId` é o anterior;
   - OpenCode trabalhando: pacote.

   Testes nas Tasks 2 e 6.
3. **Dois `/side` ao mesmo tempo** (dois navegadores, ou um clique duplo). Só um abre; o segundo recebe `side_exists`, mesmo que o primeiro ainda esteja calculando o corte. A reserva é síncrona. Teste na Task 6.
4. **Cópia nativa recusada.** O Claude com `--resume-session-at` inválido e o Codex com o fork recusado morrem antes do `init`:
   - na lateral, a pergunta sai de novo com o pacote, sem o operador redigitar;
   - no ramo, a sessão revive em conversa nova e recebe o pacote como mensagem do Claudinei. Se a recusa veio com uma mensagem do operador, ela é reenviada logo depois do pacote, sem ele redigitar.

   Nada fica em laço. Testes nas Tasks 6 e 8.
5. **Troca de motor com o destino mudando.** Os casos:
   - o destino passa a trabalhar entre o menu e a confirmação: 409, sem encerrar nada;
   - o `stop` do destino ocioso falha: nada é criado;
   - o goal ativo do destino fica pausado por `operator`, e a fila dele sai só depois do turno do pacote.

   Testes na Task 9.

---

### Task 1: Esquema, tipos e referência da conversa

**Files:**
- Create: `server/src/branch/schema.ts`
- Modify: `server/src/db.ts`: uma linha `migrateBranch(db)` logo antes do `return db` final, depois de `migrarPathNaoUnico`.
- Modify: `server/src/projects.ts`: `rowToProject` ganha `forkedFrom` e `forkedCutAt`.
- Modify: `server/src/engine/types.ts`
- Modify: `server/src/engine/claude-engine.ts`, `codex/codex-engine.ts`, `kimi/kimi-engine.ts`, `opencode/opencode-engine.ts`: `transcriptRef` e `capabilities().fork`.
- Test: `server/test/branch-schema.test.ts`, `server/test/branch-transcript-ref.test.ts`

**Interfaces:**
- `migrateBranch(db: Db): void`. É idempotente, com try/catch por `ALTER`, como o resto do `db.ts`:
  - `ALTER TABLE projects ADD COLUMN forked_from INTEGER REFERENCES projects(id) ON DELETE SET NULL`;
  - `ALTER TABLE projects ADD COLUMN forked_cut_at TEXT`;
  - `ALTER TABLE sessions ADD COLUMN fork_source TEXT`;
  - ```sql
    CREATE TABLE IF NOT EXISTS side_threads (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      engine TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))
    ```
- `Project` ganha `forkedFrom: number | null` e `forkedCutAt: string | null`.
- `engine/types.ts`:
  ```ts
  export interface ForkFrom {
    sourceId: string
    /** Claude: `uuid` da entrada do transcript (inclusivo). Codex: `lastTurnId`. Ausente = a conversa toda. */
    cut?: string
    /** OpenCode: pacote a juntar à 1ª mensagem quando a cópia nativa não vale mais. */
    seed?: string
    /** OpenCode: a cópia nativa ainda vale (o original não andou)? Ausente = vale. */
    nativeOk?: () => Promise<boolean>
  }
  // EngineSessionOptions += forkFrom?: ForkFrom; readOnly?: boolean; ephemeral?: boolean;
  //                         sessionId?: string; dataRoot?: string   // dataRoot: só o Kimi (data root próprio)
  // EngineCapabilities += fork?: 'native' | 'seed'
  // Engine += transcriptRef?(projectPath: string, id: string): string | null
  ```
- O que cada motor devolve:

  | Motor | `transcriptRef` | `fork` |
  |---|---|---|
  | Claude | `transcriptPath(...)` | `'native'` |
  | Codex | `findRollout(sessionsRoot(), id)` | `'native'` |
  | Kimi | `join(sessionDirOf(...), 'agents', 'main', 'wire.jsonl')`, ou null | `'seed'` |
  | OpenCode | `` `opencode export ${id}` `` | `'native'` |

- [ ] **Step 1: Testes que falham:**
  - `migrateBranch cria side_threads e as colunas, e roda duas vezes sem erro`;
  - `apagar o original deixa forked_from nulo no ramo`: dois projetos, `DELETE` do primeiro, `forked_from` é `null`;
  - `rowToProject expõe forkedFrom e forkedCutAt`;
  - `transcriptRef por motor`:
    - Claude devolve o caminho do `.jsonl` sob `CLAUDE_CONFIG_DIR`;
    - OpenCode devolve `'opencode export ses_X'`;
    - Codex sem rollout devolve `null`.
- [ ] **Step 2: Rodar e ver falhar.** `PATH=$N24:$PATH npx vitest run test/branch-schema.test.ts test/branch-transcript-ref.test.ts`
- [ ] **Step 3: Implementar** nos arquivos acima.
- [ ] **Step 4: Rodar e ver passar.** Rodar também `db.test.ts`, `projects.test.ts` e `migrations-path-shared.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(ramificar): esquema, tipos de cópia e referência da conversa`.

### Task 2: Ponto de corte por motor

**Files:**
- Create: `server/src/branch/cut.ts`
- Test: `server/test/branch-cut.test.ts`, com fixtures em `server/test/fixtures/branch/`: um transcript do Claude e um rollout do Codex, pequenos e escritos à mão.

**Interfaces:**
```ts
export interface CutPoint {
  cut: string | null                // uuid (Claude) | turn_id (Codex) | id da última mensagem (OpenCode)
  at: string | null                 // ISO da entrada do corte ("cópia até HH:MM")
  previewBefore: number | null      // `before` do readPage que inclui o corte (byte da linha + 1; OpenCode: nº de eventos)
}
export async function claudeCut(file: string, opts: { turnStartedAt?: number }): Promise<CutPoint | null>
export async function codexCut(file: string): Promise<CutPoint | null>
export type ExecLike = (file: string, args: string[]) => Promise<{ stdout: string }>
export async function openCodeLastMessageId(projectPath: string, id: string, run?: ExecLike): Promise<string | null>
export async function cutFor(engineId: string, projectPath: string, sourceId: string,
  opts: { working: boolean; turnStartedAt?: number }): Promise<CutPoint | null>
```
- **Leitura:** `claudeCut` e `codexCut` leem pela cauda com `readPositionedTail` (`server/src/tail.ts`), com `minItems: 1`. A janela cresce até achar a entrada.
- **Claude:** só contam as linhas com `uuid`, que são `user`, `assistant` e `system`.
- **`cutFor` por motor:**
  - `claude` usa `claudeCut` e passa o `turnStartedAt` só se `working`;
  - `codex` usa `codexCut`, ignorando `working`: o turno em curso ainda não tem `task_complete`;
  - `opencode` devolve `{ cut: working ? null : lastId, at: null, previewBefore: working ? null : nEventos }`, com `nEventos` vindo do `readHistory`;
  - `kimi` devolve `null`.
- **`null` significa "nada fechado para copiar".** O Claude ou o Codex sem a entrada devolvem `null`.

- [ ] **Step 1: Testes que falham:**
  - `claude ocioso: corte é o uuid da última entrada com uuid, at é o timestamp dela`: as linhas `last-prompt` e `mode`, sem `uuid`, no fim são ignoradas;
  - `claude trabalhando: entradas com timestamp >= turnStartedAt ficam de fora`;
  - `claude trabalhando no primeiro turno: null`;
  - `previewBefore inclui a linha do corte`: `readTranscriptPage` com `before = previewBefore` termina no evento do corte;
  - `codex: turn_id do último task_complete; turno sem task_complete não conta`;
  - `codex sem nenhum task_complete: null`;
  - `openCodeLastMessageId lê messages.at(-1).info.id do export`: o `run` é injetado e devolve um JSON fixo;
  - `cutFor opencode trabalhando: cut null`;
  - `cutFor kimi: null`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar `branch/cut.ts`.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(ramificar): ponto de corte do último turno fechado`.

### Task 3: O pacote de contexto

**Files:**
- Create: `server/src/branch/handoff.ts`
- Test: `server/test/branch-handoff.test.ts`

**Interfaces:**
```ts
export const HANDOFF_PREFIX = '[Claudinei: context handoff]'
export const HANDOFF_BUDGET_CHARS = 64_000
export const HANDOFF_MAX_BYTES = 100 * 1024
export const TOOL_RESULT_MAX = 300
export interface HandoffMessage { role: 'operator' | 'agent' | 'summary'; text: string }
export interface Handoff { text: string; messages: number; tokens: number }
/** Eventos (mais antigo → mais recente) viram mensagens; para no resumo da compactação mais recente. */
export function messagesOf(events: AgentEvent[]): HandoffMessage[]
/** Tira o turno em andamento: do último evento `user` de texto do operador em diante. */
export function dropOpenTurn(events: AgentEvent[]): AgentEvent[]
export function isCompactionSummary(evt: AgentEvent): boolean
export function buildHandoff(messages: HandoffMessage[], meta: { label: string; ref: string }): Handoff | null
export function withRequest(handoff: Handoff, request: string): string
export async function collectHandoff(engine: Engine, projectPath: string, id: string,
  opts: { working: boolean; before?: number }): Promise<Handoff | null>
```
- **`messagesOf`:**
  - o texto do operador e o do agente entram inteiros;
  - eventos `assistant` seguidos até o próximo texto do operador formam **uma** mensagem `agent`, com as linhas de ferramenta;
  - `tool_result` de eventos `user` vira a linha `  ← …` na mensagem `agent` corrente;
  - eventos `user` com `fromEngine`, `raw.isMeta` ou `raw.isSynthetic` ficam de fora, salvo o resumo da compactação, que vira `summary`.
- **`isCompactionSummary`:** `raw.isCompactSummary === true`, ou um texto `user` que começa com `This session is being continued from a previous conversation`.
- **`buildHandoff`:**
  - percorre da mais recente para a mais antiga e acrescenta mensagens inteiras enquanto o texto todo cabe em `HANDOFF_BUDGET_CHARS` e em `HANDOFF_MAX_BYTES` (UTF-8);
  - a mais recente sozinha grande demais entra cortada no início, com `(beginning cut off)\n`;
  - sem mensagens, devolve `null`.
- **`collectHandoff`:**
  - pagina com `readPage` (`server/src/history-page.ts`) de trás para a frente, a partir de `before`;
  - aplica `dropOpenTurn` quando `working`;
  - para quando o orçamento enche, ao chegar no começo ou no resumo da compactação;
  - monta o `label` com `engine.capabilities().label` e o `ref` com `engine.transcriptRef?.(...) ?? \`${engine.id} conversation ${id}\``.

- [ ] **Step 1: Testes que falham** (eventos montados à mão; `collectHandoff` com uma engine fake de `readHistory`):
  - `cabeçalho verbatim com N, T, Motor e ref`;
  - `mensagens inteiras, em ordem, mais antiga primeiro`;
  - `orçamento: a 65ª mil-ésima letra deixa a mensagem mais antiga de fora, nunca pela metade`;
  - `teto de 100 KB com texto multibyte`: mensagens com emoji, `Buffer.byteLength(text) <= 102400`;
  - `a mais recente sozinha acima do orçamento entra com "(beginning cut off)" e o fim preservado`;
  - `ferramenta vira "→ Bash: npm test" e o resultado até 300 caracteres com "…"`;
  - `thinking fica de fora`;
  - `resumo da compactação é o mais antigo e a leitura para nele`;
  - `dropOpenTurn tira o turno em andamento`;
  - `withRequest acrescenta "=== request ==="`;
  - `sem mensagens: null`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar `branch/handoff.ts`.**
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** `feat(ramificar): pacote de contexto com mensagens inteiras`.

### Task 4: Cópia nativa no Claude e no Codex

**Files:**
- Create: `server/src/branch/engine-args.ts`
- Modify: `server/src/claude/session.ts`:
  - `SessionOptions` ganha `forkFrom`, `sessionId`, `readOnly` e `ephemeral`;
  - em `start()`, depois de montar `args` (inclusive no caminho do `extraArgsOverride`), uma linha `args = claudeBranchArgs(args, this.opts)`.
- Modify: `server/src/engine/claude-engine.ts`: repassa os quatro campos.
- Modify: `server/src/engine/codex/codex-session.ts`:
  - `start()` chama `ensureReady()` também quando há `forkFrom`;
  - em `ensureReady()`, com `forkFrom`, o pedido é `thread/fork` com `codexForkParams(params, this.opts)`.
- Modify: `server/test/fake-claude.mjs`:
  - `--session-id <id>` define o `sid`;
  - `--resume-session-at msg_…` sai com código 1 e `No message found with message.uuid of: <valor>` no stderr, antes do `init`.
- Modify: `server/test/fake-codex.mjs`, com `thread/fork`:
  - `ephemeral` sem `excludeTurns` dá -32600 `ephemeral paginated thread/fork requires \`excludeTurns: true\``;
  - `--fork-refuse` no argv dá -32600;
  - os demais devolvem `{ thread: { id: 'FORK-' + threadId, path: ephemeral ? null : '/tmp/fake-rollout' }, model }` e guardam os params;
  - o turno com o texto `__fork_params__` responde o JSON deles.
- Test: `server/test/branch-engine-args.test.ts`, `server/test/branch-native-fork.test.ts`

**Interfaces:**
```ts
export function claudeBranchArgs(args: string[], o: { forkFrom?: ForkFrom; sessionId?: string; readOnly?: boolean; ephemeral?: boolean }): string[]
export function codexForkParams(base: Record<string, unknown>, o: { forkFrom: ForkFrom; readOnly?: boolean; ephemeral?: boolean }): Record<string, unknown>
```
- **`claudeBranchArgs`:**
  - sem nenhum campo, devolve `args` igual;
  - com `forkFrom`: tira `--resume <x>` e `--continue` e acrescenta `--resume <sourceId> --fork-session`, mais `--resume-session-at <cut>` se houver `cut`;
  - `sessionId` vira `--session-id <id>`; `ephemeral` vira `--no-session-persistence`;
  - `readOnly`: tira `--dangerously-skip-permissions` e acrescenta `--permission-mode plan --disallowed-tools Edit Write NotebookEdit`. A lista variádica vem seguida de outra flag ou do fim.
- **`codexForkParams`:** parte dos params de `thread/start` (`cwd`, `approvalPolicy`, `model`, `config` e, no ramo, `developerInstructions`) e acrescenta:
  ```ts
  { threadId: sourceId, ...(cut ? { lastTurnId: cut } : {}), excludeTurns: true,
    ...(ephemeral ? { ephemeral: true } : {}), sandbox: readOnly ? 'read-only' : base.sandbox }
  ```
- **A lateral não recebe `hermes`.** Sem `--mcp-config` e `--append-system-prompt` no Claude; sem `mcp_servers.hermes` e `developerInstructions` no Codex. O manager não está no caminho dela.

- [ ] **Step 1: Testes que falham:**
  - `lateral do Claude`: `--fork-session`, `--no-session-persistence`, `--session-id`, `--permission-mode plan`, `--disallowed-tools Edit Write NotebookEdit`; sem `--dangerously-skip-permissions`, `--mcp-config` nem `--continue`;
  - `ramo do Claude`: `--resume src --fork-session --session-id X --resume-session-at <uuid>`, mantendo `--dangerously-skip-permissions`;
  - `--resume-session-at só com cut`;
  - `codexForkParams`: `excludeTurns: true` sempre; `ephemeral` e `sandbox: 'read-only'` na lateral; `lastTurnId` só com `cut`;
  - `ClaudeSession com fake: o init vem com o id escolhido`;
  - `fake: msg_ no corte morre antes do init com código 1`;
  - `CodexSession com forkFrom: o id FORK-… sai na partida, antes de qualquer mensagem, e __fork_params__ ecoa excludeTurns/ephemeral/sandbox`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** `engine-args.ts` e os ganchos.
- [ ] **Step 4: Rodar e ver passar.** Rodar também `session.test.ts`, `codex-session.test.ts`, `claude-engine.test.ts` e `codex-engine.test.ts`.
- [ ] **Step 5: Commit** `feat(ramificar): cópia nativa no Claude e no Codex`.

### Task 5: OpenCode e Kimi

**Files:**
- Modify: `server/src/branch/engine-args.ts`: acrescenta `openCodeBranchArgs`.
- Modify: `server/src/engine/opencode/opencode-session.ts`:
  - o spawn sai de `send` para `private spawnTurn(text: string)`;
  - `send` decide a cópia na primeira mensagem, quando há `forkFrom` e ainda não há `sessionId`.
- Modify: `server/src/engine/kimi/kimi-home.ts`: extrai `ensureKimiHomeAt(dir: string, hermes?)`; `ensureKimiHome` passa a chamá-la.
- Modify: `server/src/engine/kimi/kimi-session.ts`: `KIMI_CODE_HOME` vem de `opts.dataRoot ? ensureKimiHomeAt(opts.dataRoot) : ensureKimiHome(...)`.
- Modify: `server/test/fake-opencode.mjs`:
  - com `--fork` e `-s X`, o `sid` vira `ses_FORK_X`;
  - o prompt `__args__` responde `JSON.stringify(args)`.
- Modify: `server/test/fake-kimi.mjs`: o prompt `__home__` responde o `KIMI_CODE_HOME`.
- Test: `server/test/branch-opencode-kimi.test.ts`

**Interfaces:**
```ts
/** Insere antes do `--` final: `--fork -s <sourceId>` (só na 1ª mensagem nativa) e `--agent plan` (readOnly). */
export function openCodeBranchArgs(args: string[], o: { forkSourceId?: string; readOnly?: boolean }): string[]
export function kimiSideHome(sideId: string): string   // join(kimiHomesRoot(), `side-${sideId}`)
```
- **Primeira mensagem com `forkFrom`:**
  1. Fica `working` na hora.
  2. Espera `forkFrom.nativeOk?.() ?? true`.
  3. Se vale, roda `buildRunArgs` com `--fork -s <sourceId>`.
  4. Se não vale, roda `buildRunArgs` com `withRequest`, juntando o `seed` e o texto; sem `seed`, só o texto.
  5. Uma falha do `nativeOk` conta como "não vale".
- **Depois da primeira:** `-s <sessionId>` normal. O `readOnly` põe `--agent plan` em todo turno.

- [ ] **Step 1: Testes que falham:**
  - `openCodeBranchArgs: --fork -s e --agent plan antes do "--"`;
  - `OpenCode ramo, original parado`: a primeira mensagem roda com `--fork -s src` e o `sessionId` vira `ses_FORK_src`;
  - `OpenCode ramo, original andou: a primeira mensagem leva o pacote e o texto, sem --fork, num turno só`;
  - `OpenCode lateral: --agent plan em todos os turnos`;
  - `Kimi com dataRoot: KIMI_CODE_HOME é o dir dado e tem os symlinks de login`;
  - `ensureKimiHome segue igual para o terminal`, a regressão de `kimi-home.test.ts`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `opencode-session.test.ts`, `kimi-session.test.ts` e `kimi-home.test.ts`.
- [ ] **Step 5: Commit** `feat(ramificar): cópia no OpenCode e data root próprio no Kimi`.

### Task 6: Ganchos do manager e a lateral no servidor

**Files:**
- Create: `server/src/branch/fork-source.ts`, `server/src/branch/side-threads.ts`, `server/src/branch/side.ts`
- Modify: `server/src/claude/manager.ts`. Os ganchos, só estes:
  - `Deps.onSessionEnded?(projectId, engine, localId)`: chamado no handler de status quando vira `dead` ou `stopped`, inclusive no encerramento;
  - a entrada do `live` ganha `turnStartedAt?: number`: grava `Date.now()` na transição para `working` (se vazio) e limpa em `idle`, `needs_attention`, `dead` e `stopped`;
  - o accessor `turnStartedAt(localId): number | undefined`;
  - `start(project, opts)` aceita `forkSource?: ForkSource`. Grava `fork_source` no INSERT e `claude_session_id = forkSource.sessionId ?? sharedResume`. Cria a sessão com `forkPlanOf(...)`, sem resume nem continue;
  - `revive`: se `parseForkSource(row.fork_source)` devolve fonte, usa `forkPlanOf` no lugar de `resolveResume`/`ownResume`.
- Modify: `server/src/project-threads.ts`: `foreignThreadIds` une `sideThreadIds(db, engine)`.
- Modify: `server/src/routes/sessions.ts`: em `historyConversationId`, no ramo da pasta não compartilhada, `engine.latestConversationId(projectPath, sideThreadIds(db, info.engine))`.
- Test: `server/test/branch-manager.test.ts`, `server/test/branch-side.test.ts`

**Interfaces:**
```ts
// fork-source.ts
export interface ForkSource { engine: string; sourceId: string; cut: string | null; cutAt: string | null;
  previewBefore: number | null; sessionId?: string; seed?: string }
export function parseForkSource(raw: string | null | undefined): ForkSource | null
export function forkPlanOf(src: ForkSource, projectPath: string): Pick<EngineSessionOptions, 'forkFrom' | 'sessionId'>
// side-threads.ts
export function recordSideThread(db: Db, r: { id: string; projectId: number; engine: string; threadId: string | null }): void
export function setSideThreadId(db: Db, id: string, threadId: string): void
export function removeSideThread(db: Db, id: string): void
export function listSideThreads(db: Db): Array<{ id: string; projectId: number; engine: string; threadId: string | null }>
export function sideThreadIds(db: Db, engine: string): ReadonlySet<string>
export async function cleanupSideTrace(r: { id: string; engine: string; threadId: string | null },
  deps?: { claudeConfigDir?: string; run?: ExecLike }): Promise<void>
// side.ts
export type SideFiles = 'read_only' | 'no_edit_tools' | 'can_write'
export interface SideInfo { id: string; projectId: number; engine: string; status: SessionStatus; mode: 'native' | 'seed';
  cutAt: string | null; files: SideFiles; question: string | null; openedAt: string }
export function createSideService(deps: {
  db: Db; broadcast: (m: object) => void
  main: (projectId: number, engine: string) => { localId: string; status: SessionStatus; engineSessionId: string | null;
    model: string | null; effort: string | null; turnStartedAt?: number } | null
  projectPath: (projectId: number) => string | null
  makeSession?: (engine: string, opts: EngineSessionOptions) => EngineSession   // testes
  cutFor?: typeof cutFor; collect?: typeof collectHandoff                         // testes
}): SideService
export interface SideService {
  open(projectId: number, engine: string, question: string | null, opts?: { replace?: boolean }): Promise<SideInfo>
  send(projectId: number, engine: string, text: string): void
  interrupt(projectId: number, engine: string): Promise<void>
  close(projectId: number, engine: string, opts?: { shutdown?: boolean }): Promise<void>
  snapshot(projectId: number, engine: string): { side: SideInfo; events: AgentEvent[] } | null
  onSessionEnded(projectId: number, engine: string): void
  bootCleanup(): Promise<void>
  dispose(): Promise<void>
}
```
- **`forkPlanOf` por motor:**
  - `claude` dá `{ forkFrom: { sourceId, cut }, sessionId }`;
  - `codex` dá `{ forkFrom: { sourceId, cut } }`;
  - `opencode` dá `{ forkFrom: { sourceId, seed, nativeOk: async () => src.cut != null && (await openCodeLastMessageId(projectPath, sourceId)) === src.cut } }`.
- **`cleanupSideTrace` por motor:**
  - `claude` apaga `<cfg>/security/security_warnings_state_<threadId>.json` e `.lock`, e `<cfg>/session-env/<threadId>`;
  - `opencode` roda `opencode session delete <threadId>`, com timeout de 10 s e erro só no log;
  - `kimi` faz `rm -rf kimiSideHome(id)`;
  - `codex`: nada.
- **`open`, passo a passo:**
  1. Reserva a chave `projectId:engine` **antes de qualquer await**. Com outra lateral, lança `UserError('side_exists')`, salvo com `replace`, que fecha a antiga antes.
  2. Sem `main` vivo ou sem `engineSessionId`, lança `no_conversation`.
  3. Calcula o modo:
     - Claude e Codex: `cutFor(...)`; se der `null`, `no_conversation`. O `cutAt` vem dele;
     - Claude: o `forkFrom.cut` só vai com a principal `working` (spec: `--resume-session-at` só no meio do turno). Ociosa, copia a conversa toda;
     - OpenCode: nativo se a principal não está `working`;
     - Kimi: sempre `seed`.
  4. Cria a sessão com `ephemeral: true`, `readOnly: true`, o modelo e o esforço da principal, sem `hermes`:
     - Claude: `sessionId = randomUUID()`;
     - Kimi: `dataRoot = kimiSideHome(id)`.
  5. Grava `recordSideThread` para Claude (`threadId` = o uuid), OpenCode (o id que chega no `init`) e Kimi.
  6. Com pergunta: no modo nativo, manda a pergunta; no modo `seed`, manda `withRequest(collectHandoff(...), pergunta)`. Sem pergunta, guarda o modo `seed` para a primeira mensagem.
- **Cópia nativa recusada:** a sessão morreu antes do `init`. A lateral recria em `seed` e reenvia a última pergunta, **uma vez só**. Se morrer de novo, o status vai a `dead` e o erro fica na coluna.
- **Eventos:**
  - a lateral os publica como `{ type: 'side_event', projectId, engine, sideId, event }`;
  - guarda os que não são `stream` até 2 MB, descartando os mais antigos;
  - o status sai como `{ type: 'side_state', projectId, engine, side: SideInfo | null }`.
- **Fechar:** `close` para a sessão, roda `cleanupSideTrace` e `removeSideThread`, e publica `side: null`. Com `shutdown`, só para o processo, e a subida limpa.
- **Fim da principal:** `onSessionEnded` fecha a lateral do mesmo projeto e motor.
- **Subida:** `bootCleanup` limpa todo `listSideThreads`.

- [ ] **Step 1: Testes que falham.**
  - Manager, em `branch-manager.test.ts`, com `sessionFactory` que grava as opções:
    - `turnStartedAt marca o início do turno e limpa no fim`;
    - `onSessionEnded no stop e na morte`;
    - `start com forkSource grava fork_source e claude_session_id, sem resume nem continue`;
    - `revive com fork_source copia de novo pelo forkPlanOf`;
    - `revive sem fork_source segue igual`.
  - Lateral, em `branch-side.test.ts`, com sessões fake:
    - `/side abre com fork nativo, ephemeral, readOnly, sem hermes, modelo e esforço da principal`;
    - `claude ocioso: sem --resume-session-at; trabalhando: com o uuid do último turno fechado`;
    - `dois open simultâneos: o segundo recebe side_exists`, com `Promise.all` e `cutFor` lento;
    - `replace fecha a antiga e abre a nova`;
    - `sem engineSessionId: no_conversation`;
    - `claude trabalhando no primeiro turno: no_conversation`;
    - `kimi: primeira mensagem é o pacote + "=== request ===" + pergunta, num envio só`;
    - `opencode com a principal trabalhando: seed`;
    - `cópia recusada: recria em seed e reenvia a pergunta uma vez`;
    - `nada em sessions nem em project_threads depois de abrir, conversar e fechar`;
    - `foreignThreadIds e a prévia ignoram o id da lateral do OpenCode enquanto ela existe`;
    - `fechar mata, limpa os rastros do Claude e remove a linha de side_threads`, com `claudeConfigDir` temporário;
    - `onSessionEnded fecha a lateral`;
    - `bootCleanup apaga o que sobrou de uma queda`, com `run` injetado para o OpenCode;
    - `eventos acima de 2 MB descartam os mais antigos`;
    - `erro de limite na lateral não chama nada do manager`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** os três módulos e os ganchos.
- [ ] **Step 4: Rodar e ver passar.** Rodar também `manager.test.ts`, `manager-restart.test.ts`, `shared-folder.test.ts`, `project-threads.test.ts` e `history-routes.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(ramificar): conversa lateral no servidor e ganchos do manager`.

### Task 7: Rotas da lateral e amarração

**Files:**
- Create: `server/src/branch/service.ts`, `server/src/routes/branch.ts`
- Modify: `server/src/app.ts`: cria o serviço depois do goal e registra as rotas. `AppDeps.onBranchReady?: (b: BranchService) => void`.
- Modify: `server/src/index.ts`:
  - `let branch` e o `onSessionEnded` do manager chamando `branch?.onSessionEnded(...)`;
  - `onTurnResult` e `onSessionDied` acrescentam `() => branch?.onTurnResult(...)` e `() => branch?.onSessionDied(...)` no `both`;
  - `main` lido de `manager.list()` (status ativo) mais `manager.turnStartedAt`;
  - `await branch.bootCleanup()` depois do listen;
  - `await branch.dispose()` no encerramento, antes do `manager.stopAll()`.
- Test: `server/test/branch-routes.test.ts`

**Interfaces:**
- `createBranchService(deps: { db; manager: SessionManager; broadcast; store: TerminalStateStore; restart: Pick<RestartService, 'publish'> })` devolve:
  ```ts
  { side: SideService; fork(...): ...; switchEngine(...): ...   // Tasks 8 e 9
    onTurnResult(projectId: number, engine: string): void; onSessionDied(projectId: number, engine: string): void
    onSessionEnded(projectId: number, engine: string): void; bootCleanup(): Promise<void>; dispose(): Promise<void> }
  ```
  `onTurnResult` e `onSessionDied` ficam vazios até a Task 8.
- Rotas. Todas exigem `canAccessProject`; o `engine` precisa estar registrado (`hasEngine`).

  | Rota | Corpo | Resposta |
  |---|---|---|
  | `GET /api/projects/:id/side?engine=` | — | `{ side: SideInfo \| null, events: AgentEvent[] }` |
  | `POST /api/projects/:id/side` | `{ engine, text?: string, replace?: boolean }` | 201 `SideInfo`; 409 `side_exists` ou `no_conversation` |
  | `POST /api/projects/:id/side/message` | `{ engine, text }` | 204; 404 `side_not_found` |
  | `POST /api/projects/:id/side/interrupt` | `{ engine }` | 204 |
  | `DELETE /api/projects/:id/side?engine=` | — | 204 |

- [ ] **Step 1: Testes que falham:**
  - `abre, conversa, interrompe e fecha pela API`;
  - `side_state e side_event chegam pelo broadcast com projectId`;
  - `usuário sem acesso ao projeto: 403`;
  - `segundo POST sem replace: 409 side_exists; com replace: 201`;
  - `GET depois de recarregar devolve a lateral e os eventos`;
  - `parar a sessão principal pela rota de stop publica side: null`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `routes-sessions.test.ts`, `ws.test.ts` e `smoke.test.ts`.
- [ ] **Step 5: Commit** `feat(ramificar): rotas da lateral e amarração do serviço`.

### Task 8: Ramificar (`/fork`)

**Files:**
- Create: `server/src/branch/fork.ts`, com `forkPreviewPage` em `fork-source.ts`.
- Modify: `server/src/branch/service.ts`: `fork`, `onTurnResult` e `onSessionDied`.
- Modify: `server/src/routes/branch.ts`: `POST /api/projects/:id/fork`.
- Modify: `server/src/routes/sessions.ts`: no início do `try` da rota de histórico, duas linhas `const preview = await forkPreviewPage(...); if (preview) return preview`.
- Test: `server/test/branch-fork.test.ts`

**Interfaces:**
```ts
export function branchName(original: string, existing: string[], given?: string): string
export async function forkTerminal(deps: ForkDeps, req: { projectId: number; engine: string; name?: string; user?: AuthUser }):
  Promise<{ project: Project; session: SessionInfo }>
export async function forkPreviewPage(db: Db, info: SessionInfo, projectPath: string,
  before: number | undefined, limit: number): Promise<HistoryResponse | null>
```
- **A rota:**
  - `POST /api/projects/:id/fork { engine, name? }`;
  - 403 `fork_admin_only` com a mesma regra do `requireAdmin` (`!u || (u.kind === 'user' && u.isAdmin)` passa);
  - responde 201 `{ project, session }`.
- **`forkTerminal`:**
  1. Acha a sessão de origem do motor: a viva, ou a mais recente com `claude_session_id`. Sem nenhuma, `no_conversation`.
  2. Calcula `cutFor` (com `working` e `turnStartedAt` da viva). Claude ou Codex com `null`: `no_conversation`.
  3. Cria o projeto numa transação:
     - `sort_order` = o do original + 1, depois de somar 1 a todo `sort_order` maior que o dele em `projects` e em `project_groups` (o espaço é unificado);
     - copia `path`, `color`, `icon`, `group_id`, `sector_id`, `heads_up` e os motores (com o do ramo garantido);
     - grava `forked_from` e `forked_cut_at = cut.at`;
     - copia as linhas de `user_projects`.
  4. Monta a sessão:
     - **Claude e Codex:** `manager.start(project, { engine, model, effort, permissionMode, continueLatest: false, forkSource })`. No Claude, `forkSource.sessionId = randomUUID()`.
     - **OpenCode:** a mesma chamada, com `forkSource.cut = cut.cut` (nulo se trabalhando) e `forkSource.seed = (await collectHandoff(..., { working })).text`.
     - **Kimi:** `manager.start(..., { continueLatest: false })` e depois `manager.sendAsClaudinei(localId, handoff.text)`. Esse é o lugar 2. Sem `fork_source`.
- **`onTurnResult(projectId, engine)`:** limpa `fork_source` das sessões do terminal cujo `claude_session_id` já existe no storage. Usa `conversationExists`; sem ele, basta o id gravado.
- **`onSessionDied(projectId, engine)`:** cobre a sessão com `fork_source` cuja conversa não existe, ou seja, a cópia recusada. Os passos:
  1. `UPDATE sessions SET fork_source=NULL, claude_session_id=NULL`;
  2. monta o pacote da origem com `before: previewBefore`;
  3. `manager.revive(localId)` em conversa nova;
  4. `sendAsClaudinei(localId, pacote)`;
  5. se a sessão morreu levando uma mensagem do operador (o texto que estava sendo enviado quando a cópia foi recusada), reenvia essa mensagem logo depois do pacote, como mensagem do operador, sem ele redigitar. Guarde o texto pendente no momento do `send` da sessão com `fork_source` (campo em memória, por sessão) para tê-lo aqui.

  Roda uma vez por sessão: sem `fork_source`, não repete.
- **`forkPreviewPage`:** só age quando a sessão tem `fork_source` e a conversa própria ainda não existe. Lê a página da origem com `before = min(before ?? ∞, previewBefore)`, pela mesma `lastEventsOf`.

- [ ] **Step 1: Testes que falham:**
  - `branchName`: `"X (ramo)"`, depois `"X (ramo 2)"` com o primeiro ocupado; nome só com espaços cai no padrão; nome dado vale como está;
  - `posição logo abaixo do original, mesmo grupo e setor, cor, ícone e heads_up`;
  - `motor do ramo garantido na lista de motores`;
  - `user_projects copiados: quem via o original vê o ramo`;
  - `não herda`: `terminal_state` sem linha, fila vazia, nenhum agendamento, nenhuma triagem;
  - `não admin: 403 fork_admin_only`;
  - `Claude: sessão com --resume src --fork-session --session-id escolhido --resume-session-at corte, e claude_session_id gravado na hora`;
  - `Claude no meio do turno: o corte é o último turno fechado`;
  - `Codex: lastTurnId do último task_complete`;
  - `revive antes do primeiro turno copia de novo, com o mesmo corte`;
  - `primeiro turno bom limpa fork_source`;
  - `prévia: o histórico do ramo antes do primeiro turno é o do original até o corte`;
  - `cópia recusada: revive em conversa nova e manda o pacote uma vez`;
  - `cópia recusada na primeira mensagem do operador: depois do pacote, a mensagem dele é reenviada uma vez`;
  - `Kimi: conversa nova recebe o pacote como mensagem do Claudinei e nada vai à fila antes do fim desse turno`;
  - `os dois terminais passam a usar ownResume (pasta compartilhada)`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `routes-projects.test.ts`, `projects-order.test.ts`, `sidebar-order-sectors.test.ts` e `history-routes.test.ts`.
- [ ] **Step 5: Commit** `feat(ramificar): /fork cria o terminal irmão com a cópia`.

### Task 9: Continuar noutro motor

**Files:**
- Create: `server/src/branch/switch-engine.ts`
- Modify: `server/src/branch/service.ts`, `server/src/routes/branch.ts`
- Test: `server/test/branch-switch.test.ts`

**Interfaces:**
```ts
export async function switchEngine(deps: SwitchDeps, req: { projectId: number; from: string; to: string }): Promise<SessionInfo>
```
- **A rota:** `POST /api/projects/:id/handoff { from, to }`, com `canAccessProject`. Responde 201 com o `SessionInfo` do destino.
- **Os passos de `switchEngine`, nesta ordem:**
  1. Valida: `from === to` dá `handoff_same_engine`; `to` fora da lista do terminal ou não instalado dá `handoff_engine_unavailable`.
  2. A origem é a sessão viva de `from`, ou a mais recente com conversa. Sem ela, `no_conversation`.
  3. Destino vivo e `working` dá `handoff_target_busy`. `limitActive(store.get(projectId, to))` dá `handoff_target_limited`.
  4. Monta o pacote com `collectHandoff(..., { working: origem trabalhando })`, **antes** de mexer no destino.
  5. Destino vivo e ocioso: `await manager.stop(localId)`. Se lançar, aborta sem criar nada.
  6. Goal do destino em `active` ou `waiting`: `store.setGoalStatus(projectId, to, 'paused', 'operator')` e `restart.publish`.
  7. `manager.start(project, { engine: to, continueLatest: false })` e `manager.sendAsClaudinei(localId, handoff.text)`.

  A origem não muda. A fila e os avisos de resultado do destino ficam como estão: o árbitro os entrega depois do turno do pacote.

- [ ] **Step 1: Testes que falham:**
  - `destino trabalhando: 409 handoff_target_busy e nada parado`;
  - `destino no limite: 409 handoff_target_limited`;
  - `destino ocioso é encerrado e abre conversa nova com o pacote`;
  - `stop que falha: nada criado`;
  - `goal ativo do destino pausa por operator`;
  - `fila do destino sai só depois do turno do pacote`: com o árbitro real e um item na fila, o primeiro envio é o pacote e o segundo é o item;
  - `origem trabalhando: o pacote vai até o último turno fechado`;
  - `origem segue viva e intocada`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `next-send-order.test.ts` e `goal.test.ts`, depois `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(ramificar): continuar noutro motor com o pacote de contexto`.

### Task 10: Web: comandos, cliente e estado da lateral

**Files:**
- Create: `web/src/branch/commands.ts`, `web/src/branch/api.ts`, `web/src/branch/sideStore.ts`
- Modify: `web/src/slash.ts`: `side`, `btw` e `fork` em `SLASH_DESCRIPTIONS`, `BUILTIN_FALLBACK` e `CLAUDINEI_COMMANDS`.
- Modify: `web/src/App.tsx`: no callback do WS, `(msg) => { if (applySideMessage(msg)) return; useStore.getState().applyWsMessage(msg) }`.
- Modify: `web/src/components/ChatInput.tsx`: em `send`, logo depois do `if (disabled) return` e antes da fila, desvia `parseBranchCommand(trimmed)` para `runBranchCommand` e limpa o campo como no envio.
- Modify: `web/src/types.ts`: `Project.forkedFrom` e `Project.forkedCutAt`.
- Modify: `web/src/i18n/{pt-BR,en,es}.ts`: `slash.side`, `slash.btw`, `slash.fork`, os erros novos em `serverErrors` e o namespace `branch`.
- Test: `web/src/test/branch-commands.test.ts`, `web/src/test/side-store.test.ts`, `web/src/test/chatinput-branch.test.tsx`

**Interfaces:**
```ts
// commands.ts
export const SIDE_COMMAND = /^\/(side|btw)(\s|$)/
export const FORK_COMMAND = /^\/fork(\s|$)/
export type BranchCommand = { kind: 'side'; text: string } | { kind: 'fork'; name: string }
export function parseBranchCommand(text: string): BranchCommand | null
export async function runBranchCommand(cmd: BranchCommand, ctx: { localId: string; projectId: number; engine: string }): Promise<void>
// api.ts
getSide, openSide(projectId, engine, text?, replace?), sendSide, interruptSide, closeSide,
forkTerminal(projectId, engine, name?) → { project, session }, handoff(projectId, from, to) → SessionInfo
// sideStore.ts (zustand próprio, fora do store.ts)
interface SideView { info: SideInfo; items: ChatItem[] }
useSideStore: { sides: Record<string, SideView>; replaceAsk: { projectId: number; engine: string; text: string } | null
  appendRequest: { localId: string; text: string; attachments: Array<[string, string]>; seq: number } | null }
export function applySideMessage(msg: any): boolean          // side_state / side_event; true = consumiu
export function useSideSync(projectId: number, engine: string): SideView | undefined   // GET no mount e a cada progressEpoch
export function requestAppend(localId: string, text: string, attachments?: Array<[string, string]>): void
```
- **`runBranchCommand`:**
  - `side` chama `openSide`. Num 409 `side_exists`, preenche `replaceAsk`, e a coluna confirma.
  - `fork` chama `forkTerminal`, grava o projeto em `setProjects` e abre a sessão com `openSession(session.localId)`.
  - Os outros erros vão ao chat como `addLocalItem(localId, { kind: 'command_output', text: localizeServerError(body), isError: true })`.
- **Itens da lateral:** `applySideMessage` aplica cada evento aos itens com `applyEvent` (`web/src/chat/applyEvent.ts`).

- [ ] **Step 1: Testes que falham:**
  - `parseBranchCommand`: `/side x`, `/btw`, `/fork`, `/fork Nome`; `/sidebar` e `/forked` não casam;
  - `slash: side, btw e fork aparecem para qualquer motor`;
  - `chatinput: /side no meio do turno do Kimi chama openSide e não vai à fila`;
  - `chatinput: Alt+Enter com /btw também chama a rota`;
  - `chatinput: o campo limpa e nenhum balão otimista aparece`;
  - `409 side_exists vira replaceAsk`;
  - `/fork com 403 mostra "Só um administrador pode criar terminais"`;
  - `side_event monta itens; side_state null remove a lateral`;
  - `useSideSync relê ao reconectar`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `chatinput-slash.test.tsx` e `chatinput-queue.test.tsx`, depois `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(ramificar): comandos e estado da lateral na web`.

### Task 11: Web: a coluna lateral e Trazer de volta

**Files:**
- Create: `web/src/components/SideColumn.tsx`, `web/src/branch/bringBack.ts`
- Modify: `web/src/components/ChatView.tsx`: troca a linha da `ProgressColumn` por `{side ? <SideColumn …/> : progressOpen && <ProgressColumn …/>}`, com `const side = useSideSync(session.projectId, engine)`.
- Modify: `web/src/components/ChatInput.tsx`: um efeito sobre `useSideStore((s) => s.appendRequest)` que acrescenta o texto ao fim do campo, com `\n\n` se houver texto, e registra os anexos em `attachments.current`.
- Modify: `web/src/styles.css`: classes `.side-col*` no molde de `.progress`. No celular (`max-width: 768px`), a coluna cobre o chat. Sem `transition` nem `animation`.
- Test: `web/src/test/side-column.test.tsx`, `web/src/test/bring-back.test.ts`

**Interfaces:**
```ts
// bringBack.ts
export const BRING_BACK_QUESTION_MAX = 80
export function lastAnswer(items: ChatItem[]): { question: string | null; answer: string } | null  // último texto do agente depois da última mensagem do operador
export function bringBackText(question: string | null, answer: string): string  // "Da conversa lateral («…»):\n…"
export function bringBackFileName(now?: Date): string                            // lateral-HHMMSS.md
export async function bringBack(localId: string, items: ChatItem[]): Promise<void>  // grande → uploadFile + token; senão texto
```
- **Cabeçalho da coluna:**
  - "Conversa lateral", o ícone e o nome do motor;
  - "cópia até HH:MM", quando há `cutAt`;
  - o aviso de arquivos (`branch.files.<files>`);
  - o ponto estático (`dotClassOf({ status })`) e ×. O × confirma só se a lateral estiver `working`.
- **Corpo:** `MessageBlock` com `currentLocalId` da principal e `editable={false}`.
- **Pé:**
  - campo simples de texto com anexos, sem fila. Desabilitado em `working` quando o motor não tem `midTurnInput`;
  - Enviar; Parar (`interruptSide`), só trabalhando;
  - **Trazer de volta**, ativo quando a lateral não está `working` e `lastAnswer` existe.
- **`replaceAsk`:** abre `ConfirmDialog` com "Fechar a conversa lateral atual e abrir outra?". Confirmar chama `openSide(..., replace = true)`.

- [ ] **Step 1: Testes que falham:**
  - `a coluna aparece no lugar da de acompanhamento e ela volta ao fechar`;
  - `aviso de arquivos por motor`: Codex mostra "Só leitura", Claude e OpenCode "Sem ferramentas de edição…", Kimi "Pode alterar arquivos da pasta";
  - `Trazer de volta acrescenta depois do texto que já havia, sem substituir`;
  - `pergunta acima de 80 caracteres termina em "…"`;
  - `resposta com 101 linhas vira anexo lateral-HHMMSS.md e o campo recebe o token`;
  - `Trazer de volta desligado trabalhando`;
  - `campo da lateral desabilitado trabalhando no Kimi e habilitado no Claude`;
  - `× trabalhando pede confirmação; ocioso fecha direto`;
  - `trocar de aba de motor mostra a lateral daquele motor`;
  - `sem rostinho: a coluna não renderiza AgentFace`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `chatview.test.tsx` e `chatinput-upload.test.tsx`, depois `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(ramificar): coluna da conversa lateral e Trazer de volta`.

### Task 12: Web: "ramo de", o menu ⇄ e o cartão do pacote

**Files:**
- Create: `web/src/components/HandoffMenu.tsx`, `web/src/components/HandoffCard.tsx`, `web/src/branch/handoff.ts`
- Modify: `web/src/components/EngineTabs.tsx`: na aba ativa e viva, um botão ⇄ ao lado do ⏻ (`title` = "Continuar noutro motor") que abre `<HandoffMenu>`.
- Modify: `web/src/components/ChatView.tsx`: em `.chat-header__project`, depois do selo da pasta compartilhada, `<span className="chat-header__fork">ramo de <nome> · cópia até HH:MM</span>`, quando `project.forkedFrom` aponta para um projeto conhecido.
- Modify: `web/src/chat/applyEvent.ts`: `HANDOFF_PREFIX` e o parse do cabeçalho em `{ kind: 'claudinei_message', reason: 'handoff', engineLabel, messages, tokens, request? }`.
- Modify: `web/src/types.ts`: a variante `reason: 'handoff'` de `ChatItem`.
- Modify: `web/src/components/MessageBlock.tsx`: um `case 'handoff': return <HandoffCard item={item} />`.
- Test: `web/src/test/handoff-menu.test.tsx`, `web/src/test/applyEvent.test.ts` (casos novos), `web/src/test/chatview.test.tsx` (caso novo)

**Interfaces:**
```ts
// branch/handoff.ts
export type HandoffTargetState = 'none' | 'idle' | 'working' | 'limited'
export interface HandoffTarget { engine: EngineMeta; state: HandoffTargetState; limitUntil?: string;
  pending: { goal: boolean; queue: number; taskResults: number } }
export function handoffTargets(p: { projectId: number; from: string; engines: EngineMeta[]; listed: string[];
  sessions: Record<string, SessionInfo>; terminalStates: Record<string, TerminalState>; queues: Record<string, OperatorQueue> }): HandoffTarget[]
export function parseHandoffHeader(text: string): { engineLabel: string; messages: number; tokens: number; request?: string } | null
```
- **`HandoffMenu`:**
  - no padrão `.sess-pop` com `ViewportPopover`, como o "+";
  - lista os motores da lista do terminal, instalados e diferentes do atual;
  - em cada um:
    - o estado: `branch.target.none` "sem conversa", `idle` "ocioso — a conversa atual será encerrada (fica no histórico)", `working` "trabalhando — indisponível" e `limited` "no limite até HH:MM — indisponível";
    - as pendências: "goal ativo", "N na fila", "N avisos de resultado".
  - Rodapé: "o <origem> continua aberto; pare-o se não quiser os dois na pasta".
- **Escolher um destino:**
  1. Destino `idle`: confirma antes com `ConfirmDialog`.
  2. Chama `handoff(projectId, from, to)`.
  3. Abre a sessão devolvida (`openSession`).
  4. Erro: mostra `localizeServerError` no menu (`.sess-pop__error`).
- **`HandoffCard`:** "Contexto trazido do <Motor>: N mensagens (~T mil tokens)", dobrado por padrão. Abre o corpo em `<pre>` sem animação. O `request`, quando há, aparece abaixo como texto do operador.

- [ ] **Step 1: Testes que falham:**
  - `handoffTargets`: estados `none`, `idle`, `working` e `limited`, e pendências de goal, fila e avisos;
  - `trabalhando e no limite ficam desabilitados`;
  - `ocioso pede confirmação antes do POST`;
  - `após o POST, a aba do destino abre`;
  - `parseHandoffHeader lê Motor, N e T, e separa o request`;
  - `applyEvent: mensagem com o selo vira o cartão`;
  - `cartão mostra "~16 mil tokens" para 15800`;
  - `cabeçalho do chat mostra "ramo de X · cópia até 14:05"`; com o original apagado (`forkedFrom` nulo), nada aparece.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar e ver passar.** Rodar também `engine-tabs*.test.tsx`, se existir, e `applyEvent.test.ts`. Depois, a suíte inteira da web (`npx vitest run`) e `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(ramificar): ramo de, menu continuar noutro motor e cartão do pacote`.

### Task 13: Ensaio numa instância isolada (porta 9195)

**Files:** nenhum de produção. Os scripts ficam em `/tmp/claudinei-e2e-ramificar-scripts/`.

- [ ] **Step 1: Subir a instância**, no molde da memória `verificar-e2e-sem-reiniciar`:
  - variáveis: `CLAUDINEI_PORT=9195`, e `CLAUDINEI_DB`, `CLAUDINEI_UPLOADS`, `CLAUDINEI_SCHEDULES`, `CLAUDINEI_SPEECH` e `CLAUDINEI_PROGRESS` sob `/tmp/claudinei-e2e-ramificar`;
  - motores falsos: `CLAUDINEI_CLAUDE_BIN=<worktree>/server/test/fake-claude.mjs`, `CLAUDINEI_CODEX_BIN=<worktree>/server/test/fake-codex.mjs` e `CLAUDINEI_KIMI_BIN=<worktree>/server/test/fake-kimi.mjs`;
  - `CLAUDE_CONFIG_DIR=/tmp/claudinei-e2e-ramificar/claude`;
  - construir a web antes; comando `node --import tsx src/index.ts` em `server/`, com Node 24 e `setsid`;
  - parar sempre pelo PID da porta 9195, nunca com `pkill -f`.
- [ ] **Step 2: Lateral com a principal trabalhando** (Claude):
  1. Mandar `demorada`.
  2. Digitar `/side o que foi feito?`. A coluna abre com "cópia até HH:MM" e o aviso de arquivos, e a resposta chega.
  3. A principal segue trabalhando.
  4. Recarregar a página: a coluna volta como estava.
  5. Trocar para a aba do Codex: sem lateral.
- [ ] **Step 3: Trazer de volta.**
  1. Com texto no campo da principal, clicar Trazer de volta. O texto fica e a resposta entra depois.
  2. Com uma resposta longa (`__large__` no Codex, ou 101 linhas), o campo recebe `[📎 lateral-….md]`.
- [ ] **Step 4: `/fork`.**
  1. `/fork` cria "<nome> (ramo)" logo abaixo, abre o terminal novo com "ramo de" e mostra a prévia até o corte.
  2. Mandar uma mensagem no ramo: o `fork_source` some do banco.
  3. `/fork` de novo cria "(ramo 2)".
- [ ] **Step 5: Troca de motor.**
  1. Pelo ⇄, do Claude para o Kimi.
  2. A aba do Kimi abre com o cartão "Contexto trazido do Claude Code", dobrado.
  3. Com o Kimi trabalhando, o ⇄ do Claude mostra o Kimi indisponível.
- [ ] **Step 6: Queda.**
  1. Abrir um `/side` no Kimi e mandar SIGTERM à 9195.
  2. Subir de novo: `side_threads` vazia e a pasta `side-<id>` apagada.
- [ ] **Step 7: Limpar.**
  1. Parar pelo PID da 9195, conferindo que não é o da 9105.
  2. Apagar `/tmp/claudinei-e2e-ramificar*`.
  3. Tirar capturas com o Playwright e registrar o resultado no relatório da trilha.
