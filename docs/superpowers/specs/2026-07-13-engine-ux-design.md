# SP-C — UX por engine (frontend) — Design

**Data:** 2026-07-13
**Status:** Aprovado (execução autônoma; decisões tomadas priorizando qualidade/extensibilidade)
**Contexto:** 3º e último sub-projeto. Depende de SP-A (abstração, mergeado) e SP-B
(adapter do Codex, mergeado). Torna a escolha de engine e a UX por-engine visíveis ao
usuário. Sequência: SP-A ✅ → SP-B ✅ → **SP-C (este)**.

## Objetivo

Ao iniciar um terminal, escolher a engine (Claude Code ou Codex); mostrar o ícone da
engine em operação; expor model/effort/permissão e o autocomplete de `/` **por engine**
(vindos das `capabilities` do backend, sem hardcode por tipo no frontend — adicionar uma
3ª engine no futuro não exige tocar no frontend). Manter STT, colar imagem e drop de
arquivo intactos. Com a trava `(projeto, engine)` do SP-A, um terminal pode ter 1 Claude
+ 1 Codex simultâneos — a UI passa a distinguir sessões por engine.

## Princípio: frontend dirigido por `capabilities` (extensível)

O frontend **não enumera** engines. Um endpoint `GET /api/engines` devolve, por engine
registrada, `{ id, label, icon, models, efforts, permissions, slashSource, slashCommands }`.
A UI monta o seletor de engine, os dropdowns de model/effort/permission e o autocomplete
de `/` a partir dessa lista. Uma engine nova aparece sozinha assim que registrada no backend.

## Backend (camada fina para viabilizar a UX)

### `Engine` ganha metadados de apresentação (SP-A interface)

`EngineCapabilities` (ou um campo irmão) ganha:
- `label: string` (Claude → "Claude Code"; Codex → "Codex").
- `icon: string` (emoji; Claude → "✳"; Codex → "◆" ou similar — decidir no frontend-design).
- `slashCommands: string[]` (para `slashSource: 'curated'`: a lista curada do Codex — ex.
  `['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo']`; para
  `'protocol'` fica `[]`, pois vem do evento init).

### `GET /api/engines` (`server/src/routes/engines.ts`, novo)

`listEngines().map((e) => ({ id, label, icon, ...e.capabilities() }))`. Admin-agnóstico
(qualquer autenticado pode ler — é só metadado de UI). Registrado no `app.ts`.

### `setEffort` na `EngineSession` (aplicar effort ao vivo, por engine)

Hoje o effort do Claude é aplicado por uma mensagem `/effort` que o **frontend** envia
(hack específico). Para o Codex isso não existe. Generaliza-se:
- `EngineSession.setEffort(effort: string): Promise<void>` entra na interface.
- `ClaudeSession.setEffort`: **no-op** (o Claude continua recebendo `/effort` como mensagem
  do frontend, comportamento inalterado — mantém a UX de hoje e não arrisca o Claude).
- `CodexSession.setEffort`: guarda `this.effort` para o próximo turno.
- `manager.setSessionOptions`: quando a sessão está viva e não-working, chama
  `session.setEffort(effort)` (além do que já faz com model/permission). A persistência no
  banco (para relaunch) continua.
- Validação de effort na rota `PATCH /options`: hoje `EFFORT_LEVELS` é uma allowlist fixa
  do Claude. Passa a validar contra a união dos efforts de **todas** as engines (ou aceita
  qualquer string e deixa a engine ignorar o inválido — mais simples e seguro; o
  `codex-args`/`ClaudeSession` já ignoram effort fora da própria allowlist).

## Frontend

### `web/src/api.ts` + `web/src/store.ts`

- `fetchEngines(): Promise<EngineMeta[]>` (`GET /api/engines`); `EngineMeta = { id, label,
  icon, models, efforts, permissions, slashSource, slashCommands }`.
- `startSession` ganha `engine?: string` no payload.
- Store: `engines: EngineMeta[]` (carregado no boot, após auth 'ready'); helper
  `engineOf(id)` e `engineFor(session)`.

### Seleção de engine ao iniciar (`StartSessionModal.tsx`)

No topo do modal, um seletor de engine (segmented control com ícone+label de cada engine
de `store.engines`; default `claude`). Ao trocar a engine, os dropdowns de **model**,
**effort** e **permission** re-populam a partir das `capabilities` daquela engine (Codex:
sem permission — esconde o seletor; efforts low/medium/high/xhigh; models gpt-5.6-*). O
`submit` envia `engine`. **Revive** (`ProjectCard`/`Sidebar`) continua sem seletor (usa a
engine persistida da sessão) — mas o botão de revive mostra o ícone da engine.

### Ícone da engine em operação

Badge com o `icon` da engine ao lado do status:
- **Sidebar** (`Sidebar.tsx` `term-card`): ícone da engine antes/junto do status-dot.
- **Chat header** (`ChatView.tsx`): ícone+label da engine da sessão aberta.
Com 1 Claude + 1 Codex no mesmo projeto, os dois cards aparecem (o `list()` do manager já
devolve as sessões vivas) e o ícone os distingue. Tooltip com o label.

### Model / effort / permission por engine (`SessionControls.tsx`)

O popover ⚙ deixa de usar as listas hardcoded (`MODELS`/`EFFORTS`/`MODES`) e passa a usar
`engineFor(session).{models,efforts,permissions}`. Se `permissions` vazio (Codex), a seção
de permissão não aparece. O effort:
- Claude (`slashSource: 'protocol'`... na verdade o effort não depende do slashSource):
  mantém o fluxo atual (mensagem `/effort` + PATCH) para não mudar o comportamento do Claude.
- Codex: PATCH `effort` (o backend aplica via `setEffort` no próximo turno) — **sem** enviar
  mensagem `/effort` (o Codex não tem esse slash). A decisão de "enviar /effort ou não" vem
  de `slashSource`/da engine: só engines `protocol` que expõem `/effort` recebem a mensagem;
  as demais só PATCH. Regra concreta: enviar a mensagem `/effort` **apenas para `claude`**
  não é aceitável (hardcode) — em vez disso, a `EngineMeta` ganha um flag derivável: enviar
  `/effort` como mensagem sse `slashCommands`/`init` da sessão contiver `effort` (Claude
  tem; Codex não). Simplificação: o front envia a mensagem `/effort` só se o comando
  `effort` estiver na lista de slash da sessão (protocolo do Claude traz; curada do Codex
  não) — e SEMPRE faz o PATCH. Assim nada é hardcoded por engine.

### Autocomplete de `/` por engine (`slash.ts` / `ChatInput.tsx` / `SlashMenu.tsx`)

A fonte da lista passa a depender da sessão:
- `slashSource: 'protocol'` (Claude): usa `store.slashCommands` (do init), como hoje.
- `slashSource: 'curated'` (Codex): usa `engineFor(session).slashCommands`.
- `slashSource: 'none'`: sem autocomplete.
`SLASH_DESCRIPTIONS` (descrições i18n) ganha entradas para os comandos curados do Codex; os
sem descrição aparecem sem legenda (degrada bem). O `ChatInput` escolhe a lista pela engine
da sessão ativa.

### STT / colar imagem / drop de arquivo

**Inalterados** — já são agnósticos de engine (operam sobre texto/anexos). Verificar que
seguem funcionando num terminal Codex (teste manual no smoke).

### Labels "Claude" na UI

As 3 strings i18n que citam "Claude Code"/"Claude" (placeholder do input, descrições)
passam a usar o `label` da engine da sessão quando fizer sentido (ex.: placeholder
"Message for {{engine}}…"). "Claudinei" (produto) não muda.

### Rename `claudeSessionId` → `engineSessionId`

**Fora de escopo (mantém estável).** O campo no fio/store/tipos continua `claudeSessionId`,
tratado como "id de conversa da engine" (o Codex também o usa: é o thread_id). Renomear é
churn cosmético de risco sem ganho funcional; documentar o significado genérico num
comentário. (Decisão de qualidade: não arriscar um rename cross-cutting no fim do projeto.)

## Testes

- Backend: `GET /api/engines` devolve claude+codex com label/icon/capabilities; `setEffort`
  no CodexSession afeta o próximo turno (via fake); Claude `setEffort` é no-op; validação de
  effort na rota aceita efforts do Codex. Suíte do Claude inalterada.
- Frontend (vitest + testing-library): StartSessionModal mostra o seletor de engine e
  re-popula model/effort/permission ao trocar; envia `engine` no submit; badge de engine
  renderiza o ícone certo; SessionControls usa as listas da engine da sessão (Codex sem
  permission); autocomplete usa a lista curada para Codex e a do protocolo para Claude;
  `fetchEngines` no boot.
- **Design (frontend-design MCP):** o seletor de engine, os badges e o popover por-engine
  passam pelo processo de design (screenshots/crítica) — coeso com o tema Glass/Aurora.
- Smoke real (autônomo): app no ar, criar terminal Codex, ver o ícone, mandar mensagem,
  usar STT/anexo, ver o `/` curado; 1 Claude + 1 Codex no mesmo projeto lado a lado.

## Fora de escopo (YAGNI)

- Rename `claudeSessionId` (acima).
- Streaming ao vivo de parciais do Codex (item.started/updated) — SP-B já decidiu só
  item.completed.
- Imagens nativas do Codex via `-i` (anexo por texto já funciona).
- Troca de engine "in-place" numa sessão viva — não existe: cada sessão tem engine fixa;
  para a outra engine, inicia-se outra sessão (coexistem pela trava projeto×engine). Isso
  substitui, com vantagem, o "parar antes de trocar" do pedido original.
