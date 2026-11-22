import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { BrowserClientMsg } from '../../../shared/browser'
import { renderComJanela as render } from './viewport'

/**
 * Review Focus 5: com o foco na tela do navegador, as teclas vão à página.
 * Alt+Z (Zen), Mod+Enter (enviar), Mod+F (buscar) e Mod+U (uso) não chegam ao
 * Claudinei; só a combinação de `view.browser` (Alt+B, ou a regravada) sai da
 * página e fecha a vista.
 */

const sock = vi.hoisted(() => ({ conns: [] as Array<{ sent: unknown[]; closed: boolean }> }))
vi.mock('../browser/browserSocket', () => ({
  connectBrowser: () => {
    const c = { sent: [] as unknown[], closed: false }
    sock.conns.push(c)
    return { send: (m: unknown) => { if (!c.closed) c.sent.push(m) }, close: () => { c.closed = true } }
  },
}))
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))

import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { useSideStore } from '../branch/sideStore'
import { useBrowserStore } from '../browser/browserStore'
import { useColumnStore } from '../browser/columnStore'
import { useBrowserShortcut } from '../browser/useBrowserShortcut'
import { useZenShortcut } from '../useZenShortcut'
import { useUsageShortcut } from '../useUsageShortcut'
import type { EngineMeta, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: [], permissions: [],
  slashSource: 'none', slashCommands: [], midTurnInput: true,
}
const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...o })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** Os atalhos globais que o App monta, aqui sem o resto do App. */
function Atalhos() {
  useZenShortcut()
  useUsageShortcut(true)
  useBrowserShortcut()
  return null
}

let wsSend: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('claudinei:browserPasswordWarned', '1')
  sock.conns.length = 0
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url)
    if (u === '/api/browser/tabs') return json({ tabs: [{ projectId: 1, engine: 'claude' }] })
    if (u.endsWith('/servers')) return json({ servers: [] })
    if (u.includes('/side')) return json({ side: null, events: [] })
    if (u.includes('/history')) return json({ events: [], before: 0, atStart: true })
    if (u.includes('/progress')) return json({ progress: null, path: '' })
    return json([])
  })
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null, readAt: {} })
  useBrowserStore.setState({ tabs: { '1:claude': true }, failed: {} })
  useColumnStore.setState({ view: 'browser', previous: null, fullscreen: false, marks: {}, widths: {} })
  useStore.setState({
    authStatus: 'ready',
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    progressEpoch: 0, progress: {}, progressOpen: true,
    projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁', engines: ['claude'] }],
    terminalStates: {},
    sessions: { a: sess() },
    chat: { a: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'chat', activeLocalId: 'a',
    engines: [CLAUDE],
    zen: false, find: null,
  })
  useStore.getState().setKeybindings({})
  wsSend = vi.fn()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const montar = () => render(
  <WsContext.Provider value={{ send: wsSend }}>
    <Atalhos />
    <div className="app"><ChatView /></div>
  </WsContext.Provider>,
)
const keys = () => sock.conns.at(-1)!.sent.filter((m) => (m as BrowserClientMsg).type === 'key') as Array<Extract<BrowserClientMsg, { type: 'key' }>>
const tecla = () => screen.getByTestId('browser-keys') as HTMLTextAreaElement
const coluna = () => document.querySelector<HTMLElement>('aside.right-column')

async function preparar() {
  montar()
  await waitFor(() => expect(coluna()?.dataset.view).toBe('browser'))
  // Um rascunho no campo do chat: o Mod+Enter, se escapasse, o enviaria.
  const campo = document.querySelector<HTMLTextAreaElement>('.chat-compose__area')!
  fireEvent.change(campo, { target: { value: 'rascunho' } })
  act(() => { tecla().focus() })
  expect(document.activeElement).toBe(tecla())
}

describe('teclas com o foco na tela do navegador', () => {
  it('Alt+Z, Ctrl+Enter, Ctrl+F e Ctrl+U vão à página e não ao Claudinei', async () => {
    await preparar()
    const combos = [
      { key: 'z', code: 'KeyZ', altKey: true },
      { key: 'Enter', code: 'Enter', ctrlKey: true },
      { key: 'f', code: 'KeyF', ctrlKey: true },
      { key: 'u', code: 'KeyU', ctrlKey: true },
    ]
    for (const c of combos) {
      const naoCancelado = fireEvent.keyDown(tecla(), c)
      expect(naoCancelado).toBe(false) // preventDefault: o navegador do operador não age
      fireEvent.keyUp(tecla(), c)
    }
    expect(keys().filter((k) => k.phase === 'down').map((k) => [k.key, k.alt, k.ctrl])).toEqual([
      ['z', true, false], ['Enter', false, true], ['f', false, true], ['u', false, true],
    ])
    expect(keys().filter((k) => k.phase === 'up')).toHaveLength(4)
    expect(keys()[0]).toEqual({ type: 'key', phase: 'down', key: 'z', code: 'KeyZ', alt: true, ctrl: false, meta: false, shift: false })
    const st = useStore.getState()
    expect(st.zen).toBe(false)
    expect(st.find).toBeNull()
    expect(st.view).toBe('chat')
    expect(wsSend.mock.calls.filter(([m]) => m?.type === 'send_message')).toHaveLength(0)
    expect(coluna()?.dataset.view).toBe('browser')
  })

  it('Alt+B não manda key e fecha a vista', async () => {
    await preparar()
    fireEvent.keyDown(tecla(), { key: 'b', code: 'KeyB', altKey: true })
    expect(keys()).toEqual([])
    await waitFor(() => expect(coluna()).toBeNull())
  })

  it('com view.browser regravado para Alt+N, Alt+B vai à página', async () => {
    useStore.getState().setKeybindings({ 'view.browser': 'Alt+N' })
    await preparar()
    fireEvent.keyDown(tecla(), { key: 'b', code: 'KeyB', altKey: true })
    expect(keys().map((k) => k.key)).toEqual(['b'])
    expect(coluna()?.dataset.view).toBe('browser')
    fireEvent.keyDown(tecla(), { key: 'n', code: 'KeyN', altKey: true })
    expect(keys().filter((k) => k.phase === 'down').map((k) => k.key)).toEqual(['b'])
    await waitFor(() => expect(coluna()).toBeNull())
    // A vista fechou com o B ainda apertado na página: ele é solto antes do socket fechar.
    expect(keys().map((k) => [k.phase, k.key])).toEqual([['down', 'b'], ['up', 'b']])
  })

  it('colar e o fim da composição mandam text; input sem composição não manda nada', async () => {
    await preparar()
    const t = tecla()
    const colar = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    colar.clipboardData = { getData: (tipo: string) => (tipo === 'text/plain' ? 'olá mundo' : '') }
    act(() => { t.dispatchEvent(colar) })
    expect(colar.defaultPrevented).toBe(true)
    fireEvent.input(t, { target: { value: 'a' } })
    fireEvent.compositionStart(t)
    fireEvent.keyDown(t, { key: 'Process', code: 'KeyA', isComposing: true })
    fireEvent.compositionEnd(t, { data: 'あ' })
    const msgs = sock.conns.at(-1)!.sent.filter((m) => ['text', 'key'].includes((m as BrowserClientMsg).type))
    expect(msgs).toEqual([{ type: 'text', text: 'olá mundo' }, { type: 'text', text: 'あ' }])
  })

  const textos = () => sock.conns.at(-1)!.sent.filter((m) => (m as BrowserClientMsg).type === 'text')

  it('Ctrl+V, ⌘V e Shift+Insert não são cancelados nem vão como key; o paste manda text', async () => {
    await preparar()
    const t = tecla()
    for (const c of [
      { key: 'v', code: 'KeyV', ctrlKey: true },
      { key: 'v', code: 'KeyV', metaKey: true },
      { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true },
      { key: 'Insert', code: 'Insert', shiftKey: true },
    ]) {
      // Não cancelado: o navegador do operador solta o `paste` com a área de transferência dele.
      expect(fireEvent.keyDown(t, c)).toBe(true)
      fireEvent.keyUp(t, c)
    }
    expect(keys()).toEqual([])
    const colar = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    colar.clipboardData = { getData: (tipo: string) => (tipo === 'text/plain' ? 'copiado' : '') }
    act(() => { t.dispatchEvent(colar) })
    expect(textos()).toEqual([{ type: 'text', text: 'copiado' }])
  })

  it('caractere fora do teclado americano (ç, €) e o AltGr vão como text, sem key nem up', async () => {
    await preparar()
    const t = tecla()
    expect(fireEvent.keyDown(t, { key: 'ç', code: 'Semicolon' })).toBe(false)
    fireEvent.keyUp(t, { key: 'ç', code: 'Semicolon' })
    fireEvent.keyDown(t, { key: '€', code: 'KeyE', altKey: true, ctrlKey: true })
    fireEvent.keyUp(t, { key: '€', code: 'KeyE', altKey: true, ctrlKey: true })
    // AltGr + Q num teclado alemão: '@', que é ASCII, mas com Ctrl+Alt a página não o digitaria.
    const altGr = new KeyboardEvent('keydown', {
      key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true,
    } as KeyboardEventInit)
    act(() => { t.dispatchEvent(altGr) })
    expect(altGr.defaultPrevented).toBe(true)
    fireEvent.keyUp(t, { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true })
    // Uma tecla comum continua indo como key.
    fireEvent.keyDown(t, { key: 'a', code: 'KeyA' })
    fireEvent.keyUp(t, { key: 'a', code: 'KeyA' })
    expect(textos()).toEqual([{ type: 'text', text: 'ç' }, { type: 'text', text: '€' }, { type: 'text', text: '@' }])
    expect(keys().map((k) => [k.phase, k.key])).toEqual([['down', 'a'], ['up', 'a']])
  })

  it('teclado virtual do celular: depois do keydown 229/Unidentified, o input sem composição manda o data', async () => {
    await preparar()
    const t = tecla()
    // O keydown fica com o navegador (sem preventDefault), senão o input nem viria.
    expect(fireEvent.keyDown(t, { key: 'Unidentified', keyCode: 229 })).toBe(true)
    fireEvent.input(t, { data: ' ', inputType: 'insertText', isComposing: false })
    fireEvent.keyUp(t, { key: 'Unidentified', keyCode: 229 })
    fireEvent.keyDown(t, { key: 'Unidentified', keyCode: 229 })
    fireEvent.input(t, { data: ',', inputType: 'insertText', isComposing: false })
    // Um input sem o keydown pulado antes (a tecla já foi como key) não repete nada.
    fireEvent.keyDown(t, { key: 'a', code: 'KeyA' })
    fireEvent.input(t, { data: 'a', inputType: 'insertText', isComposing: false })
    // O input que vem depois do fim da composição também não repete.
    fireEvent.keyDown(t, { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(t, { data: 'olá' })
    fireEvent.input(t, { data: 'olá', inputType: 'insertText', isComposing: false })
    expect(textos()).toEqual([{ type: 'text', text: ' ' }, { type: 'text', text: ',' }, { type: 'text', text: 'olá' }])
    expect(keys().map((k) => [k.phase, k.key])).toEqual([['down', 'a']])
  })
})
