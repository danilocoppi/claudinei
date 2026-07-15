# Terminal sempre à mão + scroll no padrão do tema — Design

**Data:** 2026-07-12
**Status:** Aprovado (Leva B das 4 features de 2026-07-12; depende do interrupt da Leva A)

## Objetivo

1. **"Abrir no terminal" fixo à direita do título da sessão** — hoje só aparece quando
   `idle`/`needs_attention`; o usuário quer sempre à vista.
2. **Voltar da visão terminal direto para o chat da sessão**, revivendo a sessão web
   automaticamente (1 clique, não 2).
3. **Scrollbars no padrão Glass/Aurora** em todo o app (hoje são as nativas do browser).

## Contexto técnico (já existente)

- O handoff é um resume: o processo headless do chat morre e um `claude` TUI nasce num
  PTY com a mesma conversa (`--resume`). Voltar = fechar o TUI; a sessão web fica
  `stopped` e o Reviver (que já existe) a retoma com contexto.
- `ChatView` header: `canHandoff && <button ghost>` — vira botão permanente.
- `TerminalView` tem `encerrar()` → `closeTerminal` + `openDashboard()`.
- `ConfirmDialog` (Portal) já existe. `reviveSession(localId)` já existe na api web.
- Decisão do usuário: clicar durante `working` → **confirmar** "Interromper o turno e
  abrir no terminal?" e usar o interrupt da Leva A. Voltar → **chat da sessão**.

## Design

### Botão no título (`ChatView`)
- Sempre renderizado, ancorado à direita (`marginLeft: 'auto'`), rótulo
  `chat.openInTerminal` + ícone 🖥, classe `ghost` (padrão do header).
- Por status:
  - `idle` / `needs_attention` → abre direto (fluxo atual: `store.openTerminal`).
  - `working` → abre `ConfirmDialog` (title `chat.handoffTitle`, message
    `chat.handoffWorking`); confirmar → `ws.send({type:'interrupt', localId})`,
    aguardar o status sair de `working` (efeito observando o status com timeout de
    ~5s; o interrupt real leva ~0,1s) → `openTerminal`.
  - `starting` / `stopped` / `dead` / `in_terminal` → desabilitado com `title`
    explicativo (`chat.handoffUnavailable`).
- O POST `/terminal` (rota existente) faz o resto (mata headless, spawna PTY).

### Voltar ao chat (`TerminalView`)
- Botão atual `terminal.close` vira `terminal.backToChat` ("← Voltar ao chat"):
  1. `closeTerminal(localId)` (existente — encerra o PTY; sessão web fica `stopped`);
  2. `reviveSession(localId)` (existente — reabre o headless com a conversa);
  3. `store.openSession(localId)` (view chat).
  Falha no revive: ainda navega para o chat (lá existe o botão Reviver como fallback)
  e loga; o usuário nunca fica preso na visão terminal.

### Scrollbars (styles.css)
- Global: `* { scrollbar-width: thin; scrollbar-color: var(--glass-border) transparent }`
  (Firefox) + WebKit:
  ```css
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--glass-border); border-radius: 10px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--accent); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ```
- xterm: `.xterm-viewport` herda `::-webkit-scrollbar` global (mesmo documento);
  conferir no smoke visual — se o xterm impor cores próprias, sobrescrever com
  seletor `.terminal-view .xterm-viewport::-webkit-scrollbar-thumb`.

### i18n (3 línguas)
- `chat.handoffTitle` ("Abrir no terminal?"), `chat.handoffWorking` ("O turno em
  andamento será interrompido para abrir esta conversa no terminal."),
  `chat.handoffUnavailable` ("Disponível quando a sessão estiver ativa."),
  `terminal.backToChat` ("← Voltar ao chat"). `terminal.close` sai se ficar sem uso.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| Confirmou handoff mas o interrupt não mudou o status em 5s | cancela com aviso (não abre o terminal com turno vivo) |
| Voltar ao chat com revive falhando | navega mesmo assim; chat mostra Reviver |
| Sessão morre durante o ConfirmDialog aberto | confirmar vira no-op seguro (status já não é working → abre direto ou avisa) |
| Scroll horizontal (tabelas/código) | mesma estética (height 8px) |

## Testes

- ChatView: botão presente em todos os status; habilitado/desabilitado certo; working
  → dialog → confirmar → interrupt enviado → (status mock muda) → openTerminal chamado;
  timeout → não abre.
- TerminalView: voltar → closeTerminal + revive + openSession; revive falha → ainda
  navega.
- i18n paridade das chaves novas.
- Scroll: verificação visual no smoke (CSS puro; sem unit).

## Fora de escopo (YAGNI)

- Handoff sem matar o processo (impossível no protocolo atual).
- Espelhar o TUI em modo leitura durante o turno.
- Temas de scrollbar por área.
