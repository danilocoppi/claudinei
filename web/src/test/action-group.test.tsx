import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ActionGroup } from '../components/ActionGroup'
import { ChatView } from '../components/ChatView'
import { useStore } from '../store'
import type { ChatItem, SessionInfo, EngineMeta } from '../types'

const tool = (name = 'Bash'): ChatItem => ({ kind: 'tool_call', id: `t${Math.random()}`, name, input: { command: 'ls' } })

afterEach(() => {
  cleanup()
  useStore.setState({ projects: [], sessions: {}, chat: {}, streaming: {}, historyLoadedFor: {} })
})

describe('ActionGroup', () => {
  const items = [tool('Bash'), tool('Bash'), tool('Read')].map((item, index) => ({ item, index }))

  it('começa recolhido: mostra contagem+resumo, esconde os cards', () => {
    render(<ActionGroup items={items} />)
    expect(screen.getByText('3 ações')).toBeTruthy()
    expect(screen.getByText('Bash ×2 · Read')).toBeTruthy()
    expect(screen.queryByText('ls')).toBeNull()
  })

  it('expande no clique: cada card individual aparece (e continua expansível)', () => {
    render(<ActionGroup items={items} />)
    fireEvent.click(screen.getByText('3 ações'))
    expect(screen.getAllByText('Bash').length).toBe(2)
    // card interno ainda é o ToolCallCard normal: expande individualmente
    fireEvent.click(screen.getAllByText('Bash')[0])
    expect(screen.getAllByText(/ls/).length).toBeGreaterThan(0)
  })
})

describe('ChatView agrupa ações consecutivas', () => {
  const sess = (status: SessionInfo['status']): SessionInfo =>
    ({ localId: 'a', projectId: 1, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })
  const CLAUDE: EngineMeta = {
    id: 'claude', label: 'Claude Code', icon: '✳', models: [''], efforts: ['auto'],
    permissions: ['default'], slashSource: 'protocol', slashCommands: [],
  }

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    useStore.setState({
      projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁' }],
      sessions: { a: sess('needs_attention') },
      chat: { a: [{ kind: 'user_text', text: 'faz' }, tool(), tool(), tool(), tool(), { kind: 'assistant_text', text: 'feito' }] },
      unread: {}, streaming: {}, historyLoadedFor: { a: 'c' }, view: 'chat', activeLocalId: 'a', engines: [CLAUDE],
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('sequência de 4 tools entre mensagens vira "4 ações"', () => {
    render(<ChatView />)
    expect(screen.getByText('4 ações')).toBeTruthy()
    expect(screen.queryByText('ls')).toBeNull()
  })

  it('trabalhando com cauda de ações: última fica visível fora do grupo', () => {
    useStore.setState({
      sessions: { a: sess('working') },
      chat: { a: [{ kind: 'user_text', text: 'faz' }, tool(), tool(), tool(), tool('Grep')] },
    })
    render(<ChatView />)
    expect(screen.getByText('3 ações')).toBeTruthy()
    // a última ação (Grep) continua como card individual visível
    expect(screen.getByText('Grep')).toBeTruthy()
  })
})
