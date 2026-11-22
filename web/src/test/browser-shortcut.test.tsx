import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
vi.mock('../notifications', () => ({ initNotifications: vi.fn(), notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import App from '../App'
import { AppearancePanel } from '../components/AppearancePanel'
import { useStore } from '../store'
import { useSideStore } from '../branch/sideStore'
import { useBrowserStore } from '../browser/browserStore'
import { useColumnStore } from '../browser/columnStore'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

/**
 * Alt+B (`view.browser`, editável) e o botão do cabeçalho do chat abrem e
 * fecham a vista Navegador da coluna da direita. Sem aba no terminal, abrem
 * uma antes (`POST …/browser`). No terminal interativo a tecla é do shell.
 */

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...o })
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const ALPHA = { id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }
const BROWSER = '/api/projects/1/terminals/claude/browser'
const stubFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input)
  if (url.includes('/api/me')) return json({ setupRequired: false, id: 1, username: 'u', isAdmin: true })
  if (url === '/api/projects') return json([ALPHA])
  if (url === '/api/browser/tabs') return json({ tabs: [] })
  if (url === BROWSER) return json({ ok: true })
  if (url.includes('/history')) return json({ events: [], before: 0, atStart: true })
  return json([])
})
let fetchSpy: ReturnType<typeof stubFetch>
const posts = () => fetchSpy.mock.calls.filter(([u, i]) => String(u) === BROWSER && i?.method === 'POST')

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  fetchSpy = stubFetch()
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null, readAt: {} })
  useBrowserStore.setState({ tabs: {}, failed: {} })
  useColumnStore.setState({ view: 'progress', previous: null, fullscreen: false, marks: {}, widths: {} })
  useStore.setState({
    authStatus: 'ready',
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    projects: [ALPHA],
    sessions: { a: sess() },
    chat: { a: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
    engines: [CLAUDE],
    terminalStates: {},
    view: 'chat', activeLocalId: 'a',
    progressOpen: false,
    zen: false,
  })
  useStore.getState().setKeybindings({})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const altB = (alvo: Element | Window = window) => fireEvent.keyDown(alvo, { key: 'b', code: 'KeyB', altKey: true })
const coluna = () => document.querySelector<HTMLElement>('aside.right-column')

describe('Alt+B e o botão do Navegador', () => {
  it('Alt+B abre e fecha a vista', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.chat-layout')).toBeTruthy())
    expect(coluna()).toBeNull()

    const naoCancelado = altB()
    expect(naoCancelado).toBe(false) // preventDefault: a tecla não segue para a página
    await waitFor(() => expect(coluna()?.dataset.view).toBe('browser'))
    expect(posts()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Navegador' }).getAttribute('aria-pressed')).toBe('true')

    altB()
    await waitFor(() => expect(coluna()).toBeNull())
    // Com a aba já aberta, abrir de novo não pede outra.
    altB()
    await waitFor(() => expect(coluna()?.dataset.view).toBe('browser'))
    expect(posts()).toHaveLength(1)

    // O botão do cabeçalho faz o mesmo.
    fireEvent.click(screen.getByRole('button', { name: 'Navegador' }))
    await waitFor(() => expect(coluna()).toBeNull())
    expect(screen.getByRole('button', { name: 'Navegador' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('no terminal interativo Alt+B não age', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.chat-layout')).toBeTruthy())
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const textarea = document.createElement('textarea')
    xterm.appendChild(textarea)
    document.body.appendChild(xterm)
    try {
      textarea.focus()
      // Lá o Alt+B é do shell ou do programa no terminal, não da página.
      expect(altB(textarea)).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      expect(coluna()).toBeNull()
      expect(posts()).toHaveLength(0)
    } finally {
      xterm.remove()
    }
  })

  it('com um modal aberto (a tela cheia da página) Alt+B não age', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.chat-layout')).toBeTruthy())
    // Como o PageFullscreen: um aria-modal sobre a página, com o foco nele.
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    const botao = document.createElement('button')
    modal.appendChild(botao)
    document.body.appendChild(modal)
    try {
      for (const alvo of [botao, window] as const) {
        if (alvo === botao) botao.focus()
        // A tecla segue para o modal: nada abre por trás dele.
        expect(altB(alvo)).toBe(true)
      }
      await new Promise((r) => setTimeout(r, 0))
      expect(coluna()).toBeNull()
      expect(posts()).toHaveLength(0)
    } finally {
      modal.remove()
    }
    // Fechado o modal, o atalho volta a valer.
    altB()
    await waitFor(() => expect(coluna()?.dataset.view).toBe('browser'))
  })

  it('a tela cheia do próprio Navegador não é modal: Alt+B a fecha', async () => {
    // A aba já existe no servidor: a lista que chega ao montar a mantém.
    const base = fetchSpy.getMockImplementation()!
    fetchSpy.mockImplementation(async (input, init) =>
      String(input) === '/api/browser/tabs' ? json({ tabs: [{ projectId: 1, engine: 'claude' }] }) : base(input, init))
    useBrowserStore.setState({ tabs: { '1:claude': true }, failed: {} })
    useColumnStore.setState({ view: 'browser', fullscreen: true })
    useStore.setState({ progressOpen: true })
    render(<App />)
    await waitFor(() => expect(coluna()?.dataset.view).toBe('browser'))
    expect(coluna()?.className).toContain('right-column--full')
    expect(document.querySelector('[aria-modal="true"]')).toBeNull()
    expect(altB()).toBe(false)
    await waitFor(() => expect(coluna()).toBeNull())
  })

  it('a aba Atalhos lista \'view.browser\' com Alt+B editável', () => {
    useStore.setState({ appearance: DEFAULT_APPEARANCE })
    render(<AppearancePanel onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('ap-tab-shortcuts'))
    const linha = screen.getByTestId('sc-row-view.browser')
    expect(linha.textContent).toContain('Abrir e fechar o Navegador')
    const combo = screen.getByTestId('sc-combo-view.browser')
    expect(combo.textContent).toBe('Alt+B')
    fireEvent.click(combo)
    expect(combo.textContent).toBe('Gravando…')
  })
})
