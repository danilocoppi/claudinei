# Autocomplete de slash commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao digitar `/` no chat, um dropdown acima do input lista os slash commands reais (do init), filtrável e navegável por teclado; selecionar preenche o campo e o usuário confirma com Enter.

**Architecture:** O parser do `init` passa a expor `slashCommands` (do raw). O front captura essa lista no store (com fallback estático de built-ins), e o `ChatInput` mostra um `SlashMenu` quando o texto é `/palavra`. Descrições curtas (i18n) só para built-ins comuns.

**Tech Stack:** Node parser + vitest; React 18 + react-i18next.

## Global Constraints

- Nomes dos comandos vêm SEM barra (o init dá `["compact","cost",...]`).
- Menu aparece só quando o texto casa `^/\S*$` (uma `/palavra`, sem espaço) e há matches.
- Selecionar PREENCHE `/comando ` (com espaço) e mantém o foco — não envia. Enter com o menu ABERTO seleciona; Enter com o menu FECHADO envia.
- `HIDDEN = {exit, help}` (TUI-only) nunca aparecem.
- Built-ins com descrição vêm antes na ordenação; o resto, alfabético.
- i18n: chaves `slash.*` nas 3 línguas (`en`/`es`/`pt-BR`, `: typeof en`).
- ESM + TS strict, imports `.js` no server.

---

### Task 1: Parser expõe slashCommands no evento init

**Files:**
- Modify: `server/src/claude/parser.ts` (linha do init), `server/src/claude/events.ts` (tipo do init)
- Test: `server/test/parser.test.ts`

**Interfaces:**
- Produces: `ClaudeEvent` init = `{ kind: 'init'; sessionId: string; model: string; slashCommands: string[]; raw: unknown }`

- [ ] **Step 1: Teste (falhando)** — adicionar em `server/test/parser.test.ts`:

```ts
it('init expõe slashCommands do raw', () => {
  const evt = classifyLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'opus', slash_commands: ['compact', 'cost', 'exit'] }))
  expect(evt).toMatchObject({ kind: 'init', sessionId: 's1', model: 'opus', slashCommands: ['compact', 'cost', 'exit'] })
})

it('init sem slash_commands vira lista vazia', () => {
  const evt = classifyLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2', model: 'opus' }))
  expect((evt as any).slashCommands).toEqual([])
})
```
(Conferir o import de `classifyLine` no topo do arquivo; ele já é usado nos outros testes.)

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm test -w server -- parser`
Expected: FAIL — `slashCommands` é `undefined`.

- [ ] **Step 3: Implementar**

Em `server/src/claude/events.ts`, o tipo do init:
```ts
  | { kind: 'init'; sessionId: string; model: string; slashCommands: string[]; raw: unknown }
```
Em `server/src/claude/parser.ts`, a linha do init:
```ts
        return { kind: 'init', sessionId: obj.session_id, model: obj.model ?? '', slashCommands: Array.isArray(obj.slash_commands) ? obj.slash_commands : [], raw: obj }
```

- [ ] **Step 4: Rodar**

Run: `npm test -w server -- parser && npx tsc -p server --noEmit`
Expected: PASS; tsc limpo.

- [ ] **Step 5: Commit**

```bash
git add server/src/claude/parser.ts server/src/claude/events.ts server/test/parser.test.ts
git commit -m "feat(parser): evento init expõe slashCommands (do slash_commands do raw)"
```

---

### Task 2: Front — slash.ts (fallback/descrições/filtro) + i18n + store + tipo

**Files:**
- Create: `web/src/slash.ts`
- Modify: `web/src/types.ts` (ClaudeEvent init ganha slashCommands), `web/src/store.ts` (campo + captura), `web/src/i18n/{en,es,pt-BR}.ts`
- Test: `web/src/test/slash.test.ts` (create), `web/src/test/store.test.ts`

**Interfaces:**
- Consumes: evento `init` com `slashCommands` (Task 1).
- Produces:
  - `BUILTIN_FALLBACK: string[]`, `SLASH_DESCRIPTIONS: Record<string, string>`, `HIDDEN: Set<string>`
  - `filterCommands(all: string[], query: string): string[]`
  - `store.slashCommands: string[]`

- [ ] **Step 1: `web/src/slash.ts`**

```ts
/** Built-ins úteis no chat, com descrição (chave i18n). Ordem de destaque. */
export const SLASH_DESCRIPTIONS: Record<string, string> = {
  compact: 'slash.compact',
  cost: 'slash.cost',
  context: 'slash.context',
  usage: 'slash.usage',
  clear: 'slash.clear',
  model: 'slash.model',
  mcp: 'slash.mcp',
  agents: 'slash.agents',
}

/** Usado antes do 1º init chegar (os comandos reais substituem depois). */
export const BUILTIN_FALLBACK: string[] = Object.keys(SLASH_DESCRIPTIONS)

/** Comandos só-TUI que não fazem nada útil no chat headless. */
export const HIDDEN = new Set(['exit', 'help'])

/**
 * Filtra por substring (case-insensitive) no nome, exclui os HIDDEN e ordena:
 * built-ins com descrição primeiro (na ordem do mapa), depois alfabético.
 */
export function filterCommands(all: string[], query: string): string[] {
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const matches = all.filter((c) => {
    if (HIDDEN.has(c) || seen.has(c)) return false
    seen.add(c)
    return c.toLowerCase().includes(q)
  })
  const order = Object.keys(SLASH_DESCRIPTIONS)
  return matches.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1
      if (ib === -1) return -1
      return ia - ib
    }
    return a.localeCompare(b)
  })
}
```

- [ ] **Step 2: Testes de `slash.ts` (falhando)** — `web/src/test/slash.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filterCommands, BUILTIN_FALLBACK, HIDDEN } from '../slash'

describe('filterCommands', () => {
  it('filtra por substring, ignorando caixa', () => {
    expect(filterCommands(['compact', 'cost', 'clear', 'model'], 'co')).toEqual(['compact', 'cost'])
  })
  it('exclui os HIDDEN (exit/help)', () => {
    expect(filterCommands(['exit', 'help', 'compact'], '')).not.toContain('exit')
    expect(filterCommands(['exit', 'help', 'compact'], '')).not.toContain('help')
  })
  it('built-ins com descrição vêm antes dos de plugin', () => {
    const out = filterCommands(['figma:figma-use', 'compact'], '')
    expect(out.indexOf('compact')).toBeLessThan(out.indexOf('figma:figma-use'))
  })
  it('query vazia lista tudo (menos HIDDEN)', () => {
    expect(filterCommands(['compact', 'exit'], '')).toEqual(['compact'])
  })
})

describe('BUILTIN_FALLBACK', () => {
  it('não inclui comandos HIDDEN', () => {
    for (const c of BUILTIN_FALLBACK) expect(HIDDEN.has(c)).toBe(false)
  })
})
```

Run: `npm test -w web -- slash`
Expected: PASS (após o Step 1).

- [ ] **Step 3: i18n `slash.*`** — adicionar em cada dicionário (dentro do objeto, no nível de topo, `: typeof en` intacto):

`en.ts`:
```ts
  slash: {
    compact: 'compact the context to free space',
    cost: 'show session usage and cost',
    context: 'show context usage',
    usage: 'show usage limits',
    clear: 'clear the conversation context',
    model: 'switch the model',
    mcp: 'manage MCP servers',
    agents: 'list available agents',
  },
```
`pt-BR.ts`:
```ts
  slash: {
    compact: 'resume o contexto para liberar espaço',
    cost: 'mostra o uso e o custo da sessão',
    context: 'mostra o uso de contexto',
    usage: 'mostra os limites de uso',
    clear: 'limpa o contexto da conversa',
    model: 'troca o modelo',
    mcp: 'gerencia servidores MCP',
    agents: 'lista os agentes disponíveis',
  },
```
`es.ts`:
```ts
  slash: {
    compact: 'compacta el contexto para liberar espacio',
    cost: 'muestra el uso y costo de la sesión',
    context: 'muestra el uso de contexto',
    usage: 'muestra los límites de uso',
    clear: 'limpia el contexto de la conversación',
    model: 'cambia el modelo',
    mcp: 'gestiona servidores MCP',
    agents: 'lista los agentes disponibles',
  },
```

- [ ] **Step 4: `types.ts` (web) — init ganha slashCommands**

Em `web/src/types.ts`, na união `ClaudeEvent`, a variante init:
```ts
  | { kind: 'init'; sessionId: string; model: string; slashCommands?: string[]; raw: unknown }
```
(opcional para não quebrar históricos/mocks sem o campo.)

- [ ] **Step 5: store — campo + captura + teste**

Teste em `web/src/test/store.test.ts`:
```ts
it('evento init popula slashCommands (global)', () => {
  useStore.getState().applyWsMessage({ type: 'session_event', localId: 's1', event: { kind: 'init', sessionId: 'x', model: 'opus', slashCommands: ['compact', 'meu-comando'] } })
  expect(useStore.getState().slashCommands).toContain('meu-comando')
})
```
Em `web/src/store.ts`:
- importar `import { BUILTIN_FALLBACK } from './slash'`
- na interface `State`: `slashCommands: string[]`
- no estado inicial: `slashCommands: BUILTIN_FALLBACK,`
- no handler `session_event`, ANTES do bloco de stream (ou logo no começo do else-if), capturar o init:
```ts
      if (event.kind === 'init' && Array.isArray(event.slashCommands) && event.slashCommands.length) {
        set({ slashCommands: event.slashCommands })
      }
```
(colocar essa checagem logo após `const { localId, event } = msg`, antes do `if (event.kind === 'stream')` — não dá `return`, o init segue o fluxo normal de applyEvent.)

- [ ] **Step 6: Rodar e commitar**

Run: `npm test -w web -- slash store && npm run build -w web`
Expected: verde; build limpo.

```bash
git add web/src/slash.ts web/src/types.ts web/src/store.ts web/src/i18n web/src/test/slash.test.ts web/src/test/store.test.ts
git commit -m "feat(web): slash.ts (fallback/descrições/filtro) + captura de slashCommands no store + i18n"
```

---

### Task 3: SlashMenu + integração no ChatInput

**Files:**
- Create: `web/src/components/SlashMenu.tsx`
- Modify: `web/src/components/ChatInput.tsx`, `web/src/styles.css`
- Test: `web/src/test/chatinput-slash.test.tsx` (create)

**Interfaces:**
- Consumes: `filterCommands`, `SLASH_DESCRIPTIONS` (Task 2); `store.slashCommands`.

- [ ] **Step 1: `web/src/components/SlashMenu.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { SLASH_DESCRIPTIONS } from '../slash'

export function SlashMenu({ items, activeIndex, onPick }: {
  items: string[]
  activeIndex: number
  onPick: (cmd: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="slash-menu glass" data-testid="slash-menu">
      {items.map((cmd, i) => {
        const desc = SLASH_DESCRIPTIONS[cmd]
        return (
          <div
            key={cmd}
            data-testid="slash-item"
            className={`slash-item ${i === activeIndex ? 'active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(cmd) }}
          >
            <span className="slash-item__name">/{cmd}</span>
            {desc && <span className="slash-item__desc">{t(desc as any)}</span>}
          </div>
        )
      })}
    </div>
  )
}
```
(`onMouseDown` + `preventDefault` para não tirar o foco do textarea antes do pick.)

- [ ] **Step 2: Testes (falhando)** — `web/src/test/chatinput-slash.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

beforeEach(() => {
  useStore.setState({
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    slashCommands: ['compact', 'cost', 'clear', 'exit', 'figma:figma-use'],
  })
})
afterEach(() => cleanup())

const renderInput = (send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  return { send, ta: screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement }
}

describe('autocomplete de slash no ChatInput', () => {
  it('digitar "/co" abre o menu com os matches (sem exit)', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/co' } })
    expect(screen.getByTestId('slash-menu')).toBeTruthy()
    const items = screen.getAllByTestId('slash-item').map((el) => el.textContent)
    expect(items.some((t) => t?.includes('/compact'))).toBe(true)
    expect(items.some((t) => t?.includes('/exit'))).toBe(false)
  })

  it('ArrowDown + Enter PREENCHE o campo e NÃO envia', () => {
    const { send, ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/c' } })
    fireEvent.keyDown(ta, { key: 'Enter' }) // seleciona o 1º (activeIndex 0)
    expect(ta.value).toBe('/compact ')
    expect(send).not.toHaveBeenCalled()
  })

  it('Enter com o menu FECHADO envia', () => {
    const { send, ta } = renderInput()
    fireEvent.change(ta, { target: { value: 'ola mundo' } }) // não começa com /
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: 'ola mundo' })
  })

  it('Escape fecha o menu', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/co' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(screen.queryByTestId('slash-menu')).toBeNull()
  })

  it('texto com espaço após o comando fecha o menu', () => {
    const { ta } = renderInput()
    fireEvent.change(ta, { target: { value: '/compact agora' } })
    expect(screen.queryByTestId('slash-menu')).toBeNull()
  })
})
```

Run: `npm test -w web -- chatinput-slash`
Expected: FAIL — ChatInput não tem o menu.

- [ ] **Step 3: Integrar no `ChatInput.tsx`**

Imports (adicionar):
```tsx
import { filterCommands } from '../slash'
import { SlashMenu } from './SlashMenu'
```
Estado (adicionar junto dos outros `useState`):
```tsx
  const slashCommands = useStore((s) => s.slashCommands)
  const [activeIndex, setActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
```
Derivações (antes do `return`):
```tsx
  const slashQuery = /^\/\S*$/.test(text) ? text.slice(1) : null
  const slashMatches = slashQuery !== null ? filterCommands(slashCommands, slashQuery) : []
  const slashOpen = !disabled && !slashDismissed && slashMatches.length > 0
  const pickSlash = (cmd: string) => {
    setText(`/${cmd} `)
    setSlashDismissed(true)
    areaRef.current?.focus()
  }
```
Trocar o `onChange` do textarea para resetar o estado do menu:
```tsx
          onChange={(e) => { setText(e.target.value); setSlashDismissed(false); setActiveIndex(0) }}
```
Trocar o `onKeyDown` para tratar o menu ANTES do envio:
```tsx
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % slashMatches.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashMatches[Math.min(activeIndex, slashMatches.length - 1)]); return }
              if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
            }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
```
Envolver a linha do input num container relativo e renderizar o menu acima. Trocar o `<div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>` por:
```tsx
      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        {slashOpen && (
          <SlashMenu items={slashMatches} activeIndex={Math.min(activeIndex, slashMatches.length - 1)} onPick={pickSlash} />
        )}
        <textarea
          ...
```

- [ ] **Step 4: CSS** — ao fim de `web/src/styles.css`:

```css
.slash-menu {
  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 20;
  min-width: 300px; max-width: 460px; max-height: 260px; overflow-y: auto;
  border-radius: 12px; padding: 6px;
}
.slash-item { display: flex; align-items: baseline; gap: 10px; padding: 7px 10px; border-radius: 8px; cursor: pointer; }
.slash-item:hover, .slash-item.active { background: var(--glass-bg-strong); }
.slash-item__name { font-family: monospace; font-size: 13px; color: var(--text); }
.slash-item__desc { font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 5: Rodar e commitar**

Run: `npm test -w web && npm run build -w web`
Expected: suíte inteira verde; build limpo.

```bash
git add web/src/components/SlashMenu.tsx web/src/components/ChatInput.tsx web/src/styles.css web/src/test/chatinput-slash.test.tsx
git commit -m "feat(web): autocomplete de slash commands no ChatInput (menu + teclado, preencher-e-confirmar)"
```

Após o merge, o controlador faz um smoke visual: digitar `/` mostra o menu; ↓ navega; Enter preenche; Enter de novo envia.

---

## Self-Review

**1. Spec coverage:** init expõe slashCommands → Task 1 ✅; slash.ts fallback/descrições/HIDDEN/filterCommands → Task 2 ✅; store captura + tipo web → Task 2 ✅; i18n slash.* → Task 2 ✅; SlashMenu acima do input + teclado ↑↓/Enter/Tab/Esc + preencher-e-confirmar + Enter fechado envia + fecha com espaço/Esc → Task 3 ✅; /exit,/help escondidos → HIDDEN (Task 2) + teste (Task 3) ✅; fallback antes do init → BUILTIN_FALLBACK (Task 2) ✅.
**2. Placeholder scan:** código completo em todo passo; nenhum TODO/TBD.
**3. Type consistency:** `slashCommands: string[]` idêntico em events.ts/parser (Task 1) → types.ts web + store (Task 2) → ChatInput (Task 3); `filterCommands(all, query): string[]` e `SLASH_DESCRIPTIONS`/`BUILTIN_FALLBACK`/`HIDDEN` definidos na Task 2 e consumidos nas Tasks 2/3; `SlashMenu({items, activeIndex, onPick})` casa com o uso no ChatInput; chaves `slash.*` criadas na Task 2 e usadas no SlashMenu (Task 3).
