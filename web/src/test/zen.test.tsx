import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import App from '../App'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo, TerminalState } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...o })
const interrompido: TerminalState = {
  projectId: 1, engine: 'claude', autostart: false, autoResume: false,
  interruption: { at: '2026-11-20T10:00:00.000Z', reason: 'off' }, autoResumeLimit: false, usageLimit: null,
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/api/me')) return json({ setupRequired: false, id: 1, username: 'u', isAdmin: true })
    return json([])
  })
  useStore.setState({
    authStatus: 'ready',
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    sessions: { a: sess() },
    chat: { a: [] }, unread: {}, streaming: {}, historyLoadedFor: {},
    engines: [CLAUDE],
    terminalStates: { '1:claude': interrompido },
    view: 'chat', activeLocalId: 'a',
    progressOpen: true,
    zen: false,
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const altZ = (target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: 'z', code: 'KeyZ', altKey: true })

const moldura = () => ({
  sidebar: document.querySelector('.sidebar'),
  resizer: document.querySelector('.sidebar-resizer'),
  topbar: document.querySelector('.mobile-topbar'),
  header: document.querySelector('.chat-header'),
  coluna: document.querySelector('aside.progress'),
})

/**
 * Zen esconde só a moldura: lateral, cabeçalho do chat e coluna do acompanhamento.
 * A conversa, o campo e os avisos continuam — é para ler e escrever com menos ruído,
 * não para perder o que pede a atenção do operador.
 */
describe('modo Zen', () => {
  it('Alt+Z esconde lateral, cabeçalho e coluna e mostra o botão de sair', () => {
    render(<App />)
    const antes = moldura()
    expect(antes.sidebar).toBeTruthy()
    expect(antes.resizer).toBeTruthy()
    expect(antes.topbar).toBeTruthy()
    expect(antes.header).toBeTruthy()
    expect(antes.coluna).toBeTruthy()
    expect(document.querySelector('.zen-exit')).toBeNull()

    const naoCancelado = altZ()
    expect(naoCancelado).toBe(false) // preventDefault: a tecla não segue para a página
    const depois = moldura()
    expect(depois.sidebar).toBeNull()
    expect(depois.resizer).toBeNull()
    expect(depois.topbar).toBeNull()
    expect(depois.header).toBeNull()
    expect(depois.coluna).toBeNull()
    expect(screen.getByRole('button', { name: /sair do zen/i })).toBeTruthy()
  })

  it('Alt+Z de novo traz tudo de volta', () => {
    render(<App />)
    altZ()
    altZ()
    const m = moldura()
    expect(m.sidebar).toBeTruthy()
    expect(m.resizer).toBeTruthy()
    expect(m.topbar).toBeTruthy()
    expect(m.header).toBeTruthy()
    expect(m.coluna).toBeTruthy()
    expect(document.querySelector('.zen-exit')).toBeNull()
  })

  it('o botão sair do Zen desliga o modo', () => {
    render(<App />)
    altZ()
    fireEvent.click(screen.getByRole('button', { name: /sair do zen/i }))
    expect(useStore.getState().zen).toBe(false)
    expect(document.querySelector('.sidebar')).toBeTruthy()
    expect(document.querySelector('.chat-header')).toBeTruthy()
    expect(document.querySelector('.zen-exit')).toBeNull()
  })

  it('persiste em localStorage claudinei:zen', async () => {
    render(<App />)
    altZ()
    expect(localStorage.getItem('claudinei:zen')).toBe('1')
    altZ()
    expect(localStorage.getItem('claudinei:zen')).toBe('0')

    // E o estado salvo é o que vale ao recarregar a página.
    localStorage.setItem('claudinei:zen', '1')
    vi.resetModules()
    const recarregado = await import('../store')
    expect(recarregado.useStore.getState().zen).toBe(true)
  })

  it('Alt+Z dentro do terminal interativo não faz nada', () => {
    render(<App />)
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const textarea = document.createElement('textarea')
    xterm.appendChild(textarea)
    document.body.appendChild(xterm)
    try {
      // Lá o Alt+Z é do shell ou do programa no terminal, não da página.
      const naoCancelado = altZ(textarea)
      expect(naoCancelado).toBe(true)
      expect(useStore.getState().zen).toBe(false)
      expect(document.querySelector('.sidebar')).toBeTruthy()
    } finally {
      xterm.remove()
    }
  })

  it('Alt+Z com Ctrl, Meta ou Shift juntos não é o atalho', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', altKey: true, ctrlKey: true })
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', altKey: true, metaKey: true })
    fireEvent.keyDown(window, { key: 'Z', code: 'KeyZ', altKey: true, shiftKey: true })
    expect(useStore.getState().zen).toBe(false)
  })

  it('Alt+Z no campo do chat liga o Zen (o campo não é terminal)', () => {
    render(<App />)
    const campo = document.querySelector('.chat-compose textarea, .chat-compose [contenteditable]')
    expect(campo).toBeTruthy()
    altZ(campo!)
    expect(useStore.getState().zen).toBe(true)
  })

  it('avisos e campo continuam visíveis no Zen', () => {
    render(<App />)
    altZ()
    expect(document.querySelector('.chat-compose')).toBeTruthy()
    expect(document.querySelector('.restart-notice')).toBeTruthy()
  })
})
