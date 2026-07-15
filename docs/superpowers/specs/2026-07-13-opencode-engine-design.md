# OpenCode como 3ª engine — Design

**Data:** 2026-07-13
**Status:** Aprovado (spike da superfície do CLI feito; schema de eventos é de-risk com auth)
**Contexto:** Adiciona o OpenCode (opencode.ai / sst/opencode) como TERCEIRA engine,
ao lado de Claude Code e Codex. Prova a extensibilidade da abstração de engine
(`server/src/engine/`): implementar `Engine` + `registerEngine`, **zero mudança** em
manager/rotas/DB; o frontend é dirigido por `GET /api/engines`. Espelha o adapter do
Codex (`server/src/engine/codex/`), que já é turn-based.

## Objetivo

Rodar o OpenCode por terminal, com contexto próprio, coexistindo com Claude e Codex
(trava `(projeto, engine)`). O OpenCode é **turn-based** (`opencode run` = 1 processo
por turno) atrás da mesma `EngineSession` EventEmitter, com eventos normalizados para
o shape `AgentEvent` que o frontend já renderiza. STT/anexos intactos.

## Spike (empírico, 2026-07-13, opencode 1.17.20 — superfície do CLI, SEM auth ainda)

- `opencode run [message..]` = modo headless. `--format json` → **eventos JSON crus**.
  Turn-based: um processo roda o turno e sai; próximo turno via `-s/--session <id>`
  (ou `-c/--continue`). Prompt como argv posicional (sem shell → sem escaping).
- Flags: `-m provider/model` (model), `--variant high|max|minimal` (reasoning effort),
  `--auto` (auto-aprova permissões = full-access), `-f <file>` (anexos), `--agent`,
  `--title`, `--thinking`.
- `opencode models` lista os models disponíveis (funciona sem auth; reflete os
  providers configurados). `opencode stats` = tokens/custo. `opencode export <id>` =
  JSON da sessão (histórico). `opencode session` = gerência de sessões.
- Config em `~/.config/opencode/opencode.jsonc`; sessões em `~/.local/share/opencode`.
  MCP via config (`mcp` no opencode.json) ou `opencode mcp add`.
- Terminal interativo: `opencode --session <id>` (TUI resume) / `opencode` (fresh).

## Decisões (do usuário)

- **Full-access sempre:** todo turno usa `--auto`. Sem seletor de permissão
  (`capabilities().permissions = []`).
- **Models dinâmicos:** `capabilities().models` roda `opencode models` (cacheado) —
  reflete os providers reais do usuário (não hardcode).
- **Slash curado:** `slashSource = 'curated'` com um conjunto curado dos slash da TUI
  do OpenCode (`slashCommands`).

## Componentes (espelham `server/src/engine/codex/`)

### `server/src/engine/opencode/` (novo)

- **`opencode-args.ts`** — argv puro:
  - `buildRunArgs(opts)` (1º turno): `['run', '--format', 'json', '--auto', ...modelArgs,
    ...variantArgs, ...titleArgs, '--', <prompt>]`.
  - `buildResumeArgs(sessionId, opts)`: `['run', '--format', 'json', '--auto', '-s',
    sessionId, ...modelArgs, ...variantArgs, '--', <prompt>]`.
  - `modelArgs` = `['-m', model]` se model; `variantArgs` = `['--variant', effort]` se
    effort ∈ allowlist (valores confirmados no de-risk). O prompt vai como último argv
    (posicional message), não por stdin.
- **`opencode-parser.ts`** — `classifyOpenCodeLine(line, model?): AgentEvent[]` +
  `createOpenCodeTurnParser(onEvent, model?)` (buffer NDJSON, preenche `result.resultText`
  com o último texto do assistant + `result.tokens` se os eventos trouxerem usage).
  **O mapeamento exato evento→AgentEvent depende do schema real dos eventos `run
  --format json`, capturado no de-risk (Task 1) como fixtures.** Alvo: sessão iniciada
  → `init` (sessionId capturado); texto do assistant → `assistant` text; tool calls →
  `assistant` tool_use (+ `user` tool_result); reasoning/thinking → thinking; fim do
  turno → `result`; desconhecido → `raw`.
- **`opencode-session.ts`** — `class OpenCodeSession extends EventEmitter implements
  EngineSession`, turn-based (espelha `CodexSession`): `start()` não spawna; `send()`
  spawna `opencode run` (1º turno) ou `run -s <sessionId>` (seguintes), prompt como
  argv; captura `sessionId` do evento de init; `interrupt()` mata o turno (SIGTERM→
  SIGKILL) sem matar a sessão (flag `interrupting`→idle, thread preservado); `stop()`
  encerra; `setEffort`/`setModel` guardam para o próximo turno; `setPermissionMode`
  no-op. `PKG_EXECPATH:''` no env do spawn.
- **`opencode-engine.ts`** — `openCodeEngine: Engine` (id `'opencode'`):
  - `createSession(opts)` → `new OpenCodeSession(opts)`.
  - `readHistory(projectPath, sessionId)` → `opencode export <sessionId>` (spawn síncrono
    ou leitura do storage) normalizado para `AgentEvent[]` (formato confirmado no de-risk).
  - `latestConversationId(projectPath)` → a sessão mais recente do cwd (via
    `opencode session`/storage), ou null (sem preview) — confirmado no de-risk.
  - `terminalCommand({resumeSessionId, projectPath, bin})` → com id:
    `{ file: bin ?? 'opencode', args: ['--session', id, '--auto'] }`; sem id (fresh):
    `{ file, args: ['--auto'] }`.
  - `capabilities()` → `{ models: <de `opencode models`, cacheado>, efforts: <variants>,
    permissions: [], slashSource: 'curated', slashCommands: [<curados>], label:
    'OpenCode', icon: '◇' }`. Cache dos models (ex.: 5 min) para não spawnar a cada
    `GET /api/engines`.

### Mudanças mínimas fora do diretório novo

- `server/src/engine/index.ts`: `registerEngine(openCodeEngine)` (1 linha, guardada por
  `hasEngine`).
- `server/src/config.ts`: `opencodeBin` (env `CLAUDINEI_OPENCODE_BIN` ?? `'opencode'`).
- **Frontend:** nenhuma mudança estrutural (dirigido por `/api/engines`) — só as
  descrições i18n dos slash curados do OpenCode em `SLASH_DESCRIPTIONS` (sem descrição
  degrada bem) e conferir que o ícone `◇` renderiza no seletor/abas/badge. O card de
  Usage já mostra "OpenCode" automaticamente se houver tokens.

## Usage

Os tokens do turno do OpenCode (se os eventos `run --json` os trouxerem, ou via
`opencode stats`) entram no `engine_usage_daily` existente via `onEngineUsage(
'opencode', tokens)` — o card mostra "OpenCode: total + hoje" sozinho. Se os eventos
não trouxerem usage, o de-risk decide (usar `opencode stats` ou pular o usage do
OpenCode — a engine funciona sem isso).

## De-risk — CONCLUÍDO (2026-07-13, provider OpenCode Zen autenticado, model free)

Schema real confirmado (fixtures em `server/test/fixtures/opencode/`):
- Todo evento: `{ type, timestamp, sessionID: "ses_...", part: {...} }`. **Não há evento
  "init" dedicado** — o `sessionID` está em TODO evento; captura-se do 1º.
- `type:"step_start"` (part.type "step-start") — começo de step; ignorar no chat.
- `type:"text"` → `part.text` = texto do assistant (completo por evento, SEM streaming
  token-a-token — como o Codex).
- `type:"tool_use"` → `part` = `{ type:"tool", tool:<nome, ex "bash">, callID:"call_...",
  state:{ status, input:{...}, output:<str>, metadata:{ exit:<int>, ... } } }`. Mapa:
  assistant `tool_use{id:callID, name:tool, input:state.input}` + user `tool_result{
  tool_use_id:callID, content:state.output, is_error: state.metadata.exit !== 0}`.
- `type:"step_finish"` → **traz `tokens:{ total, input, output, reasoning, cache:{write,
  read} }`** (usage!). O turno termina quando o processo sai → o result é sintetizado no
  close (resultText = último `text`, tokens = do último step_finish).
- **Resume**: `run -s <sessionId>` mantém contexto e cwd (provado: rodou tool, criou
  arquivo). Effort via `--variant high|max|minimal`.
- `opencode export <id>` → `{ info:{ id, directory:<cwd>, model, tokens, cost, ... },
  messages:[...] }` — base do `readHistory` (parseia `messages`) e do
  `latestConversationId` (lista via `opencode session list` e casa `info.directory`).
- **Gotcha:** o model de geração de TÍTULO (`gpt-5.4-nano`) é pago e falha no free
  (`stream error`), mas é NÃO-FATAL. Passar `--title <prompt-truncado>` no 1º turno evita
  esse model.
- **Gotcha:** o snapshot via git usa `git add --sparse` (git antigo avisa "unknown option
  sparse", non-fatal).

**Ainda a confirmar na implementação (baixo risco):** injeção do hermes/MCP num run (via
config de projeto/global) — se difícil, o hermes do OpenCode fica como follow-up (a
engine funciona sem ele); e o formato exato de `export.messages` para o `readHistory`.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| `opencode` não instalado | turno falha ao spawnar → `dead`, `lastStderr` explica |
| Provider não autenticado | o turno falha (stderr do opencode) → `dead` com a mensagem |
| Turno morto por interrupt | sessão preservada; próximo `send`/revive retoma via `-s` |
| `run --json` sem session id | sessão sem id; result/dead conforme stderr |
| Item/evento desconhecido | `raw` (não quebra o chat) |
| MCP hermes indisponível | turno segue sem as tools (não derruba a sessão) |

## Testes

- `opencode-args`: buildRun/buildResume corretos (flags, model, variant, session, prompt
  posicional); sem model/variant não passam as flags.
- `opencode-parser`: cada mapeamento evento→AgentEvent (com fixtures reais do de-risk);
  createOpenCodeTurnParser preenche resultText/tokens; desconhecido→raw.
- `opencode-session` (com um **fake-opencode** em `server/test/fake-opencode.mjs`, análogo
  ao fake-codex): start não spawna; send roda o turno e emite init+assistant+result;
  sessionId capturado; 2º send usa `-s`; interrupt não mata a sessão; stop encerra.
- `opencode-engine`: conformidade com `Engine` (createSession/terminalCommand/
  capabilities/readHistory com fixture); models de `opencode models` cacheado.
- Integração (reuso): registrando o `openCodeEngine`, `manager.start(engine:'opencode')`
  cria a sessão; 1 Claude + 1 Codex + 1 OpenCode coexistem no mesmo projeto.
- Regressão: Claude e Codex intocados; suíte inteira verde. `web/` só ganha i18n de slash.
- Smoke real (usuário, provider autenticado): sessão OpenCode roda um turno; chat popula;
  resume no 2º turno; interrupt; Open in terminal; usage aparece.

## Fora de escopo (YAGNI)

- Streaming ao vivo de parciais (se o `run --json` streamar deltas, avaliar depois;
  senão, item-level como o Codex).
- Anexos nativos via `-f` (o caminho no texto já funciona; imagens nativas = follow-up,
  como no Codex).
- Provider/model management dentro do Claudinei (o usuário configura via `opencode auth`).
- Se o hermes/MCP for difícil de injetar num run, fica como follow-up.
