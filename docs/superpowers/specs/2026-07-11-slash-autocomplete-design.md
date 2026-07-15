# Autocomplete de slash commands no chat — Design

**Data:** 2026-07-11
**Status:** Aprovado (brainstorming) → pronto para plano de implementação

## Objetivo

Ao digitar `/` no início da mensagem do chat, mostrar um dropdown com os slash
commands disponíveis (lista real do Claude Code), filtrável e navegável por
teclado. Selecionar **preenche** o comando no campo; o usuário confirma com
Enter. Resolve a confusão do `/exit` (que é TUI-only) e dá descoberta dos
comandos úteis no chat.

## Fatos empíricos (claude 2.1.207)

- O evento `init` (system/init) carrega `slash_commands: string[]` no seu
  objeto cru (77 comandos: built-ins + plugin/skill como `superpowers:*`,
  `figma:*`). Só nomes, sem descrição.
- O headless **executa** os comandos enviados como texto: `/compact` e `/cost`
  funcionam; `/exit` e `/help` respondem "isn't available in this
  environment". Sempre emite `result` — nunca trava.
- O `init` só chega com a 1ª mensagem da sessão (protocolo).

## Decisões do usuário

1. **Conteúdo dos tips:** lista real dos nomes + **descrição curta para os
   built-ins comuns**; plugin/skill só nome.
2. **Envio:** selecionar **preenche** o campo; usuário confirma com Enter
   ("preencher e confirmar").

## Componentes

### Backend

- **`server/src/claude/parser.ts` / `events.ts`:** o evento `init` passa a
  expor `slashCommands: string[]` (lido de `raw.slash_commands ?? []`). Tipo
  `{ kind: 'init'; sessionId; model; slashCommands: string[]; raw }`.
- Nada mais muda no backend: o evento `init` já é broadcastado ao front como
  `session_event`.

### Frontend

- **`web/src/slash.ts` (novo):**
  - `BUILTIN_FALLBACK: string[]` — lista estática de built-ins comuns, usada
    antes do 1º `init` chegar.
  - `SLASH_DESCRIPTIONS: Record<string, string>` — mapa nome→chave i18n
    (`slash.*`) para os built-ins com descrição (`/compact`, `/cost`,
    `/context`, `/clear`, `/config`, `/model`, `/usage`, `/status`,
    `/mcp`, `/agents`). Comandos ausentes do mapa → sem descrição.
  - `HIDDEN: Set<string>` — comandos TUI-only escondidos (`exit`, `help`).
  - `filterCommands(all: string[], query: string): string[]` — filtra por
    substring (case-insensitive) no nome, exclui HIDDEN, ordena: built-ins com
    descrição primeiro, depois alfabético.
- **`web/src/store.ts`:** campo global `slashCommands: string[]` (default
  `BUILTIN_FALLBACK`). No handler de `session_event`, quando `event.kind ===
  'init'` e `event.slashCommands?.length`, atualiza `slashCommands`.
- **`web/src/components/SlashMenu.tsx` (novo):** dropdown posicionado **acima**
  do textarea (dentro do container do ChatInput, `position: absolute; bottom:
  100%`). Recebe `items: string[]`, `activeIndex`, `onPick(cmd)`. Cada linha:
  nome + descrição (se houver, dim). Item ativo destacado.
- **`web/src/components/ChatInput.tsx`:** integra o menu.
  - Estado: `menuOpen`, `activeIndex`.
  - Deriva `showSlash = /^\/\S*$/.test(text)` (texto é só uma `/palavra`, sem
    espaço) e `matches = filterCommands(store.slashCommands, text.slice(1))`.
    Menu aparece quando `showSlash && matches.length > 0`.
  - **Teclado no textarea** (`onKeyDown`), quando o menu está aberto:
    - `ArrowDown`/`ArrowUp`: move `activeIndex` (com wrap), previne default.
    - `Enter` ou `Tab`: seleciona o item ativo (preenche), previne default e
      **não envia**.
    - `Escape`: fecha o menu.
    - Enter com menu **fechado**: envia (comportamento atual).
  - **Selecionar (`pick`):** `setText('/' + cmd + ' ')`, fecha o menu, mantém
    o foco no textarea.
  - Clique num item também chama `pick`.

## Fluxo

```
digita "/co"
  → showSlash=true, matches=[compact, cost, config, context, ...]
  → dropdown acima do input; ↓↑ navega
seleciona /compact (Enter/Tab/clique)
  → campo = "/compact " (foco mantido), menu fecha
Enter (menu fechado) → envia "/compact" ao headless → Claude executa
```

## Tratamento de erros / bordas

| Situação | Comportamento |
|---|---|
| `init` ainda não chegou | usa `BUILTIN_FALLBACK` |
| filtro não casa nada | menu não aparece (texto `/algo` segue normal) |
| usuário digita espaço após o comando | `showSlash` vira false → menu fecha |
| `/exit`, `/help` | escondidos (HIDDEN) — não aparecem |
| comando sem descrição (plugin/skill) | listado só com o nome |
| clique fora / Esc | fecha o menu |

## Testes

- **Parser:** `init` com `slash_commands` no raw → evento tem
  `slashCommands`.
- **`slash.ts`:** `filterCommands` filtra por substring, exclui HIDDEN,
  built-ins com descrição vêm antes.
- **Store:** evento `init` popula `slashCommands`; antes disso é o fallback.
- **ChatInput:** digitar `/co` abre o menu com matches; `ArrowDown`+`Enter`
  preenche o campo com `/compact ` e **não** dispara `send`; `Enter` com menu
  fechado envia; `Esc` fecha; `/exit` não aparece; built-in mostra descrição,
  plugin mostra só nome.

## i18n

Chaves `slash.compact`, `slash.cost`, `slash.context`, `slash.clear`,
`slash.config`, `slash.model`, `slash.usage`, `slash.status`, `slash.mcp`,
`slash.agents` (descrições curtas) nas 3 línguas (`en`/`es`/`pt-BR`,
`: typeof en`).

## Fora de escopo (YAGNI)

- Rotear comandos TUI-only para o terminal embutido (headless já responde a
  todos; os TUI-only ficam escondidos).
- Autocomplete de argumentos dos comandos.
- Descrições dinâmicas (o init não as fornece; hardcoded para os comuns).
- Autocomplete de @ (arquivos) ou outras sintaxes.
