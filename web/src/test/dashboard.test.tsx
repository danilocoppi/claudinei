import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Dashboard } from '../components/Dashboard'
import { useStore } from '../store'

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'AiShiba', path: '/tmp/a', color: '#ff0000', icon: '🐕' }],
    sessions: { l1: { localId: 'l1', projectId: 1, status: 'working', engineSessionId: 'c1', updatedAt: 'x', engine: 'claude' } },
    chat: {}, unread: { l1: 3 }, view: 'dashboard',
  })
})

afterEach(() => cleanup())

describe('Dashboard', () => {
  it('mostra card com nome, ícone, status traduzido e unread', () => {
    render(<Dashboard />)
    expect(screen.getByText('AiShiba')).toBeTruthy()
    expect(screen.getByText('🐕')).toBeTruthy()
    expect(screen.getByText('trabalhando')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('projeto sem sessão mostra botão iniciar', () => {
    useStore.setState({ sessions: {}, unread: {} })
    render(<Dashboard />)
    expect(screen.getByText('Iniciar sessão')).toBeTruthy()
  })

  it('sessão finalizada mostra botão Reviver', () => {
    useStore.setState({
      sessions: { l1: { localId: 'l1', projectId: 1, status: 'stopped', engineSessionId: 'c1', updatedAt: 'x', engine: 'claude' } },
      unread: {},
    })
    render(<Dashboard />)
    expect(screen.getByText('Reviver')).toBeTruthy()
    expect(screen.getByText('finalizada')).toBeTruthy()
  })
})
