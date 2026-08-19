import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { EngineMeta, Project, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: [''], efforts: ['auto'], permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}

const proj = (id: number, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, path: `/tmp/${id}`, color: '#fff', icon: '📁', ...extra })

const sess = (localId: string, projectId: number, status: SessionInfo['status']): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

/**
 * Cenário-base dos três níveis:
 *   Setor 100 ├── Grupo 10 └── Terminal 1 (Alpha)
 *             └── Terminal 2 (Beta, solto no setor)
 *   Grupo 20 └── Terminal 3 (Gama)      ← raiz
 *   Terminal 4 (Delta)                  ← raiz
 */
const setup = (over: Partial<ReturnType<typeof useStore.getState>> = {}) => {
  useStore.setState({
    projects: [
      proj(1, 'Alpha', { groupId: 10, sortOrder: 2 }),
      proj(2, 'Beta', { sectorId: 100, sortOrder: 3 }),
      proj(3, 'Gama', { groupId: 20, sortOrder: 5 }),
      proj(4, 'Delta', { sortOrder: 6 }),
    ],
    groups: [
      { id: 10, name: 'Backend', icon: '🗂️', color: '#7c5cff', sectorId: 100, sortOrder: 1 },
      { id: 20, name: 'Infra', icon: '🗂️', color: '#7c5cff', sortOrder: 4 },
    ],
    sectors: [{ id: 100, name: 'Produto', icon: '🏢', color: '#58c4dc', sortOrder: 0 }],
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined, engines: [CLAUDE],
    ...over,
  })
  localStorage.removeItem('claudinei:collapsedGroups')
  localStorage.removeItem('claudinei:collapsedSectors')
  localStorage.removeItem('claudinei:activeOnly')
}

beforeEach(() => setup())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** Fetch que devolve JSON vazio para tudo (usage, sidebar-order, …). */
const stubFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(
  async () => new Response(JSON.stringify({ projects: [], groups: [], sectors: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))

describe('Sidebar com setores', () => {
  it('renderiza os três níveis: setor contendo grupo e terminal solto', () => {
    render(<Sidebar />)
    const sector = screen.getByTestId('term-sector')
    expect(within(sector).getByText('Produto')).toBeTruthy()
    expect(within(sector).getByText('Backend')).toBeTruthy()
    expect(within(sector).getByText('Alpha')).toBeTruthy()
    expect(within(sector).getByText('Beta')).toBeTruthy()
    // o que está na raiz NÃO entra no setor
    expect(within(sector).queryByText('Infra')).toBeNull()
    expect(within(sector).queryByText('Delta')).toBeNull()
  })

  it('não repete na raiz o grupo e o terminal que vivem dentro do setor', () => {
    render(<Sidebar />)
    expect(screen.getAllByText('Backend')).toHaveLength(1)
    expect(screen.getAllByText('Beta')).toHaveLength(1)
  })

  it('conta TODOS os terminais do setor, inclusive os dentro de grupos', () => {
    render(<Sidebar />)
    const header = screen.getByTestId('term-sector').querySelector('.term-sector__header')!
    // Alpha (no grupo) + Beta (solto) = 2
    expect(within(header as HTMLElement).getByText('2')).toBeTruthy()
  })

  it('colapsa o setor ao clicar no cabeçalho, escondendo grupos e terminais', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('Produto'))
    expect(screen.queryByText('Backend')).toBeNull()
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(screen.queryByText('Beta')).toBeNull()
    // a raiz segue visível
    expect(screen.getByText('Delta')).toBeTruthy()
  })

  it('com "somente ativos", esconde o setor sem nenhum terminal ativo e mostra ativos/total', () => {
    setup({ sessions: { s1: sess('s1', 1, 'working'), s4: sess('s4', 4, 'working') } })
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('Somente ativos'))
    const header = screen.getByTestId('term-sector').querySelector('.term-sector__header')!
    expect(within(header as HTMLElement).getByText('1/2')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText('Beta')).toBeNull()   // parado, sai
    expect(screen.queryByText('Infra')).toBeNull()  // grupo sem ativo, some
    expect(screen.getByText('Delta')).toBeTruthy()
  })

  it('arrastar terminal da raiz para o setor manda-o para dentro dele', async () => {
    const spy = stubFetch()
    render(<Sidebar />)
    const delta = screen.getAllByTestId('term-card').find((c) => within(c).queryByText('Delta'))!
    fireEvent.dragStart(delta)
    fireEvent.drop(screen.getByTestId('term-sector'))
    await vi.waitFor(() => {
      const call = spy.mock.calls.find(([u]) => String(u) === '/api/sidebar-order')
      expect(call).toBeTruthy()
      const body = JSON.parse(String((call![1] as RequestInit).body))
      const sector = body.entries.find((e: any) => e.kind === 'sector')
      expect(sector.children).toContainEqual({ kind: 'project', id: 4 })
    })
  })

  it('arrastar grupo da raiz para o setor aninha o grupo com os filhos dele', async () => {
    const spy = stubFetch()
    render(<Sidebar />)
    const infra = screen.getAllByTestId('term-group').find((g) => within(g).queryByText('Infra'))!
    fireEvent.dragStart(infra.querySelector('.term-group__header')!)
    fireEvent.drop(screen.getByTestId('term-sector'))
    await vi.waitFor(() => {
      const call = spy.mock.calls.find(([u]) => String(u) === '/api/sidebar-order')
      expect(call).toBeTruthy()
      const body = JSON.parse(String((call![1] as RequestInit).body))
      const sector = body.entries.find((e: any) => e.kind === 'sector')
      expect(sector.children).toContainEqual({ kind: 'group', id: 20, children: [3] })
      // e o grupo não fica também na raiz
      expect(body.entries.some((e: any) => e.kind === 'group' && e.id === 20)).toBe(false)
    })
  })

  it('soltar no cabeçalho "Terminais" tira o grupo do setor e o devolve à raiz', async () => {
    const spy = stubFetch()
    render(<Sidebar />)
    const backend = screen.getAllByTestId('term-group').find((g) => within(g).queryByText('Backend'))!
    fireEvent.dragStart(backend.querySelector('.term-group__header')!)
    fireEvent.drop(screen.getByText('Terminais').closest('.term-header')!)
    await vi.waitFor(() => {
      const call = spy.mock.calls.find(([u]) => String(u) === '/api/sidebar-order')
      expect(call).toBeTruthy()
      const body = JSON.parse(String((call![1] as RequestInit).body))
      expect(body.entries[0]).toEqual({ kind: 'group', id: 10, children: [1] })
      const sector = body.entries.find((e: any) => e.kind === 'sector')
      expect(sector.children.some((c: any) => c.kind === 'group' && c.id === 10)).toBe(false)
    })
  })

  it('o menu do terminal oferece mover para setor', async () => {
    const spy = stubFetch()
    render(<Sidebar />)
    const delta = screen.getAllByTestId('term-card').find((c) => within(c).queryByText('Delta'))!
    fireEvent.click(within(delta).getByTitle('Opções'))
    // Setor virou dropdown: escolher é mudar o select, não clicar num item
    const pop = within(document.querySelector('.sess-pop') as HTMLElement)
    fireEvent.change(pop.getByTestId('menu-sector'), { target: { value: '100' } })
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/api/projects/4/sector', expect.objectContaining({ method: 'PATCH' })))
  })

  it('o menu do setor permite editar e excluir', () => {
    render(<Sidebar />)
    const header = screen.getByTestId('term-sector').querySelector('.term-sector__header')!
    fireEvent.click(within(header as HTMLElement).getByTitle('Opções'))
    expect(screen.getByText('Editar setor')).toBeTruthy()
    expect(screen.getByText('Excluir setor')).toBeTruthy()
  })

  it('o cabeçalho tem o botão de criar setor', () => {
    render(<Sidebar />)
    expect(screen.getByTitle('Novo setor')).toBeTruthy()
  })
})
