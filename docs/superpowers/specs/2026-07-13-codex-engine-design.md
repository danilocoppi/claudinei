# SP-B — Adapter do Codex (backend) — Design

**Data:** 2026-07-13
**Status:** Aprovado (spikes empíricos embutidos)
**Contexto:** 2º de 3 sub-projetos. Depende do SP-A (abstração de engine, já mergeado).
Implementa `codexEngine` slotando na interface `Engine`/`EngineSession` do SP-A.
Sequência: SP-A ✅ → **SP-B (este)** → SP-C (UX por engine no frontend).

## Objetivo

Registrar uma engine `'codex'` que roda o Codex CLI (OpenAI) por terminal, com
contexto próprio, coexistindo com o Claude (1 Claude + 1 Codex por terminal — trava
`(projeto, engine)` do SP-A). O Codex é **turn-based** (1 processo por turno) atrás da
mesma `EngineSession` EventEmitter que o Claude usa, com os eventos normalizados para
o shape `AgentEvent` que o frontend já renderiza. STT, colar imagem e drop de arquivo
seguem intactos (agnósticos de engine).

## Spikes (empíricos, 2026-07-13, codex-cli 0.144.3, logado via ChatGPT)

- `codex exec --json` emite JSONL schema v2: `thread.started {thread_id}` →
  `turn.started {}` → `item.started/item.completed {item}` → `turn.completed {usage}`.
  Item types observados: `agent_message {text}` (texto do assistant),
  `command_execution {command, aggregated_output, exit_code, status}` (tool shell).
  Outros existentes: `reasoning`, `file_change`, `mcp_tool_call`, `todo_list`,
  `web_search`, `error` (a normalização trata os conhecidos e faz fallback nos demais).
- **Turn-based**: o processo roda o turno e sai (exit 0). Próximo turno:
  `codex exec resume <thread_id> [flags] -` (prompt via stdin). Provado: resume
  mantém o mesmo `thread_id`, o cwd (do processo) e o contexto (criou o arquivo pedido).
- `thread_id` (de `thread.started`) é o id de conversa a persistir — análogo ao
  `claude_session_id`. Reusa a coluna `claude_session_id` no SP-B (o rename para
  `engine_session_id` é SP-C).
- Full-access: `--dangerously-bypass-approvals-and-sandbox` (aceito em `exec` e
  `exec resume`). `-m <model>`; effort via `-c model_reasoning_effort="<nível>"`.
- Prompt via **stdin** (`-` como PROMPT) — evita escaping de argv (mensagens têm
  quebras de linha, aspas, paths colados). O processo lê stdin até EOF.
- Sessões persistidas em `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`
  (formato de `response_item` da Responses API) — base para `readHistory`.

## Decisões (já tomadas no brainstorm do SP-A)

- **Sandbox = full-access sempre** (espelha o Claude de hoje): sem seletor; toda
  sessão Codex roda `--dangerously-bypass-approvals-and-sandbox`.
- **Slash `/`**: comandos curados da TUI do Codex — mas isso é UX, **SP-C**. No SP-B
  `capabilities().slashSource = 'curated'` e `slashCommands` do init do Codex = `[]`.
- **Registry aberto**: adicionar o Codex = `registerEngine(codexEngine)` no
  `engine/index.ts`. Zero mudança no manager/rotas/DB (já preparados no SP-A).

## Componentes

### `server/src/engine/codex/` (novo)

Isola a engine Codex num diretório próprio (espelha o papel de `claude/`).

- **`codex-args.ts`** — funções puras que montam o argv de um turno:
  - `buildExecArgs(opts)` → primeiro turno: `['exec', '--json',
    '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    ...modelArgs, ...effortArgs, ...mcpArgs, '-']`.
  - `buildResumeArgs(threadId, opts)` → turnos seguintes: `['exec', 'resume',
    threadId, '--json', '--dangerously-bypass-approvals-and-sandbox', ...modelArgs,
    ...effortArgs, ...mcpArgs, '-']`.
  - `modelArgs` = `['-m', model]` se model; `effortArgs` =
    `['-c', 'model_reasoning_effort="<nível>"']` se effort ∈ {minimal,low,medium,high};
    `mcpArgs` = overrides `-c mcp_servers.hermes.command=...` etc. (ver hermes abaixo).

- **`codex-parser.ts`** — `classifyCodexLine(line): AgentEvent | null` + um
  `createCodexTurnParser(onEvent)` (buffer NDJSON). Normaliza v2 → `AgentEvent`
  (shape do Claude, `server/src/claude/events.ts`), para o frontend renderizar igual:
  | Codex | AgentEvent |
  |---|---|
  | `thread.started {thread_id}` | `{ kind: 'init', sessionId: thread_id, model, slashCommands: [], raw }` |
  | `item.completed` `agent_message {text}` | `{ kind: 'assistant', message: { role:'assistant', content:[{type:'text', text}] }, raw }` |
  | `item.completed` `reasoning {text}` | `{ kind: 'assistant', message: { content:[{type:'thinking', thinking:text}] }, raw }` |
  | `item.completed` `command_execution {command, aggregated_output, exit_code, status}` | `assistant` com bloco `tool_use` (`name:'shell'`, `input:{command}`, `id:item.id`) **seguido de** `user` com `tool_result` (`tool_use_id:item.id`, `content:aggregated_output`, `is_error: exit_code!==0`) |
  | `item.completed` `file_change`/`mcp_tool_call`/outros | `assistant` `tool_use` com `name` do tipo e `input` = payload; sem tool_result sintético se não houver saída |
  | `turn.completed {usage}` | `{ kind: 'result', subtype:'success', isError:false, resultText:<último agent_message>, costUsd:0, raw }` |
  | `turn.failed {error}` | `{ kind:'result', subtype:'error', isError:true, resultText:error, costUsd:0, raw }` |
  | `item.started` / `item.updated` | ignorados no SP-B (só `item.completed` vira chat; partials/streaming ao vivo ficam para depois) |
  | linha desconhecida | `{ kind:'raw', raw }` (não vaza como chat) |

- **`codex-session.ts`** — `class CodexSession extends EventEmitter implements
  EngineSession`. Ciclo turn-based:
  - Estado: `status: SessionStatus`, `sessionId?: string` (thread_id), `lastStderr`,
    `model?/effort?` (para os args do próximo turno), `proc?` (turno atual).
  - `start()`: **não** spawna processo. Se `resumeSessionId` presente (revive),
    guarda-o como `sessionId` e vai para `idle` (o thread existe no disco). Senão,
    `idle` sem thread (nasce no 1º `send`). Emite `status` inicial. (Diferente do
    Claude, que spawna no start; aqui o processo só existe durante um turno.)
  - `send(text)`: recusa se `working`/`stopped`/`dead`. Spawna o turno:
    `codex` com `buildExecArgs` (sem thread) ou `buildResumeArgs(sessionId)` (com
    thread), `cwd=projectPath`, escreve `text` no stdin e fecha (`stdin.end`).
    `status='working'`. stdout → `createCodexTurnParser` → normaliza → no `init`
    captura `sessionId=thread_id` e emite; nos demais emite `event`. No `close`:
    se saiu com o turno completo → `needs_attention` (havia result) ou `idle`; se
    erro/kill → conforme. stderr → tail (20 linhas) + emit.
  - `interrupt()`: se `working` e há `proc`, mata o processo do turno (SIGTERM→SIGKILL);
    o thread persiste (resumível). Fora de `working`, no-op.
  - `stop()`: mata o `proc` se houver; `status='stopped'`.
  - `setModel(model)`: guarda para o próximo turno (Codex não troca model a quente);
    persistência é do manager. `setPermissionMode(_)`: no-op (full-access fixo).
  - `markRead()`: `needs_attention`→`idle` (igual ao Claude).

- **`codex-engine.ts`** — `codexEngine: Engine` (id `'codex'`):
  - `createSession(opts)` → `new CodexSession(opts)`.
  - `readHistory(projectPath, threadId)` → localiza
    `~/.codex/sessions/**/rollout-*-<threadId>.jsonl` (glob por sufixo do id) e
    normaliza os `response_item` para `AgentEvent[]` (parser de rollout, reusando o
    mapeamento de items). Vazio se não achar.
  - `latestConversationId(projectPath)` → o `thread_id` do rollout mais recente cujo
    `session_meta.cwd === projectPath` (varre `~/.codex/sessions`), ou null.
  - `terminalCommand({resumeSessionId, projectPath, bin})` → `{ file: bin ?? 'codex',
    args: ['resume', resumeSessionId, '--dangerously-bypass-approvals-and-sandbox'] }`
    (TUI interativa continuando o thread).
  - `capabilities()` → `{ models: ['', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'],
    efforts: ['minimal','low','medium','high'], permissions: [], slashSource: 'curated' }`
    (a lista de models canônica é confirmada no de-risk; permissions vazia = sem
    seletor de sandbox).

### `server/src/engine/index.ts` (modificar)

Uma linha: `registerEngine(codexEngine)` (guardado por `hasEngine`).

### Rewiring dos call-sites de terminal e histórico (agora sim, com 2 engines)

Necessário para o Codex funcionar de ponta a ponta (o SP-A deixou definido+testado, o
SP-B religa porque agora os caminhos divergem por engine):
- **`server/src/claude/manager.ts` `openInTerminal`** + **`server/src/terminal/manager.ts`**:
  em vez do `['--resume', id, '--dangerously-skip-permissions']` inline (Claude), usar
  `getEngine(row.engine).terminalCommand({ resumeSessionId, projectPath, bin })` → `{file, args}`.
  `TerminalLauncherOpts`/`OpenOpts` passam a carregar `file`/`args` (em vez de
  `claudeBin`/`skipPermissions`). O guard de `openInTerminal` que exige
  `claude_session_id` vira "exige `claude_session_id` (o thread da engine)".
- **Rota `GET /api/sessions/:localId/history`** (`server/src/routes/sessions.ts`): em vez
  de chamar `readTranscript`/`latestTranscriptId` (Claude) direto, resolver
  `getEngine(session.engine).readHistory(project.path, threadId)` /
  `.latestConversationId(project.path)`. Comportamento do Claude idêntico (o
  `claudeEngine` delega às mesmas funções).

### `server/src/config.ts` (modificar)

`codexBin` (env `CLAUDINEI_CODEX_BIN` ?? `'codex'`) — análogo a `claudeBin`. O
`codexEngine` lê o bin dos `opts.bin`; o manager passa o bin certo por engine.

**Ponto de atenção (bin por engine):** hoje o manager passa `deps.claudeBin` como
`bin` a QUALQUER engine. O SP-B generaliza: o manager passa o bin da engine-alvo —
`deps.claudeBin` para `'claude'`, `deps.codexBin` para `'codex'`. Como cada engine
também tem um default próprio (`'claude'`/`'codex'`), a forma mais limpa é o manager
**não** injetar bin e cada engine resolver o seu de env/config. O SP-B faz isso:
`claudeEngine` e `codexEngine` leem o próprio bin de env (com default), e o manager
deixa de passar `bin`. (Refina o SP-A, onde o manager injetava `deps.claudeBin`.)

## De-risk (1ª task do plano, antes de construir o resto)

Spike controlado, rodado pelo implementador na máquina (Codex logado):
1. Injeção de MCP via `-c`: confirmar a forma exata que faz o Codex subir o hermes
   (`-c mcp_servers.hermes.command=...`, `-c mcp_servers.hermes.args='[...]'`,
   `-c mcp_servers.hermes.env.CHAVE="..."`) e que uma tool do hermes responde num
   turno. Ajustar `buildExecArgs`/`buildResumeArgs` ao que funcionar.
2. Interrupt: matar o processo de um turno em andamento deixa o thread resumível?
   (rodar um turno longo, matar, `resume` e ver o contexto intacto).
3. Lista de models: `codex` expõe uma lista canônica (ex. via `models_cache.json` ou
   um comando)? Fixar a lista de `capabilities().models`.

Se algum ponto divergir, ajustar o design antes de seguir — mesmo protocolo do spike
do empacotamento.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| `codex` não instalado | turno falha ao spawnar → `status='dead'`, `lastStderr` explica |
| Turno morto por interrupt | thread persiste; `revive`/próximo `send` retoma via resume |
| `thread.started` nunca chega (falha cedo) | sessão sem `sessionId`; `result`/`dead` conforme stderr |
| `readHistory` sem rollout do thread | `[]` (a UI mostra a conversa a partir dos eventos ao vivo) |
| Item type desconhecido | `raw` (não quebra o chat) |
| MCP hermes falha | turno segue sem as tools (não derruba a sessão) |

## Testes

- `codex-args`: buildExec/buildResume montam o argv certo (flags, model, effort, mcp,
  stdin `-`); sem model/effort não passam as flags.
- `codex-parser`: cada mapeamento v2→AgentEvent (thread.started→init com sessionId;
  agent_message→assistant text; command_execution→tool_use+tool_result com is_error
  por exit_code; reasoning→thinking; turn.completed→result; turn.failed→result erro;
  desconhecido→raw) — com fixtures das linhas reais capturadas no spike.
- `codex-session` (com um **fake-codex** em `server/test/fake-codex.mjs`, análogo ao
  fake-claude: um script que emite as linhas v2 no stdout e sai): start não spawna;
  send spawna o turno e emite init+assistant+result; sessionId capturado; 2º send usa
  resume com o thread; interrupt mata o turno; stop encerra.
- `codex-engine`: conformidade com `Engine` (createSession/terminalCommand/
  capabilities/readHistory com rollout fixture/latestConversationId).
- **Integração no manager (reuso do SP-A):** registrando o `codexEngine`, `manager.
  start(project, { engine: 'codex' })` cria uma CodexSession; 1 Claude + 1 Codex
  coexistem no mesmo projeto (a trava `(projeto, engine)` já testada no SP-A agora
  vale com engines reais).
- **Regressão:** suíte inteira verde e inalterada (Claude intocado). `web/` intocado.
- Smoke real (implementador, Codex logado): `manager.start(engine:'codex')` num projeto
  real → mensagem → turno roda → chat popula → resume no 2º turno → interrupt.

## Fora de escopo (YAGNI / outros SPs)

- UX de seleção de engine, ícone da engine, slash curado do Codex, listas por engine
  na UI, rename `claudeSessionId`→`engineSessionId` — tudo **SP-C**.
- Streaming ao vivo de parciais do Codex (`item.started`/`item.updated`) — só
  `item.completed` no SP-B; parciais podem vir depois.
- Imagens no turno do Codex via `-i` (colar/dropar já injeta o path no texto como hoje;
  o `-i` nativo fica para um follow-up se necessário).
