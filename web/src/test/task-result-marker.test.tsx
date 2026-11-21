import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore, progressKey } from '../store'
import type { SessionInfo, TerminalState } from '../types'

/**
 * Marca "↩" no cartão da lateral: tarefas que o terminal delegou terminaram e o
 * resultado espera o terminal (parado ou segurado pelo limite). O aviso "A tarefa
 * terminou" só aparece com a aba do terminal aberta; aberta a página depois de o
 * terminal parar, a marca é o que diz em qual cartão procurar.
 */
const estado = (o: Partial<TerminalState> = {}): TerminalState =>
  ({ projectId: 1, engine: 'claude', autostart: false, autoResume: false, interruption: null, autoResumeLimit: false, usageLimit: null, taskResults: [], taskResultsHeld: false, goal: null, ...o })
const comResultado = (o: Partial<TerminalState> = {}): TerminalState =>
  estado({ taskResults: [{ id: 7, toProjectName: 'Beta', status: 'completed' }], ...o })
const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', model: 'opus', permissionMode: 'bypassPermissions', engine: 'claude', ...o })

const cartao = (nome: string) => screen.getAllByTestId('term-card').find((c) => within(c).queryByText(nome))!

beforeEach(() => {
  localStorage.removeItem('claudinei:collapsedCards')
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#ff0000', icon: '📁' },
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#00ff00', icon: '📁' },
    ],
    groups: [], sectors: [], schedules: [],
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined, terminalStates: {},
  })
})
afterEach(() => cleanup())

describe('marca de resultado de tarefa no cartão', () => {
  it('terminal parado com resultado pendente mostra a marca; o outro cartão não', () => {
    useStore.setState({ terminalStates: { [progressKey(1, 'codex')]: comResultado({ engine: 'codex' }) } })
    render(<Sidebar />)
    const marca = within(cartao('Alpha')).getByTestId('task-result-marker')
    expect(marca.getAttribute('title')).toBe('Uma tarefa delegada terminou; abra o terminal ou ligue-o para entregar o resultado')
    expect(within(cartao('Beta')).queryByTestId('task-result-marker')).toBeNull()
  })

  it('com a sessão do motor viva e livre não marca (o Claudinei entrega sozinho); segurada pelo limite, marca', () => {
    useStore.setState({
      sessions: { s1: sess() },
      terminalStates: { [progressKey(1, 'claude')]: comResultado() },
    })
    render(<Sidebar />)
    expect(screen.queryByTestId('task-result-marker')).toBeNull()
    act(() => useStore.getState().setTerminalState(comResultado({ taskResultsHeld: true })))
    expect(within(cartao('Alpha')).getByTestId('task-result-marker')).toBeTruthy()
  })

  it('a marca some quando os resultados saem', () => {
    useStore.setState({ terminalStates: { [progressKey(1, 'claude')]: comResultado() } })
    render(<Sidebar />)
    expect(screen.getByTestId('task-result-marker')).toBeTruthy()
    act(() => useStore.getState().setTerminalState(estado()))
    expect(screen.queryByTestId('task-result-marker')).toBeNull()
  })
})
