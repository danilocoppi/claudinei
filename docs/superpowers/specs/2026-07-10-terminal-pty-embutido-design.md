# Terminal PTY embutido no Claudinei — Design

**Data:** 2026-07-10
**Status:** Aprovado (brainstorming) → pronto para plano de implementação

## Objetivo

Rodar o **Claude Code interativo (a TUI real)** dentro de um pseudo-terminal
(`node-pty`) no backend e espelhá-lo via `xterm.js` numa aba do navegador, com
as **permissões interativas funcionando** (o `claude` pergunta, o operador
responde y/n direto no terminal embutido). Substitui o handoff atual, que abre
o `claude --resume` numa janela separada do `gnome-terminal`.

Isso completa o modelo **híbrido** do Claudinei:

- **Fluxo normal:** headless (`claude -p --input-format stream-json`) → UI
  bonita de blocos markdown. Não pede permissão (auto-nega — ver D18).
- **Fluxo interativo:** quando o operador precisa de uma sessão interativa
  real (aprovar permissões, usar a TUI), ele "abre no terminal" e cai num
  `xterm.js` embutido, sem sair do navegador e sem alt-tab.

## Contexto e motivação

O modo headless não emite prompt de permissão — ele auto-nega a ação (D18). A
única forma de aprovação interativa com o binário do Claude Code (sem migrar
para o Agent SDK) é rodar a TUI num terminal real. Hoje isso já existe como
"handoff" (feature 2a): o backend abre o `gnome-terminal` rodando
`claude --resume`. O terminal embutido é a evolução: mesmo efeito, mas dentro
do navegador, mais portável (remove a amarra ao `gnome-terminal`/Linux) e
melhor UX (sem trocar de janela).

## Decisões tomadas no brainstorming

1. **Substituir o `gnome-terminal`.** O "abrir no terminal" passa a abrir
   sempre o terminal embutido. O `defaultLauncher`/gnome sai de cena.
2. **Persistir e reconectar.** O `claude` interativo vive no servidor,
   independente da conexão WS. Sair da aba só desconecta o "vidro"; ao voltar,
   o terminal é reconstruído a partir de um buffer de scrollback. Encerrar de
   verdade exige o botão explícito **"Encerrar terminal"**.
3. **Vários terminais simultâneos, um por sessão.** Cada sessão pode ter seu
   PTY vivo ao mesmo tempo; o operador alterna pela lista de sessões (igual ao
   chat). O backend mantém um registro de PTYs por `localId`.
4. **Multiplataforma como alvo de primeira classe.** Sem caminhos hardcoded;
   resolução do binário `claude` por plataforma; `xterm-256color` + bytes
   crus. Testar e garantir no Linux; deixar o caminho aberto e documentado
   para Windows/macOS.
5. **Abordagem A (WS binário dedicado + `TerminalManager`).** Canal binário
   cru separado do hub JSON `/ws`. Melhor throughput/latência e separação
   limpa de responsabilidades.
6. **Encerrar → `stopped`** (sem auto-revive). O operador revive quando quiser
   para voltar ao chat headless com o histórico (fluxo D4 já pronto).
7. **Segurança enxuta** (app local): bind em `127.0.0.1`, verificação de
   `Origin` no upgrade do WS, token efêmero por terminal, `spawn` sem shell +
   id validado. Sem senha para abrir terminal.

## Restrições globais (Global Constraints)

- **Sem caminhos hardcoded.** O binário `claude` é resolvido por plataforma
  (respeitando `CLAUDINEI_CLAUDE_BIN`/config existente; no Windows os bins
  globais do npm são shims `.cmd`).
- **Terminal:** `name: 'xterm-256color'`, bytes crus (o ConPTY cuida do resto
  no Windows).
- **Buffer de scrollback limitado a ~256 KB** por PTY (ring-buffer) — não
  cresce sem fim.
- **`spawn` sem shell** (argv array). O `claudeSessionId` passa pela regex
  `^[A-Za-z0-9][A-Za-z0-9_-]*$` antes de virar argumento.
- **Bind `127.0.0.1`.** O `/ws/terminal/:localId` valida `Origin` (mesma
  origem) e exige `?token=…` que confira com o `PtyEntry`.
- **ESM + TypeScript strict**, imports com `.js`, no padrão do repo. Testes com
  o runner atual (`node --test`/vitest conforme o server/web) e binário
  `fake-claude` injetável para os testes de integração.

## Arquitetura

```
  NAVEGADOR                              BACKEND (Fastify, 127.0.0.1)
 ┌──────────────────────┐   REST        ┌───────────────────────────────────┐
 │ TerminalView (xterm) │──POST/DELETE─►│ routes/terminal.ts                 │
 │  - xterm.js + fit    │               │   └─► TerminalManager              │
 │  - WS binário        │◄──bytes──────►│         ├─ Map<localId, PtyEntry>  │
 └──────────────────────┘   /ws/terminal│         │   ├─ node-pty proc       │
          ▲                              │         │   ├─ ring-buffer (256KB) │
          │ store.view='terminal'        │         │   ├─ token efêmero       │
          │ activeLocalId                │         │   └─ Set<socket>         │
 (mesma lista de sessões da sidebar)     │         └─ usa SessionManager p/   │
                                         │            parar headless / estado│
                                         └───────────────────────────────────┘
```

### Componentes novos

- **`server/src/terminal/manager.ts` — `TerminalManager`**: dono dos processos
  `node-pty`, indexados por `localId`. API:
  - `open(localId, opts)` — spawn de `claude --resume <id>` (+
    `--dangerously-skip-permissions` se `skip_permissions`), cria o `PtyEntry`,
    retorna o token.
  - `attach(localId, socket, token)` — valida token, adiciona o socket ao
    `Set`, replaya o ring-buffer, liga os dois sentidos.
  - `write(localId, data)` — encaminha teclas para `pty.write`.
  - `resize(localId, cols, rows)` — `pty.resize`.
  - `close(localId)` — mata o PTY, limpa o entry, dispara `onExit`.
  - Injeta um `ptyFactory` para testes (fake-pty), no padrão do
    `sessionFactory` atual.
  - `PtyEntry`: `{ proc, buffer (ring ~256KB), token, clients: Set<socket>,
    projectId }`.

- **`server/src/routes/terminal.ts`**:
  - `POST /api/sessions/:localId/terminal` — orquestra o `SessionManager` (para
    o headless, seta `in_terminal`), chama `TerminalManager.open`, devolve
    `{ token, wsUrl: '/ws/terminal/:localId' }`. Idempotente se já
    `in_terminal` (reusa o PTY vivo, devolve token novo).
  - `DELETE /api/sessions/:localId/terminal` — `TerminalManager.close`;
    `SessionManager` volta a sessão para `stopped`.
  - `GET /ws/terminal/:localId` — upgrade do WS binário; valida `Origin` +
    token; chama `attach`.

- **`web/src/components/TerminalView.tsx`**: monta `xterm.js` + addon `fit`,
  abre o WS binário, escreve bytes recebidos no terminal, envia teclas e resize
  de volta. Botão **"Encerrar terminal"** (`DELETE`). Trata reconexão (reabre
  WS; se token expirou, refaz o `POST`).

### Componentes reaproveitados/alterados

- **`server/src/claude/manager.ts` (`openInTerminal`)**: a lógica de parar o
  headless, validar o `claude_session_id`, setar `in_terminal` e o
  `onExit → stopped` já existe. Extrair o passo de lançamento para que o
  `TerminalManager` seja o novo "launcher". Remover o `defaultLauncher`/gnome e
  a dep `terminalBin` (ou mantê-la morta e marcá-la deprecada — decidir no
  plano; preferência: remover para não carregar código morto).
- **`server/src/index.ts` / `app.ts`**: instanciar o `TerminalManager` e
  registrar as rotas de terminal.
- **`web/src/store.ts` / `App.tsx`**: nova `view: 'terminal'` e ação
  `openTerminal(localId)`, no mesmo padrão de `openSession`. A sidebar leva ao
  terminal quando a sessão está `in_terminal`.

### Dependências novas

- **Backend:** `node-pty` (nativo, multiplataforma; publica binários
  pré-compilados — o `npm install` normalmente não compila).
- **Front:** `@xterm/xterm` + `@xterm/addon-fit`.

## Fluxo de dados e ciclo de vida

### Abrir (handoff web → terminal)

1. Front: `POST /api/sessions/:localId/terminal`.
2. Backend: `SessionManager` para o headless e seta `in_terminal`;
   `TerminalManager.open` faz spawn de `claude --resume <id>` no `node-pty`,
   cria `PtyEntry` (buffer + token).
3. Resposta `{ token, wsUrl }`. Front navega para `view: 'terminal'` e abre o
   WS.

### Anexar / reconectar

4. O WS conecta com `?token=…`. Backend valida token + `Origin`, adiciona o
   socket ao `Set`, **replaya o ring-buffer** — o xterm reconstrói a tela.
5. Full-duplex: bytes do PTY → todos os sockets do `Set`; teclas de qualquer
   socket → `pty.write`. (Vários sockets no mesmo terminal = espelhamento.)
6. Sair da view/fechar a aba só remove o socket do `Set`; **o PTY continua
   vivo**. Reabrir refaz o passo 4.

### Resize

O xterm mede as dimensões e envia um frame de controle JSON reservado (distinto
dos bytes crus) `{ type: 'resize', cols, rows }` no mesmo WS; o backend chama
`pty.resize`. Sem isso a TUI do Claude quebra o layout.

### Encerrar (terminal → volta ao modo web)

7. Botão "Encerrar terminal" → `DELETE /api/sessions/:localId/terminal`. O
   `TerminalManager` mata o PTY; o `SessionManager` volta a sessão para
   `stopped` e transmite `session_status`. O operador dá "reviver" para voltar
   ao chat headless com o histórico (D4).

### Saída inesperada do claude

Se o PTY morre sozinho (`/exit`, crash), o `TerminalManager` detecta o `exit`,
avisa os sockets (linha "— sessão encerrada —") e volta o estado para
`stopped`.

## Tratamento de erros

| Situação | Comportamento |
|---|---|
| Abrir terminal de sessão sem `claude_session_id` | `POST` → 400 "sessão ainda não tem conversa para abrir" |
| Abrir terminal de sessão já `in_terminal` | Idempotente: reusa o `PtyEntry` vivo, devolve token novo |
| `node-pty` falha no spawn (binário `claude` ausente) | 500 com mensagem clara; sessão volta para `stopped` (não fica presa em `in_terminal`) |
| WS com token inválido/ausente ou `Origin` errado | Recusa o upgrade (fecha o socket), sem tocar no PTY |
| PTY morre sozinho | Sockets recebem "— sessão encerrada —"; estado → `stopped` |
| Reconexão do WS (rede/reload) | Front reabre o WS e o buffer é replayado; se o token expirou, refaz o `POST` |
| Backend reinicia com PTYs vivos | Os `node-pty` morrem junto; no boot, a normalização `in_terminal → stopped` existente limpa as rows órfãs |

## Segurança

1. **Bind em `127.0.0.1`** — o PTY não é alcançável pela rede.
2. **Verificação de `Origin`** no upgrade do `/ws/terminal/:localId` (mesma
   origem) — bloqueia CSWSH.
3. **Token efêmero por terminal** — cunhado no `POST`, guardado no `PtyEntry`,
   exigido no WS (`?token=…`), rotacionado a cada `open`, some ao encerrar.
4. **Sem shell no `spawn` + id validado** — `claude` como argv; `sessionId`
   pela regex antes de virar argumento.

**Limite assumido e explícito:** o PTY roda com as permissões do usuário —
intencional (é o Claude Code real na máquina). A proteção é de *acesso ao
canal* (só o Claudinei local, com token), não um sandbox do que o Claude pode
fazer.

## Testes

- **`TerminalManager` (unit, fake-pty injetado):** `open` cria entry + buffer;
  `attach` valida token e replaya buffer; `write`/`resize` chegam ao pty;
  `close` mata e limpa; token inválido rejeitado; PTY que emite `exit` volta a
  sessão para `stopped`.
- **Rotas (`terminal.ts`):** `POST` abre e devolve `{token,wsUrl}`; `POST` em
  sessão sem conversa → 400; `DELETE` encerra; upgrade do WS rejeita
  `Origin`/token inválidos.
- **Integração backend:** com o binário `fake-claude`, abrir → escrever "oi" →
  ver o eco no buffer → encerrar → estado `stopped`.
- **Front:** teste do `store` para `view: 'terminal'`/`openTerminal`. O
  `xterm.js` (render em canvas) fica coberto por smoke manual no navegador, não
  por unit.

## Fora de escopo (YAGNI)

- Iniciar uma sessão nova diretamente em modo terminal (o entry point é o
  handoff de uma sessão existente com `claude_session_id`).
- Auto-revive ao encerrar (decidido: encerra → `stopped`).
- Senha/segredo para abrir terminal (app local).
- Validação automatizada em Windows/macOS neste ciclo (design é portável; teste
  garantido no Linux).
