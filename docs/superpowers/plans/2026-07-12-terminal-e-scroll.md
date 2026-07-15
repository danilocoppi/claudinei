# Terminal sempre à mão + scroll Glass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Botão "Abrir no terminal" fixo à direita do título da sessão (com confirmação+interrupt durante um turno), volta da visão terminal direto ao chat com revive automático, e scrollbars no padrão Glass/Aurora.

**Architecture:** Só front. `ChatView` ganha o botão permanente com três comportamentos por status (direto / ConfirmDialog+interrupt+espera / desabilitado). `TerminalView` troca o "fechar → dashboard" por "voltar ao chat" (closeTerminal → reviveSession → openSession, com fallback). `styles.css` ganha scrollbars globais WebKit+Firefox.

**Tech Stack:** React 18 + TS strict (imports sem extensão), Vitest, CSS puro.

## Global Constraints

- Português com acentuação correta; i18n nas 3 línguas (en, es, pt-BR).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- TDD; `npm test` em `web/` (o server não muda).
- O interrupt já existe (Leva A): `ws.send({ type: 'interrupt', localId })`; o status muda via WS em ~0,1-2s.
- `ConfirmDialog` existente (Portal). `reviveSession`/`closeTerminal` existentes em `api.ts`. `store.openSession/openTerminal/openDashboard` existentes.

---

### Task 1: Botão "Abrir no terminal" fixo no título

**Files:**
- Modify: `web/src/components/ChatView.tsx`
- Modify: `web/src/i18n/{en,es,pt-BR}.ts` (chaves `chat.handoffTitle`, `chat.handoffWorking`, `chat.handoffUnavailable`)
- Test: `web/src/test/chatview-terminal.test.tsx` (novo)

**Interfaces:**
- Consumes: `ConfirmDialog` (`{ title, message, confirmLabel, onConfirm, onClose, error }` — LEIA o componente p/ confirmar as props), `store.openTerminal`, ws interrupt.
- Produces: nada para outras tasks.

- [ ] **Step 1: i18n** — bloco `chat` nas 3 línguas:
- en: `handoffTitle: 'Open in terminal?', handoffWorking: 'The turn in progress will be stopped to open this conversation in the terminal.', handoffUnavailable: 'Available when the session is active.',`
- es: `handoffTitle: '¿Abrir en la terminal?', handoffWorking: 'El turno en curso se detendrá para abrir esta conversación en la terminal.', handoffUnavailable: 'Disponible cuando la sesión esté activa.',`
- pt-BR: `handoffTitle: 'Abrir no terminal?', handoffWorking: 'O turno em andamento será interrompido para abrir esta conversa no terminal.', handoffUnavailable: 'Disponível quando a sessão estiver ativa.',`

- [ ] **Step 2: teste falhando**

Create `web/src/test/chatview-terminal.test.tsx` (siga o setup de `chat-edit.test.tsx`/`chatview.test.tsx` — store setState com sessão+projeto, WsContext, mock de fetchHistory se necessário):
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

function setup(status: string) {
  useStore.setState({
    projects: [{ id: 1, name: 'P', icon: '📂', path: '/p' } as never],
    sessions: { s1: { localId: 's1', projectId: 1, status } as never },
    chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'x' },
    activeLocalId: 's1', view: 'chat',
  })
}
afterEach(() => cleanup())

describe('botão Abrir no terminal no título', () => {
  it('idle → abre direto (view terminal)', () => {
    setup('idle')
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByText(/terminal/i, { selector: 'button' }))
    expect(useStore.getState().view).toBe('terminal')
  })

  it('working → abre o diálogo; confirmar envia interrupt e, quando o status muda, abre o terminal', async () => {
    const send = vi.fn()
    setup('working')
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByText(/terminal/i, { selector: 'button' }))
    expect(screen.getByText('O turno em andamento será interrompido para abrir esta conversa no terminal.')).toBeTruthy()
    fireEvent.click(screen.getByText('Confirmar'))
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
    expect(useStore.getState().view).toBe('chat') // ainda não abriu — espera o status
    act(() => { useStore.setState((s) => ({ sessions: { s1: { ...s.sessions.s1, status: 'needs_attention' } as never } })) })
    await waitFor(() => expect(useStore.getState().view).toBe('terminal'))
  })

  it('working → cancelar o diálogo não interrompe nem abre', () => {
    const send = vi.fn()
    setup('working')
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByText(/terminal/i, { selector: 'button' }))
    fireEvent.click(screen.getByText('Cancelar'))
    expect(send).not.toHaveBeenCalled()
    expect(useStore.getState().view).toBe('chat')
  })

  it('stopped/dead/starting → desabilitado com dica', () => {
    for (const status of ['stopped', 'dead', 'starting']) {
      setup(status)
      const { unmount } = render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
      const btn = screen.getByTitle('Disponível quando a sessão estiver ativa.') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      unmount()
    }
  })
})
```
(Os textos dos botões do ConfirmDialog: confira o componente — se usa `common.confirm`/`common.cancel`, os literais pt-BR são "Confirmar"/"Cancelar" como acima. Ajuste o seletor do botão do título se `getByText(/terminal/i)` colidir com outra coisa — pode usar `getByRole('button', { name: /terminal/i })`.)

- [ ] **Step 3: rodar (falha)** — `cd web && npm test -- chatview-terminal` → FAIL.

- [ ] **Step 4: implementar no ChatView**

1. Remover o bloco atual `{canHandoff && <button …>}` e a var `canHandoff`.
2. Estado + efeito de espera pós-confirmação:
```tsx
  const [handoffDialog, setHandoffDialog] = useState(false)
  const [handoffPending, setHandoffPending] = useState(false)

  // Após confirmar durante um turno: espera o interrupt tirar a sessão de 'working'
  // e então abre o terminal. Timeout de 5s (o interrupt real leva ~0,1s).
  useEffect(() => {
    if (!handoffPending || !session) return
    if (session.status === 'working') {
      const timer = setTimeout(() => setHandoffPending(false), 5000)
      return () => clearTimeout(timer)
    }
    setHandoffPending(false)
    openTerminal(session.localId)
  }, [handoffPending, session?.status])
```
3. Handler do clique:
```tsx
  const handleOpenTerminal = () => {
    if (!session) return
    if (session.status === 'working') { setHandoffDialog(true); return }
    openTerminal(session.localId)
  }
```
4. Botão no header (substitui o antigo; `marginLeft: 'auto'` ancora à direita):
```tsx
        <button className="ghost" style={{ marginLeft: 'auto' }}
                disabled={!(session.status === 'idle' || session.status === 'needs_attention' || session.status === 'working')}
                title={!(session.status === 'idle' || session.status === 'needs_attention' || session.status === 'working') ? t('chat.handoffUnavailable') : undefined}
                onClick={handleOpenTerminal}>
          🖥 {t('chat.openInTerminal')}
        </button>
```
(Se o header tiver outros elementos depois do status, ajuste para o botão ser o último à direita. `in_terminal` já não renderiza o ChatInput — o botão pode ficar desabilitado nesse status também, coberto pelo `!(…)`.)
5. Diálogo (no JSX, junto de outros overlays):
```tsx
      {handoffDialog && session && (
        <ConfirmDialog
          title={t('chat.handoffTitle')}
          message={t('chat.handoffWorking')}
          onConfirm={() => {
            setHandoffDialog(false)
            ws?.send({ type: 'interrupt', localId: session.localId })
            setHandoffPending(true)
          }}
          onClose={() => setHandoffDialog(false)}
        />
      )}
```
(Confirme as props reais do ConfirmDialog e imports: `useState` já deve existir; adicione `ConfirmDialog`.)

- [ ] **Step 5: rodar (passa)** — `npm test -- chatview-terminal` PASS; suíte inteira + tsc + build verdes (o teste antigo do chatview que cobria o botão condicional pode precisar de ajuste — atualize a asserção para o novo comportamento, sem enfraquecer).

- [ ] **Step 6: Commit**

```bash
git add -A web
git commit -m "feat(ui): Abrir no terminal fixo no título (confirma e interrompe durante turno)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Voltar da visão terminal direto ao chat (com revive)

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/i18n/{en,es,pt-BR}.ts` (`terminal.backToChat`; remover `terminal.close` se ficar órfã)
- Test: `web/src/test/terminal-back.test.tsx` (novo; se já existir teste do TerminalView, estenda-o)

**Interfaces:**
- Consumes: `closeTerminal`/`reviveSession` de `../api`; `store.openSession`.
- Produces: nada.

- [ ] **Step 1: i18n** — bloco `terminal` nas 3 línguas:
- en: `backToChat: '← Back to chat',`
- es: `backToChat: '← Volver al chat',`
- pt-BR: `backToChat: '← Voltar ao chat',`
(Se `terminal.close` não for mais usada em lugar nenhum após a mudança, remova-a das 3 línguas.)

- [ ] **Step 2: teste falhando**

Create `web/src/test/terminal-back.test.tsx` — mocke `../api` (`closeTerminal`, `reviveSession`, e o que o TerminalView usar no mount: `openTerminal` da api → faça-o rejeitar ou devolver algo inofensivo; veja o componente e o teste existente dele, se houver, para o padrão de mock do xterm — se o xterm atrapalhar, mocke `@xterm/xterm` e `@xterm/addon-fit` com stubs):
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  openTerminal: vi.fn(async () => ({ token: 'tk', wsUrl: 'ws://x' })),
  closeTerminal: vi.fn(async () => undefined),
  reviveSession: vi.fn(async () => ({ localId: 's1', status: 'idle' })),
}))
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => ({ open: vi.fn(), write: vi.fn(), dispose: vi.fn(), onData: vi.fn(), loadAddon: vi.fn(), focus: vi.fn() })) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn(), proposeDimensions: vi.fn() })) }))

import { TerminalView } from '../components/TerminalView'
import { closeTerminal, reviveSession } from '../api'
import { useStore } from '../store'

beforeEach(() => {
  useStore.setState({ view: 'terminal', activeLocalId: 's1', sessions: { s1: { localId: 's1', projectId: 1, status: 'in_terminal' } as never }, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => cleanup())

describe('voltar ao chat', () => {
  it('fecha o terminal, revive a sessão e navega para o chat', async () => {
    render(<TerminalView />)
    fireEvent.click(screen.getByText('← Voltar ao chat'))
    await waitFor(() => expect(useStore.getState().view).toBe('chat'))
    expect(closeTerminal).toHaveBeenCalledWith('s1')
    expect(reviveSession).toHaveBeenCalledWith('s1')
    expect(useStore.getState().activeLocalId).toBe('s1')
  })

  it('revive falhando ainda navega para o chat (fallback: botão Reviver lá)', async () => {
    ;(reviveSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('já viva'))
    render(<TerminalView />)
    fireEvent.click(screen.getByText('← Voltar ao chat'))
    await waitFor(() => expect(useStore.getState().view).toBe('chat'))
  })
})
```
(Adapte os mocks ao que o TerminalView realmente importa — LEIA o componente primeiro; o mock do WebSocket do canal PTY pode ser necessário: `vi.stubGlobal('WebSocket', ...)` com stub mínimo.)

- [ ] **Step 3: rodar (falha)** e **implementar**

Em `TerminalView.tsx`, trocar `encerrar`:
```tsx
  const voltarAoChat = async () => {
    if (localId) {
      await closeTerminalApi(localId).catch(() => {})
      // revive automático: 1 clique para continuar a conversa; se falhar, o chat
      // mostra o botão Reviver como fallback
      await reviveSession(localId).catch(() => {})
      openSession(localId)
    } else {
      openDashboard()
    }
  }
```
com `openSession` do store (`useStore((s) => s.openSession)`), import de `reviveSession` na api, e o botão: `<button onClick={voltarAoChat}>{t('terminal.backToChat')}</button>`. Remova `terminal.close` das 3 línguas SE nenhum outro uso restar (grep).

- [ ] **Step 4: rodar (passa)** — suíte inteira + tsc + build verdes.

- [ ] **Step 5: Commit**

```bash
git add -A web
git commit -m "feat(ui): voltar da visão terminal direto ao chat com revive automático

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Scrollbars Glass

**Files:**
- Modify: `web/src/styles.css`

- [ ] **Step 1: implementar** (CSS puro — sem unit test; validação visual no smoke)

Adicionar ao final de `web/src/styles.css`:
```css
/* Scrollbars no padrão Glass/Aurora (WebKit + Firefox) */
* { scrollbar-width: thin; scrollbar-color: var(--glass-border) transparent; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--glass-border); border-radius: 10px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent); }
::-webkit-scrollbar-corner { background: transparent; }
```

- [ ] **Step 2: verificar** — `npm run build` exit 0; suíte inalterada verde.

- [ ] **Step 3: Commit**

```bash
git add web/src/styles.css
git commit -m "feat(ui): scrollbars no padrão Glass/Aurora

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Smoke (controlador)

- Browser real: botão 🖥 à direita do título em todos os status; durante turno → diálogo → confirmar → interrupt → terminal abre; voltar → chat da MESMA sessão viva (revive automático); scrollbars finas no chat/sidebar (e no xterm — se o xterm impor cores, sobrescrever conforme o spec).

## Self-Review (autor do plano)

- Spec coberto: botão permanente com 3 comportamentos (T1), volta+revive com fallback (T2), scrollbars global+xterm-via-global (T3, com plano B documentado no spec). i18n nas 3 línguas (T1/T2). ✔
- Sem placeholders; pontos dependentes do código real (props do ConfirmDialog, mocks do TerminalView, teste antigo do chatview) têm instrução explícita de leitura/adaptação. ✔
- Tipos consistentes: interrupt `{type:'interrupt', localId}` (Leva A); `openSession(localId)`; `reviveSession(localId)`. ✔
