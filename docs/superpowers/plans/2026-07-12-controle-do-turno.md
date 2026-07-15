# Controle do turno (parar + editar) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parar o turno em andamento (botão ■ + Esc) e recuperar/editar uma das últimas 5 mensagens do usuário (lápis no hover + ↑ no campo vazio), interrompendo o turno antes quando necessário.

**Architecture:** Backend ganha `interrupt()` na sessão (control_request validado por spike: aborta em ~0,1s e a sessão segue viva), exposto via manager e um novo tipo WS `{type:'interrupt', localId}`. O front adiciona o botão ■ no grupo de ações (só em `working`), Esc no textarea, lápis nas últimas 5 mensagens do usuário (via prop `onEdit` do ChatView) e navegação ↑/↓ de histórico no campo vazio; a comunicação lápis→campo usa `editRequest` no store.

**Tech Stack:** Fastify 5 + TS strict ESM (server, imports com `.js`); React 18 + TS strict (web, imports sem extensão); Vitest.

## Global Constraints

- Português com acentuação correta; UI via i18n nas 3 línguas (en, es, pt-BR).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- TDD em toda task; `npm test` dentro de `server/` e `web/`.
- Interrupt fora de `working` é **no-op silencioso** (resolve sem enviar nada).
- `setModel`/`setPermissionMode` CONTINUAM rejeitando `working` (só o interrupt passa).
- Esc: menu de slash aberto tem precedência (fecha o menu); só com ele fechado o Esc para o turno.
- ↑ só entra no modo histórico com o campo VAZIO e slash fechado; digitar sai do modo.

---

### Task 1: Interrupt de ponta a ponta no servidor

**Files:**
- Modify: `server/src/claude/session.ts` (sendControl com allowWorking; método interrupt)
- Modify: `server/src/claude/manager.ts` (interrupt(localId))
- Modify: `server/src/routes/ws.ts` (tipo 'interrupt')
- Modify: `server/test/fake-claude.mjs` (modo "demorada" + interrupt)
- Test: `server/test/session.test.ts`, `server/test/manager.test.ts` (ou o arquivo de testes do manager existente — siga o padrão), `server/test/ws.test.ts` (adicionar casos)

**Interfaces:**
- Consumes: `ClaudeSession.sendControl` privado existente; `manager.send/markRead` como referência de wiring.
- Produces:
  - `ClaudeSession.interrupt(): Promise<void>` — em `working`, envia `control_request {subtype:'interrupt'}` e resolve no `control_response`; fora de `working`, resolve imediatamente sem enviar.
  - `manager.interrupt(localId: string): Promise<void>`
  - WS aceita `{ type: 'interrupt', localId: string }`.

- [ ] **Step 1: fake-claude — modo "demorada" + interrupt**

Em `server/test/fake-claude.mjs`:
1. No handler de `control_request`, ANTES dos modos existentes, adicionar:
```js
    if (r.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sid, num_turns: 1, total_cost_usd: 0 })
      return
    }
```
2. No handler de mensagem de usuário, adicionar modo (antes do `respond()`):
```js
  if (text.includes('demorada')) {
    // turno fica aberto: responde assistant mas NUNCA emite result (até um interrupt)
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'trabalhando…' }] } })
    return
  }
```
(Atualize o comentário de cabeçalho do arquivo com os dois modos novos.)

- [ ] **Step 2: testes falhando (session)**

Em `server/test/session.test.ts`, adicionar ao `describe('ClaudeSession', …)`:
```ts
  it('interrupt durante working aborta o turno: result de erro → needs_attention', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('tarefa demorada')
    expect(s.status).toBe('working')
    await s.interrupt()
    await waitFor(s, 'needs_attention')
    await s.stop()
  })

  it('interrupt fora de working é no-op silencioso', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    await expect(s.interrupt()).resolves.toBeUndefined()
    expect(s.status).toBe('idle')
    await s.stop()
  })

  it('setModel continua rejeitando durante working (allowWorking é só do interrupt)', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('tarefa demorada')
    await expect(s.setModel('opus')).rejects.toThrow(/working/)
    await s.interrupt()
    await waitFor(s, 'needs_attention')
    await s.stop()
  })
```

- [ ] **Step 3: rodar (falha)** — `cd server && npm test -- session` → FAIL (interrupt não existe).

- [ ] **Step 4: implementar na session**

Em `server/src/claude/session.ts`:
1. Assinatura do sendControl:
```ts
  private sendControl(subtype: string, payload: object, opts?: { allowWorking?: boolean }): Promise<void> {
    const workingBlocked = this.status === 'working' && !opts?.allowWorking
    if (!this.proc || this.status === 'stopped' || this.status === 'dead' || workingBlocked) {
      return Promise.reject(new Error(`sessão não aceita controle no status ${this.status}`))
    }
```
(resto do corpo inalterado)
2. Novo método público, junto de setModel/setPermissionMode:
```ts
  /** Aborta o turno em andamento. Fora de 'working' é no-op (o turno já acabou). */
  interrupt(): Promise<void> {
    if (this.status !== 'working') return Promise.resolve()
    return this.sendControl('interrupt', {}, { allowWorking: true })
  }
```

- [ ] **Step 5: rodar (passa)** — `npm test -- session` PASS.

- [ ] **Step 6: manager + ws (teste primeiro, depois wiring)**

Teste no arquivo de testes do manager (siga o describe existente):
```ts
  it('interrupt delega à sessão viva e rejeita para localId desconhecido', async () => {
    // siga o padrão de setup do arquivo (deps fake + start de uma sessão com fake-claude);
    // envie uma mensagem "tarefa demorada", chame manager.interrupt(localId),
    // aguarde status needs_attention no broadcast/evento.
    await expect(manager.interrupt('nao-existe')).rejects.toThrow()
  })
```
Implementação em `server/src/claude/manager.ts` (junto de send/markRead, mesmo estilo de lookup):
```ts
    async interrupt(localId: string): Promise<void> {
      const live = sessions.get(localId)
      if (!live) throw new Error(`sessão ${localId} não está ativa`)
      await live.session.interrupt()
    },
```
(Confirme o nome real do map/estrutura interna — siga `send`.)

WS: em `server/src/routes/ws.ts`, junto dos outros:
```ts
            else if (msg.type === 'interrupt') void deps.manager.interrupt(msg.localId).catch((err) => app.log.warn({ err }, 'interrupt falhou'))
```
(Siga o padrão de tratamento de erro do arquivo — se os outros handlers usam try/catch síncrono, alinhe.)
Teste em `server/test/ws.test.ts`: mandar `{type:'interrupt', localId}` pelo socket e verificar que `manager.interrupt` foi chamado (o arquivo já usa manager fake — adicione `interrupt: vi.fn()` ao fake).

- [ ] **Step 7: suíte + tsc** — `cd server && npm test` verde inteiro; `npx tsc --noEmit` limpo.

- [ ] **Step 8: Commit**

```bash
git add server/src/claude/session.ts server/src/claude/manager.ts server/src/routes/ws.ts server/test/fake-claude.mjs server/test/session.test.ts server/test/ws.test.ts
git commit -m "feat(turno): interrupt de ponta a ponta (session, manager, ws)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(Inclua o arquivo de teste do manager que você tocou.)

---

### Task 2: Botão ■ Parar + Esc no front

**Files:**
- Modify: `web/src/components/ChatInput.tsx` (botão ■ quando working; Esc)
- Modify: `web/src/i18n/{en,es,pt-BR}.ts` (chave `chat.stop`)
- Test: `web/src/test/chatinput-stop.test.tsx` (novo); `web/src/test/i18n.test.tsx` se houver lista de chaves de chat (conferir — se não houver, a paridade tipada `typeof en` já cobre)

**Interfaces:**
- Consumes: `session.status` (já no ChatInput), `ws.send` (contexto existente).
- Produces: nada novo para outras tasks (UI local).

- [ ] **Step 1: i18n**

Nos 3 dicionários, bloco `chat`:
- en: `stop: 'Stop the turn',`
- es: `stop: 'Detener el turno',`
- pt-BR: `stop: 'Parar o turno',`

- [ ] **Step 2: teste falhando**

Create `web/src/test/chatinput-stop.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

const SESSION = { localId: 's1', projectId: 1, status: 'working' } as never

beforeEach(() => {
  useStore.setState({ chat: {}, sessions: { s1: SESSION }, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => cleanup())

const renderInput = (send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  return { send, textarea: screen.getByPlaceholderText(/processando|Mensagem para o Claude/) as HTMLTextAreaElement }
}

describe('botão Parar', () => {
  it('aparece durante working e envia interrupt ao clicar', () => {
    const { send } = renderInput()
    fireEvent.click(screen.getByLabelText('Parar o turno'))
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
  })

  it('não aparece fora de working', () => {
    useStore.setState({ sessions: { s1: { ...SESSION, status: 'idle' } as never } })
    renderInput()
    expect(screen.queryByLabelText('Parar o turno')).toBeNull()
  })

  it('Esc no campo envia interrupt quando working (sem slash aberto)', () => {
    const { send, textarea } = renderInput()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
  })

  it('Esc com o menu de slash aberto fecha o menu, não interrompe', () => {
    useStore.setState({ slashCommands: ['compact', 'cost'] } as never)
    const { send, textarea } = renderInput()
    fireEvent.change(textarea, { target: { value: '/co' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
  })

  it('Esc fora de working não envia nada', () => {
    useStore.setState({ sessions: { s1: { ...SESSION, status: 'idle' } as never } })
    const { send, textarea } = renderInput()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: rodar (falha)** — `cd web && npm test -- chatinput-stop` → FAIL.

- [ ] **Step 4: implementar no ChatInput**

1. Handler (perto de `send`):
```tsx
  const stopTurn = () => { if (session?.status === 'working') ws?.send({ type: 'interrupt', localId }) }
```
2. No `onKeyDown` do textarea, o case Escape do slash já existe dentro do `if (slashOpen)` com `return`. DEPOIS do bloco do slash, adicionar:
```tsx
            if (e.key === 'Escape' && session?.status === 'working') { e.preventDefault(); stopTurn(); return }
```
3. No JSX, ANTES do `<MicButton …>`:
```tsx
        {session?.status === 'working' && (
          <button type="button" className="input-action mic-btn--rec" style={{ animation: 'none' }}
                  aria-label={t('chat.stop')} title={t('chat.stop')} onClick={stopTurn}>■</button>
        )}
```
(Reusa a cor vermelha do `mic-btn--rec` sem o pulso; se preferir, crie classe `.stop-btn { color: var(--err); border-color: var(--err); }` em styles.css e use `input-action stop-btn` — escolha um e seja consistente.)

- [ ] **Step 5: rodar (passa)** — `npm test -- chatinput-stop` PASS; depois `npm test` inteiro (não quebrar chatinput-slash/upload/mic) + `npx tsc --noEmit` + `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add -A web
git commit -m "feat(turno): botão ■ e tecla Esc param o turno em andamento

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Editar mensagem (lápis nas últimas 5 + ↑ histórico)

**Files:**
- Create: `web/src/chat/history.ts` (helpers puros)
- Modify: `web/src/store.ts` (editRequest/requestEdit)
- Modify: `web/src/components/ChatView.tsx` (onEdit nas últimas 5 user_text; interrupt se working)
- Modify: `web/src/components/MessageBlock.tsx` (✏ no hover quando onEdit presente)
- Modify: `web/src/components/ChatInput.tsx` (consome editRequest; ↑/↓ histórico)
- Modify: `web/src/styles.css` (classe do lápis)
- Modify: `web/src/i18n/{en,es,pt-BR}.ts` (`chat.edit`)
- Test: `web/src/test/history.test.ts` (novo), `web/src/test/chat-edit.test.tsx` (novo)

**Interfaces:**
- Consumes: `ChatItem` (`kind: 'user_text'`, `fromSubagent?`), store existente, ws.
- Produces:
  - `lastUserTexts(items: ChatItem[], n?: number): string[]` — textos das últimas n (default 5) mensagens `user_text` não-subagente, da mais antiga para a mais recente.
  - `historyStep(list: string[], index: number | null, dir: 'up' | 'down'): { index: number | null; text: string }` — navegação de histórico (index null = fora do modo; up a partir de null vai para a última; down além da última volta a null com text '').
  - Store: `editRequest?: { localId: string; text: string; seq: number }` e `requestEdit(localId: string, text: string): void`.
  - `MessageBlock` aceita prop opcional `onEdit?: () => void`.

- [ ] **Step 1: i18n** — bloco `chat` nas 3 línguas:
- en: `edit: 'Edit this message',`
- es: `edit: 'Editar este mensaje',`
- pt-BR: `edit: 'Editar esta mensagem',`

- [ ] **Step 2: testes falhando dos helpers**

Create `web/src/test/history.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { lastUserTexts, historyStep } from '../chat/history'
import type { ChatItem } from '../types'

const u = (text: string, fromSubagent = false): ChatItem => ({ kind: 'user_text', text, fromSubagent })
const a = (text: string): ChatItem => ({ kind: 'assistant_text', text })

describe('lastUserTexts', () => {
  it('pega as últimas n mensagens do usuário, da mais antiga p/ a mais recente', () => {
    const items = [u('1'), a('x'), u('2'), u('3'), a('y'), u('4'), u('5'), u('6')]
    expect(lastUserTexts(items, 5)).toEqual(['2', '3', '4', '5', '6'])
  })
  it('ignora mensagens de subagente', () => {
    expect(lastUserTexts([u('a'), u('sub', true), u('b')], 5)).toEqual(['a', 'b'])
  })
  it('menos que n → devolve as que houver', () => {
    expect(lastUserTexts([u('só')], 5)).toEqual(['só'])
  })
  it('vazio → []', () => {
    expect(lastUserTexts([], 5)).toEqual([])
  })
})

describe('historyStep', () => {
  const list = ['a', 'b', 'c']
  it('up a partir de fora do modo (null) vai para a mais recente', () => {
    expect(historyStep(list, null, 'up')).toEqual({ index: 2, text: 'c' })
  })
  it('up sobe até a mais antiga e trava lá', () => {
    expect(historyStep(list, 1, 'up')).toEqual({ index: 0, text: 'a' })
    expect(historyStep(list, 0, 'up')).toEqual({ index: 0, text: 'a' })
  })
  it('down desce e além da mais recente sai do modo com texto vazio', () => {
    expect(historyStep(list, 0, 'down')).toEqual({ index: 1, text: 'b' })
    expect(historyStep(list, 2, 'down')).toEqual({ index: null, text: '' })
  })
  it('lista vazia → permanece fora do modo', () => {
    expect(historyStep([], null, 'up')).toEqual({ index: null, text: '' })
  })
})
```

- [ ] **Step 3: rodar (falha)** e **implementar os helpers**

Create `web/src/chat/history.ts`:
```ts
import type { ChatItem } from '../types'

/** Textos das últimas n mensagens do usuário (sem subagentes), da mais antiga p/ a mais recente. */
export function lastUserTexts(items: ChatItem[], n = 5): string[] {
  const texts: string[] = []
  for (const item of items) {
    if (item.kind === 'user_text' && !item.fromSubagent) texts.push(item.text)
  }
  return texts.slice(-n)
}

/** Passo de navegação estilo histórico de shell. index null = fora do modo. */
export function historyStep(list: string[], index: number | null, dir: 'up' | 'down'): { index: number | null; text: string } {
  if (list.length === 0) return { index: null, text: '' }
  if (dir === 'up') {
    const next = index === null ? list.length - 1 : Math.max(0, index - 1)
    return { index: next, text: list[next] }
  }
  if (index === null) return { index: null, text: '' }
  const next = index + 1
  if (next >= list.length) return { index: null, text: '' }
  return { index: next, text: list[next] }
}
```
`npm test -- history` → PASS.

- [ ] **Step 4: store**

Em `web/src/store.ts`, no estado: `editRequest: undefined as { localId: string; text: string; seq: number } | undefined,` e ação:
```ts
  requestEdit: (localId: string, text: string) =>
    set((s) => ({ editRequest: { localId, text, seq: (s.editRequest?.seq ?? 0) + 1 } })),
```
(Adicione os tipos na interface do store seguindo o padrão do arquivo.)

- [ ] **Step 5: teste falhando da integração**

Create `web/src/test/chat-edit.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChatView } from '../components/ChatView'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import type { ChatItem } from '../types'

const u = (text: string): ChatItem => ({ kind: 'user_text', text })

function setup(status: 'working' | 'idle', items: ChatItem[]) {
  useStore.setState({
    projects: [{ id: 1, name: 'P', icon: '📂', path: '/p' } as never],
    sessions: { s1: { localId: 's1', projectId: 1, status } as never },
    chat: { s1: items }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'x' },
    activeLocalId: 's1', view: 'chat', editRequest: undefined,
  })
}
afterEach(() => cleanup())

describe('editar mensagem', () => {
  it('lápis aparece só nas últimas 5 mensagens do usuário', () => {
    setup('idle', [u('m1'), u('m2'), u('m3'), u('m4'), u('m5'), u('m6')])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    expect(screen.getAllByLabelText('Editar esta mensagem')).toHaveLength(5) // m2..m6
  })

  it('clicar no lápis durante working envia interrupt e registra o editRequest', () => {
    const send = vi.fn()
    setup('working', [u('instrução errada')])
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByLabelText('Editar esta mensagem'))
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
    expect(useStore.getState().editRequest).toMatchObject({ localId: 's1', text: 'instrução errada' })
  })

  it('clicar no lápis fora de working NÃO envia interrupt', () => {
    const send = vi.fn()
    setup('idle', [u('só recuperar')])
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByLabelText('Editar esta mensagem'))
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
    expect(useStore.getState().editRequest).toMatchObject({ text: 'só recuperar' })
  })

  it('editRequest preenche o campo do ChatInput', async () => {
    setup('idle', [])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    useStore.getState().requestEdit('s1', 'texto recuperado')
    await waitFor(() => expect(textarea.value).toBe('texto recuperado'))
  })

  it('↑ no campo vazio navega o histórico; ↓ sai limpando', async () => {
    setup('idle', [u('antiga'), u('recente')])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('recente')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('antiga')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('recente')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.value).toBe('')
  })

  it('↑ com texto no campo não intercepta (cursor nativo)', () => {
    setup('idle', [u('antiga')])
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'digitando' } })
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.value).toBe('digitando')
  })
})
```
Nota: se o histórico do ChatView carregar via fetch no mount, o `historyLoadedFor` acima já evita o fetch; se ainda assim disparar, mocke `fetchHistory` seguindo o padrão de `chatview.test.tsx`.

- [ ] **Step 6: rodar (falha)** e **implementar**

1. `MessageBlock.tsx`: prop `onEdit?: () => void`; no case `user_text`, envolver a bolha num wrapper com classe `msg-editable` quando `onEdit` e renderizar:
```tsx
        {onEdit && (
          <button type="button" className="msg-edit" aria-label={t('chat.edit')} title={t('chat.edit')} onClick={onEdit}>✏</button>
        )}
```
(Se o componente não tiver `useTranslation`, adicione; siga o estilo do arquivo.)

2. `ChatView.tsx`: calcular quais índices ganham lápis e a ação composta:
```tsx
  const editableTexts = lastUserTexts(items, 5)
  let editableRemaining = [...editableTexts]
  const handleEdit = (text: string) => {
    if (session.status === 'working') ws?.send({ type: 'interrupt', localId: session.localId })
    useStore.getState().requestEdit(session.localId, text)
  }
```
No map dos items: para cada item `user_text` não-subagente cujo texto seja o PRÓXIMO esperado em `editableRemaining` (consumir com shift para lidar com textos repetidos), passar `onEdit={() => handleEdit(item.text)}`. Implementação concreta: calcule antes do return um `Set` de ÍNDICES editáveis:
```tsx
  const editableIdx = new Set<number>()
  {
    let need = 5
    for (let i = items.length - 1; i >= 0 && need > 0; i--) {
      const it = items[i]
      if (it.kind === 'user_text' && !it.fromSubagent) { editableIdx.add(i); need-- }
    }
  }
```
e no map: `onEdit={editableIdx.has(i) ? () => handleEdit((item as { text: string }).text) : undefined}`.
(Com isso o helper `lastUserTexts` continua sendo usado apenas pelo ChatInput p/ o ↑; se preferir, use só o Set aqui — mantenha o helper para o histórico.)

3. `ChatInput.tsx`:
- Consumir o editRequest:
```tsx
  const editRequest = useStore((s) => s.editRequest)
  useEffect(() => {
    if (!editRequest || editRequest.localId !== localId) return
    setText(editRequest.text)
    histIdxRef.current = null
    requestAnimationFrame(() => {
      const el = areaRef.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }, [editRequest?.seq])
```
- Histórico ↑/↓ (no onKeyDown, ANTES do handler de Enter e FORA do bloco slashOpen):
```tsx
            if (!slashOpen && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              const inHistory = histIdxRef.current !== null
              if ((text === '' && e.key === 'ArrowUp') || inHistory) {
                e.preventDefault()
                const list = lastUserTexts(useStore.getState().chat[localId] ?? [], 5)
                const step = historyStep(list, histIdxRef.current, e.key === 'ArrowUp' ? 'up' : 'down')
                histIdxRef.current = step.index
                setText(step.text)
                return
              }
            }
```
com `const histIdxRef = useRef<number | null>(null)` e saída do modo ao digitar: no `onChange` existente, adicionar `histIdxRef.current = null`.
- Imports: `lastUserTexts, historyStep` de `../chat/history`.
- ATENÇÃO: o bloco do slash usa ArrowUp/ArrowDown com `return` quando `slashOpen` — o histórico só roda com slash fechado (o `!slashOpen` acima garante; o guard de `text === ''` impede conflito, pois slash exige texto começando com `/`).

4. `styles.css`:
```css
.msg-editable { position: relative; }
.msg-editable .msg-edit {
  position: absolute; top: 4px; right: 4px; opacity: 0;
  background: transparent; border: 1px solid var(--glass-border); border-radius: 8px;
  padding: 2px 6px; font-size: 12px; cursor: pointer; transition: opacity .15s;
}
.msg-editable:hover .msg-edit { opacity: 1; }
```
(Ajuste o wrapper no MessageBlock para a classe funcionar com o layout real da bolha do usuário — inspecione o JSX atual antes.)

- [ ] **Step 7: rodar tudo (passa)** — `cd web && npm test` inteiro verde; `npx tsc --noEmit`; `npm run build` exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A web
git commit -m "feat(turno): editar mensagem — lápis nas últimas 5 e histórico com ↑

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Self-Review (autor do plano)

- **Cobertura do spec:** interrupt session/manager/ws + no-op fora de working (T1); ■ só em working + Esc com precedência do slash (T2); lápis nas 5 últimas + interrupt-antes + editRequest + ↑/↓ histórico + sair do modo ao digitar (T3); i18n chat.stop/chat.edit (T2/T3); fake-claude com modos novos (T1). ✔
- **Placeholders:** nenhum; onde o plano depende do shape real do arquivo (manager map, JSX da bolha), a instrução é explícita: inspecionar e seguir o padrão. ✔
- **Consistência:** `historyStep(list, index, dir)` igual em helper/teste/uso; `editRequest {localId,text,seq}` igual em store/teste/consumo; `{type:'interrupt', localId}` igual em T1/T2/T3. ✔
