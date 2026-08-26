import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo, SessionStatus } from '../types'

const ACTIVE_KEY = 'claudinei:activeOnly'

const sess = (localId: string, projectId: number, status: SessionStatus): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: [''], efforts: ['auto'], permissions: [], slashSource: 'protocol', slashCommands: [],
}

/** Alpha (viva) e Beta (parada), ambos soltos. */
const baseState = () => ({
  projects: [
    { id: 1, name: 'Alpha', path: '/tmp/a', color: '#f00', icon: '🅰️' },
    { id: 2, name: 'Beta', path: '/tmp/b', color: '#0f0', icon: '🅱️' },
  ],
  sessions: { s1: sess('s1', 1, 'working'), s2: sess('s2', 2, 'stopped') },
  chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
  view: 'dashboard' as const, activeLocalId: undefined,
  engines: [CLAUDE],
  groups: [],
})

const toggle = () => screen.getByLabelText('Somente ativos')

beforeEach(() => {
  useStore.setState(baseState())
  localStorage.removeItem(ACTIVE_KEY)
  localStorage.removeItem('claudinei:collapsedGroups')
})
afterEach(() => cleanup())

describe('Sidebar — filtro somente ativos', () => {
  it('com o filtro desligado, lista terminais ativos e parados', () => {
    render(<Sidebar />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('ligar o filtro esconde o terminal sem sessão viva e mantém o ativo', () => {
    render(<Sidebar />)
    fireEvent.click(toggle())
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText('Beta')).toBeNull()
  })

  it('desligar o filtro traz o terminal escondido de volta', () => {
    render(<Sidebar />)
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('esconde o grupo inteiro quando nenhum filho está ativo', () => {
    useStore.setState({
      projects: [
        { id: 1, name: 'Alpha', path: '/tmp/a', color: '#f00', icon: '🅰️', groupId: 10 },
        { id: 2, name: 'Beta', path: '/tmp/b', color: '#0f0', icon: '🅱️', groupId: 10 },
      ],
      sessions: { s1: sess('s1', 1, 'stopped'), s2: sess('s2', 2, 'dead') },
      groups: [{ id: 10, name: 'Grupo A' }],
    })
    render(<Sidebar />)
    fireEvent.click(toggle())
    expect(screen.queryByText('Grupo A')).toBeNull()
    expect(screen.queryByText('Alpha')).toBeNull()
  })

  it('mostra o grupo com apenas os filhos ativos e o contador ativos/total', () => {
    useStore.setState({
      projects: [
        { id: 1, name: 'Alpha', path: '/tmp/a', color: '#f00', icon: '🅰️', groupId: 10 },
        { id: 2, name: 'Beta', path: '/tmp/b', color: '#0f0', icon: '🅱️', groupId: 10 },
      ],
      sessions: { s1: sess('s1', 1, 'working'), s2: sess('s2', 2, 'stopped') },
      groups: [{ id: 10, name: 'Grupo A' }],
    })
    render(<Sidebar />)
    expect(screen.getByText('2')).toBeTruthy()          // sem filtro: total puro
    fireEvent.click(toggle())
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText('Beta')).toBeNull()
    expect(screen.getByText('1/2')).toBeTruthy()        // com filtro: ativos/total
  })

  it('esconde grupo vazio (alvo de arraste do admin) com o filtro ligado', () => {
    useStore.setState({ projects: [], sessions: {}, groups: [{ id: 10, name: 'Grupo A' }] })
    render(<Sidebar />)
    expect(screen.getByText('Grupo A')).toBeTruthy()
    fireEvent.click(toggle())
    expect(screen.queryByText('Grupo A')).toBeNull()
  })

  /**
   * O defeito relatado: desligar todas as engines de um terminal e vê-lo seguir na
   * lista de "somente ativos". Ele ficava porque era o terminal ABERTO, e havia um
   * pin para o card não sumir embaixo de quem lia o chat. O pin saiu: um filtro de
   * ativos que mostra um terminal sem agente nenhum mente sobre o que mostra.
   *
   * O que se perde é pequeno — quem desligou sabe que desligou, o chat continua
   * aberto e o ▶ de reviver está nas abas do cabeçalho.
   */
  it('o terminal aberto sai da lista quando suas engines são desligadas', () => {
    useStore.setState({ view: 'chat', activeLocalId: 's2' })
    render(<Sidebar />)
    fireEvent.click(toggle())
    expect(screen.queryByText('Beta')).toBeNull()
  })

  it('persiste o estado do filtro no localStorage', () => {
    render(<Sidebar />)
    fireEvent.click(toggle())
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('1')
    fireEvent.click(toggle())
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('0')
  })

  it('lê o filtro salvo no localStorage ao montar', () => {
    localStorage.setItem(ACTIVE_KEY, '1')
    render(<Sidebar />)
    expect(screen.queryByText('Beta')).toBeNull()
    expect((toggle() as HTMLInputElement).checked).toBe(true)
  })

  it('desabilita o arraste dos cards enquanto o filtro está ligado', () => {
    render(<Sidebar />)
    expect(screen.getAllByTestId('term-card')[0].getAttribute('draggable')).toBe('true')
    fireEvent.click(toggle())
    expect(screen.getAllByTestId('term-card')[0].getAttribute('draggable')).toBe('false')
  })

  it('mostra aviso próprio quando o filtro esconde todos os terminais', () => {
    useStore.setState({ sessions: { s1: sess('s1', 1, 'dead'), s2: sess('s2', 2, 'stopped') } })
    render(<Sidebar />)
    fireEvent.click(toggle())
    expect(screen.getByText(/Nenhum terminal ativo/i)).toBeTruthy()
  })
})
