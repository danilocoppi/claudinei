# SP-A — Abstração de engine (backend) — Design

**Data:** 2026-07-13
**Status:** Aprovado
**Contexto:** Primeiro de 3 sub-projetos para suportar o Codex (OpenAI) como engine
alternativa ao Claude Code, selecionável por terminal. Sequência: **SP-A (este,
abstração)** → SP-B (adapter do Codex) → SP-C (UX por engine no frontend).

## Objetivo

Refatorar o backend para que a lógica hoje grudada no Claude Code viva atrás de
uma **interface de engine plugável**, sem mudar nenhum comportamento observável.
Ao final, adicionar uma nova engine (Codex, e qualquer 3ª/4ª futura) é **implementar
a interface + registrar** — zero mudança em manager, rotas, parser, DB ou frontend.

## Princípio dominante: registry aberto

- O identificador de engine é um **`string` validado pelo registry**, nunca um union
  fechado. Nenhum arquivo enumera `'claude' | 'codex'`.
- Adicionar engine = novo arquivo que implementa `Engine` + `registerEngine(impl)`.
- Toda resolução de engine passa por `getEngine(id)` — **proibido** `switch (engine)`
  espalhado pelo código.
- `Engine.capabilities()` descreve models/efforts/permissions/slash de cada engine,
  para o frontend (SP-C) renderizar qualquer engine sem hardcode por tipo.

## Modelo de concorrência: uma sessão viva por (projeto, engine)

Decisão de produto: um terminal pode hospedar **no máximo uma sessão viva por
engine** — permite 1 Claude + 1 Codex simultâneos no mesmo diretório, mas não duas
sessões da mesma engine. A trava do manager, hoje "uma sessão ativa por projeto"
(`manager.ts:149-151`), passa a ser escopada por **(projeto, engine)**.

Como no SP-A só o `claude` está registrado, `(projeto, claude)` é equivalente a
`(projeto)` — **comportamento idêntico ao de hoje**, o refactor continua sem mudança
observável. Mas a trava já nasce engine-aware, então quando o Codex existir (SP-B) a
concorrência 1 Claude + 1 Codex funciona sem re-tocar o manager. O risco de dois
agentes escrevendo no mesmo diretório é assumido conscientemente e fica limitado a um
por engine.

## Escopo

**Dentro (SP-A):**
- Interfaces `Engine`/`EngineSession`/`AgentEvent`/`EngineCapabilities` + registry.
- Mover o específico do Claude para uma implementação `claudeEngine` por trás da
  interface (parser stream-json, `control_request`, `buildClaudeArgs`, `history.ts`,
  injeção `--mcp-config`, args do PTY do terminal — todos encapsulados).
- Coluna `engine` em `sessions` (default `'claude'`) + campo `engine` em
  `SessionOptions`/`SessionInfo`, propagado por start/revive/persist/list (sempre
  `'claude'` por ora).
- Manager e terminal-manager resolvem tudo via `getEngine(id)`.

**Fora (SP-A) — decisões já tomadas no brainstorm:**
- Nomes de API/WS ficam **estáveis**: o rename `claudeSessionId` → `engineSessionId`
  no fio e no frontend fica para o SP-C. SP-A é 100% backend, não toca em React.
- Expor `capabilities()` num endpoint HTTP é SP-C. Aqui a interface existe e o
  `claudeEngine` a preenche com as listas de hoje.
- Nenhuma engine nova é implementada aqui (só a abstração + Claude por trás dela).

## Componentes

### `server/src/engine/types.ts` (novo)

```ts
export type EngineId = string  // aberto; validade = "está registrado?"

// AgentEvent = o ClaudeEvent de hoje, renomeado (shape idêntico). ClaudeEvent
// permanece como alias deprecado para não quebrar imports internos durante a migração.
export type AgentEvent = /* união atual de events.ts */ ...

export type SessionStatus = /* o de hoje, inalterado */ ...

export interface EngineSessionCallbacks {
  onEvent(e: AgentEvent): void
  onStatus(s: SessionStatus): void
  onSessionId(id: string): void          // id da conversa devolvido pela engine (Claude: init.session_id)
  onSlashCommands?(cmds: string[]): void // engines que expõem slash no protocolo
}

export interface EngineSessionOptions {
  projectPath: string
  resumeSessionId?: string
  continueLatest?: boolean
  model?: string
  effort?: string
  permissionMode?: string   // vocabulário livre por engine; Claude usa PermissionMode
  hermes?: HermesOptions    // já existe
  // escape hatch de teste (fake-claude): mantém os testes atuais funcionando
  binOverride?: string
  extraArgsOverride?: string[]
}

// Um por sessão viva. É a interface extraída do ClaudeSession de hoje.
export interface EngineSession {
  start(): void
  send(text: string): void
  interrupt(): Promise<void>
  setOptions(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void>
  stop(): Promise<void>
}

export interface EngineCapabilities {
  models: string[]            // ['', 'fable', 'opus', 'sonnet', 'haiku'] p/ Claude
  efforts: string[]           // ['auto','low',...,'ultracode'] p/ Claude
  permissions: string[]       // PermissionMode[] p/ Claude
  slashSource: 'protocol' | 'curated' | 'none'  // Claude='protocol' (vem no init)
}

// Um por TIPO de engine (registrado uma vez).
export interface Engine {
  id: EngineId
  createSession(opts: EngineSessionOptions, cb: EngineSessionCallbacks): EngineSession
  readHistory(projectPath: string, engineSessionId: string): AgentEvent[]
  latestConversationId(projectPath: string): string | null
  terminalCommand(opts: { resumeSessionId: string; projectPath: string }): { file: string; args: string[] }
  capabilities(): EngineCapabilities
}
```

### `server/src/engine/registry.ts` (novo)

```ts
const engines = new Map<EngineId, Engine>()
export function registerEngine(e: Engine): void   // lança se id duplicado
export function getEngine(id: EngineId): Engine    // lança 'unknown_engine' se ausente
export function hasEngine(id: EngineId): boolean
export function listEngines(): Engine[]
export const DEFAULT_ENGINE_ID = 'claude'
```

Um módulo de bootstrap (`server/src/engine/index.ts`) registra o `claudeEngine` no
load. Adicionar Codex no SP-B = mais uma linha `registerEngine(codexEngine)`.

### `server/src/engine/claude-engine.ts` (novo — implementa `Engine` para o Claude)

Adapter fino que **delega ao código Claude existente**, sem reescrevê-lo:
- `createSession` → `new ClaudeSession(...)` (que já expõe start/send/interrupt/
  setModel/setPermissionMode/stop e callbacks — só é declarado como `implements
  EngineSession`, com `setOptions` cobrindo model/permission/effort).
- `readHistory` / `latestConversationId` → funções de `server/src/history.ts`.
- `terminalCommand` → devolve `{ file: claudeBin, args: ['--resume', id,
  '--dangerously-skip-permissions'] }` (o que hoje está inline em `terminal/manager.ts`).
- `capabilities` → as listas de models/efforts/permissions de hoje.

O `server/src/claude/*` (session, parser, events, control) permanece, mas passa a ser
**detalhe de implementação do claudeEngine** — o manager não importa mais `claude/*`
direto.

### Mudanças em arquivos existentes

- **`server/src/db.ts`**: `ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL
  DEFAULT 'claude'` (idempotente, mesmo padrão dos ALTERs existentes).
- **`server/src/claude/manager.ts`**: `entry.engine: EngineId` (da linha do banco,
  default `'claude'`); criar sessão via `getEngine(entry.engine).createSession(...)`
  em vez de `new ClaudeSession`. Persistir/ler `engine`. `SessionInfo` ganha `engine`.
  A trava de `start()`/`revive()` passa a ser escopada por **(projeto, engine)** — só
  rejeita se já existe sessão viva **da mesma engine** no projeto (idem a guarda de
  `in_terminal`, que também vira por-engine). Com só o `claude` registrado, é
  comportamento idêntico ao de hoje. O dep de teste `sessionFactory?` continua
  existindo como override do `createSession` do engine `'claude'` (mantém os testes
  com fake-claude sem alteração).
- **`server/src/terminal/manager.ts`** e a rota **`GET /history`**: o *rewiring* dos
  call-sites para passarem por `getEngine(engine).terminalCommand(...)` /
  `.readHistory(...)` fica para o **SP-B** (é comportamentalmente neutro com só o
  Claude e evita mexer nos testes de terminal/history agora). No SP-A a engine já
  **define e testa** `terminalCommand`/`readHistory`/`latestConversationId` — a
  interface fica travada; os call-sites continuam chamando `terminal/manager.ts` e
  `history.ts` diretamente, sem mudança.
- **`server/src/routes/sessions.ts`**: `POST /sessions` e `/revive` aceitam `engine?`
  opcional; validam com `hasEngine(id)` (400 `unknown_engine` se não registrado —
  hoje só `'claude'` passa); default `DEFAULT_ENGINE_ID`. `SessionInfo` serializado
  ganha `engine`.
- **`server/src/index.ts`**: importa `server/src/engine/index.ts` (bootstrap do
  registry) antes de subir o manager.

## Fluxo de dados (inalterado do ponto de vista do usuário)

```
start/revive(engine='claude')
  → manager: getEngine('claude').createSession(opts, callbacks)
  → claudeEngine → new ClaudeSession (código de hoje)
  → eventos stream-json → AgentEvent (mesmo shape) → broadcast WS (mesmos nomes de campo)
  → persist(engine, engineSessionId=claude_session_id, model, permission, effort, status)
```

Nenhum byte muda no que o frontend recebe: os eventos e os campos WS
(`claudeSessionId` etc.) permanecem idênticos.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| `engine` não registrado em start/revive | 400 `unknown_engine` |
| Projeto já tem sessão viva da MESMA engine | 409 (trava por projeto+engine) |
| Projeto tem sessão viva de OUTRA engine | permitido (1 por engine) |
| `registerEngine` com id duplicado | lança no boot (erro de programação) |
| Linha de sessão legada sem coluna `engine` | default `'claude'` (migração) |
| `sessionFactory` de teste presente | usado no lugar do createSession do engine claude |
| Reidratar sessão do banco no boot | lê `engine` da linha; resolve via registry |

## Testes

- **`registry`**: register/get/has/list; id duplicado lança; id desconhecido lança.
- **`claude-engine` (conformidade)**: `createSession` devolve objeto com
  start/send/interrupt/setOptions/stop; `terminalCommand` = `claude --resume <id>
  --dangerously-skip-permissions`; `capabilities` traz as listas esperadas;
  `readHistory`/`latestConversationId` delegam a history.ts (com transcript fixture).
- **Trava por (projeto, engine)**: registrando um 2º engine fake no registry, o
  manager permite uma sessão viva de CADA engine no mesmo projeto, mas rejeita uma 2ª
  sessão da MESMA engine (valida o future-proofing sem depender do Codex real).
- **Regressão (a barra real):** toda a suíte atual permanece **verde e inalterada**
  (session, manager, history, terminal, hermes, ws, rbac, auth…). Nenhum teste de
  comportamento existente é modificado — se algum precisar mudar, é sinal de que o
  refactor vazou comportamento. Meta: server 338 passed | 1 skipped, `tsc` limpo.

## Fora de escopo (YAGNI)

- Implementar qualquer engine além do Claude (é SP-B).
- Endpoint HTTP de capabilities e qualquer mudança no frontend (é SP-C).
- Rename `claudeSessionId` → `engineSessionId` no fio/React (é SP-C).
- Normalização de eventos de um formato não-Claude (o `AgentEvent` já é o shape
  do Claude; a normalização do Codex para esse shape é SP-B).
- Rewiring dos call-sites de `terminal/manager.ts` e da rota `GET /history` para
  passarem pela engine (as capabilities existem e são testadas no SP-A; o rewiring
  é SP-B, quando o Codex força esses caminhos a divergir).
