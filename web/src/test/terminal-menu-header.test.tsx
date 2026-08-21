import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { ChatView } from '../components/ChatView'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = {
  localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude',
}

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/home/u/alpha', color: '#7c5cff', icon: 'lucide:terminal', groupId: 10 }],
    groups: [{ id: 10, name: 'Backend' }], sectors: [{ id: 100, name: 'Produto' }],
    schedules: [], sessions: { s1: sess }, chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'c' },
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const body = String(url).includes('/api/local-apps') ? { folder: true, vscode: true, terminal: true } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/**
 * O mesmo menu em dois lugares: no cartão da barra lateral e no título do terminal
 * aberto. Quem está lendo a conversa não devia ter que voltar à lista para
 * renomear o terminal ou abrir a pasta dele.
 */
describe('as três bolinhas no título do terminal aberto', () => {
  it('estão no cabeçalho, ANTES do ícone', () => {
    render(<ChatView />)
    const head = document.querySelector('.chat-header')!
    const botao = within(head as HTMLElement).getByTitle(/opções/i)
    const icone = head.querySelector('.icon')!
    expect(botao.compareDocumentPosition(icone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('abrem o mesmo menu do cartão', async () => {
    render(<ChatView />)
    fireEvent.click(within(document.querySelector('.chat-header') as HTMLElement).getByTitle(/opções/i))
    const pop = within(document.querySelector('.sess-pop') as HTMLElement)
    await vi.waitFor(() => expect(pop.getByText(/abrir pasta/i)).toBeTruthy())
    expect(pop.getByText(/editar/i)).toBeTruthy()
    expect(pop.getByText(/excluir/i)).toBeTruthy()
    expect(document.querySelector('[data-testid="menu-group"]')).toBeTruthy()
  })

  /** Editar é a razão mais provável de abrir isto daqui: renomear o que se está lendo. */
  it('editar abre o formulário do terminal', async () => {
    render(<ChatView />)
    fireEvent.click(within(document.querySelector('.chat-header') as HTMLElement).getByTitle(/opções/i))
    const pop = within(document.querySelector('.sess-pop') as HTMLElement)
    await vi.waitFor(() => expect(pop.getByText(/editar/i)).toBeTruthy())
    fireEvent.click(pop.getByText(/editar/i))
    expect(screen.getByDisplayValue('Alpha')).toBeTruthy()
  })
})
