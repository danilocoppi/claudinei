import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { Project } from '../types'

const project = (id: number, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, path: `/tmp/${id}`, icon: '📁', color: '#fff', ...extra })

const PROJECTS = [
  project(1, 'Vaexa - Admin', { groupId: 10 }),
  project(2, 'Vaexa - Backend', { groupId: 10 }),
  project(3, 'AIFinex - Frontend', { sectorId: 20 }),
  project(4, 'Azivon - BACKEND', { favorite: true }),
  project(5, 'Operação Noturna'),
]

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    projects: PROJECTS,
    groups: [{ id: 10, name: 'Veaxa', sectorId: 20 }],
    sectors: [{ id: 20, name: 'Daily Work' }],
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, schedules: [], engines: [],
    view: 'dashboard', activeLocalId: undefined, railMode: false,
    me: { setupRequired: false, id: 1, username: 'root', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const search = () => screen.getByRole('searchbox', { name: 'Buscar terminais' }) as HTMLInputElement
const names = () => screen.queryAllByTestId('term-card').map((c) => c.querySelector('.term-card__name')?.textContent)

describe('Sidebar — busca', () => {
  it('filtra pelo trecho em qualquer posição do nome, sem diferenciar maiúsculas', () => {
    render(<Sidebar />)
    fireEvent.change(search(), { target: { value: 'backend' } })
    expect(names()).toEqual(['Vaexa - Backend', 'Azivon - BACKEND'])
    expect(within(screen.getByTestId('term-group')).getByText('1/2')).toBeTruthy()
    expect(within(screen.getByTestId('term-sector')).getByText('1/3')).toBeTruthy()
    // Mesma razão dos outros filtros: arrastar com a lista filtrada embaralharia a ordem.
    expect(screen.getAllByTestId('term-card')[0].getAttribute('draggable')).toBe('false')
  })

  it('ignora acentos e acha pelo nome do grupo', () => {
    render(<Sidebar />)
    fireEvent.change(search(), { target: { value: 'operacao' } })
    expect(names()).toEqual(['Operação Noturna'])
    fireEvent.change(search(), { target: { value: 'veaxa' } })
    expect(names()).toEqual(['Vaexa - Admin', 'Vaexa - Backend'])
  })

  it('abre grupos e setores fechados enquanto busca, sem mexer no que ficou salvo', () => {
    localStorage.setItem('claudinei:collapsedGroups', '[10]')
    localStorage.setItem('claudinei:collapsedSectors', '[20]')
    render(<Sidebar />)
    expect(screen.queryByText('Vaexa - Backend')).toBeNull()
    fireEvent.change(search(), { target: { value: 'backend' } })
    expect(screen.getByText('Vaexa - Backend')).toBeTruthy()
    expect(localStorage.getItem('claudinei:collapsedGroups')).toBe('[10]')
    expect(localStorage.getItem('claudinei:collapsedSectors')).toBe('[20]')
    fireEvent.change(search(), { target: { value: '' } })
    expect(screen.queryByText('Vaexa - Backend')).toBeNull()
  })

  it('o × e o Escape limpam a busca; a busca não é guardada no navegador', () => {
    render(<Sidebar />)
    fireEvent.change(search(), { target: { value: 'backend' } })
    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }))
    expect(search().value).toBe('')
    expect(names()).toHaveLength(5)
    fireEvent.change(search(), { target: { value: 'admin' } })
    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(search().value).toBe('')
    expect(Object.keys(localStorage).some((k) => localStorage.getItem(k)?.includes('admin'))).toBe(false)
  })

  it('explica a lista vazia, inclusive quando um filtro ligado esconde o resultado', () => {
    render(<Sidebar />)
    fireEvent.change(search(), { target: { value: 'zzz' } })
    expect(screen.getByText('Nenhum terminal encontrado para “zzz”.')).toBeTruthy()
    fireEvent.change(search(), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Somente favoritos' }))
    expect(screen.getByText('Nenhum terminal com “admin” nos filtros ligados.')).toBeTruthy()
  })

  it('na régua, onde o campo não aparece, a busca não esconde nada', () => {
    const { rerender } = render(<Sidebar />)
    fireEvent.change(search(), { target: { value: 'backend' } })
    useStore.setState({ railMode: true })
    rerender(<Sidebar />)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByTitle('Operação Noturna')).toBeTruthy()
  })
})

describe('Sidebar — terminal temporário', () => {
  const scratchButton = () => screen.getByRole('button', { name: 'Terminal temporário' })

  const created = project(9, 'Temporário 04/10 19:42', { path: '/home/u/.claudinei/scratch/temp-20261004-194210', icon: '🧪' })
  const modalDeSessao = () => screen.getByRole('heading', { name: 'Nova sessão' }).closest('.glass') as HTMLElement
  const posts = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([u]) => String(u))
  const servidor = (scratch: () => Response) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    if (u === '/api/projects/scratch' && init?.method === 'POST') return scratch()
    if (u === '/api/projects/9/sessions' && init?.method === 'POST') {
      return new Response(JSON.stringify({ localId: 'nova', projectId: 9, status: 'starting', engine: 'claude' }), { status: 201 })
    }
    if (u === '/api/projects') return new Response(JSON.stringify([...PROJECTS, created]), { status: 200 })
    return new Response('[]', { status: 200 })
  })

  it('abre a escolha da sessão sem criar nada; cancelar não deixa terminal nenhum', async () => {
    const fetcher = servidor(() => new Response(JSON.stringify(created), { status: 201 }))
    render(<Sidebar />)
    fireEvent.click(scratchButton())
    const modal = screen.getByRole('heading', { name: 'Nova sessão' }).closest('.glass') as HTMLElement
    expect(within(modal).getByText(/^Temporário \S+ \S+/)).toBeTruthy()
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('heading', { name: 'Nova sessão' })).toBeNull()
    expect(posts(fetcher)).toEqual([])
    expect(useStore.getState().projects.map((p) => p.id)).not.toContain(9)
  })

  it('iniciar a sessão cria o terminal e só então a sessão, nessa ordem', async () => {
    const fetcher = servidor(() => new Response(JSON.stringify(created), { status: 201 }))
    render(<Sidebar />)
    fireEvent.change(search(), { target: { value: 'zzz' } })
    fireEvent.click(scratchButton())
    fireEvent.click(within(modalDeSessao()).getByRole('button', { name: 'Iniciar sessão' }))
    await waitFor(() => expect(posts(fetcher)).toEqual(['/api/projects/scratch', '/api/projects/9/sessions']))
    const body = JSON.parse(String(fetcher.mock.calls.find(([u]) => String(u) === '/api/projects/scratch')![1]?.body))
    expect(body.name).toMatch(/^Temporário \S+ \S+/)
    expect(body.path).toBeUndefined()
    await waitFor(() => expect(useStore.getState().projects.map((p) => p.id)).toContain(9))
    // A busca sai do caminho para o terminal novo não nascer escondido.
    expect(search().value).toBe('')
    await waitFor(() => expect(useStore.getState().activeLocalId).toBe('nova'))
  })

  it('sessão recusada depois de criar: tentar de novo usa o mesmo terminal, não cria outro', async () => {
    let tentativas = 0
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url)
      if (u === '/api/projects/scratch') return new Response(JSON.stringify(created), { status: 201 })
      if (u === '/api/projects/9/sessions') {
        return ++tentativas === 1
          ? new Response(JSON.stringify({ error: 'engine indisponível' }), { status: 500 })
          : new Response(JSON.stringify({ localId: 'nova', projectId: 9, status: 'starting', engine: 'claude' }), { status: 201 })
      }
      if (u === '/api/projects') return new Response(JSON.stringify([...PROJECTS, created]), { status: 200 })
      return new Response('[]', { status: 200 })
    })
    render(<Sidebar />)
    fireEvent.click(scratchButton())
    fireEvent.click(within(modalDeSessao()).getByRole('button', { name: 'Iniciar sessão' }))
    await waitFor(() => expect(within(modalDeSessao()).getByText(/engine indisponível/)).toBeTruthy())
    await waitFor(() => expect((within(modalDeSessao()).getByRole('button', { name: 'Iniciar sessão' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(modalDeSessao()).getByRole('button', { name: 'Iniciar sessão' }))
    await waitFor(() => expect(useStore.getState().activeLocalId).toBe('nova'))
    expect(posts(fetcher)).toEqual(['/api/projects/scratch', '/api/projects/9/sessions', '/api/projects/9/sessions'])
  })

  it('falha na criação aparece no modal e não inicia sessão', async () => {
    const fetcher = servidor(() => new Response(JSON.stringify({ error: 'sem espaço em disco' }), { status: 500 }))
    render(<Sidebar />)
    fireEvent.click(scratchButton())
    fireEvent.click(within(modalDeSessao()).getByRole('button', { name: 'Iniciar sessão' }))
    const modal = screen.getByRole('heading', { name: 'Nova sessão' }).closest('.glass') as HTMLElement
    await waitFor(() => expect(within(modal).getByText(/sem espaço em disco/)).toBeTruthy())
    expect(posts(fetcher)).toEqual(['/api/projects/scratch'])
  })

  it('não aparece para quem não é admin', () => {
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false } })
    render(<Sidebar />)
    expect(screen.queryByRole('button', { name: 'Terminal temporário' })).toBeNull()
  })
})
