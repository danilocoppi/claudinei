import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { Project, SessionInfo } from '../types'

const project = (id: number, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, path: `/tmp/${id}`, icon: '📁', color: '#fff', ...extra })
const session = (projectId: number, status: SessionInfo['status']): SessionInfo =>
  ({ localId: `s${projectId}`, projectId, status, engine: 'claude', engineSessionId: 'c', updatedAt: 'x' })

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    projects: [
      project(1, 'Alpha', { favorite: true, groupId: 10 }),
      project(2, 'Beta', { groupId: 10 }),
      project(3, 'Gama', { favorite: true, sectorId: 20 }),
    ],
    groups: [{ id: 10, name: 'Grupo', sectorId: 20 }],
    sectors: [{ id: 20, name: 'Setor' }],
    sessions: { s1: session(1, 'working'), s2: session(2, 'stopped'), s3: session(3, 'stopped') },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, schedules: [],
    view: 'dashboard', activeLocalId: undefined, railMode: false,
    me: { setupRequired: false, id: 1, username: 'root', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const favoritesSwitch = () => screen.getByRole('checkbox', { name: 'Somente favoritos' }) as HTMLInputElement
const activeSwitch = () => screen.getByRole('checkbox', { name: 'Somente ativos' }) as HTMLInputElement

describe('Sidebar — favoritos', () => {
  it('filtra favoritos em setor/grupo, mantém o inativo favorito e mostra visíveis/total', () => {
    render(<Sidebar />)
    fireEvent.click(favoritesSwitch())
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Gama')).toBeTruthy()
    expect(screen.queryByText('Beta')).toBeNull()
    expect(within(screen.getByTestId('term-group')).getByText('1/2')).toBeTruthy()
    expect(within(screen.getByTestId('term-sector')).getByText('2/3')).toBeTruthy()
    expect(screen.getAllByTestId('term-card')[0].getAttribute('draggable')).toBe('false')
    expect(localStorage.getItem('claudinei:favoritesOnly')).toBe('1')
  })

  it('combina favoritos e ativos; cada switch pode ser desligado separadamente', () => {
    render(<Sidebar />)
    fireEvent.click(favoritesSwitch())
    fireEvent.click(activeSwitch())
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText('Gama')).toBeNull()
    expect(screen.queryByText('Beta')).toBeNull()
    fireEvent.click(activeSwitch())
    expect(screen.getByText('Gama')).toBeTruthy()
    fireEvent.click(favoritesSwitch())
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('favoritar e desfavoritar pelo cartão grava no servidor sem abrir o terminal', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/favorite')) {
        const favorite = JSON.parse(String(init?.body)).favorite
        return new Response(JSON.stringify({ ...project(2, 'Beta'), favorite }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Favoritar Beta' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remover Beta dos favoritos' }).getAttribute('aria-pressed')).toBe('true'))
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === '/api/projects/2/favorite' && JSON.parse(String(init?.body)).favorite === true)).toBe(true)
    fireEvent.click(favoritesSwitch())
    expect(screen.getByText('Beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remover Beta dos favoritos' }))
    await waitFor(() => expect(screen.queryByText('Beta')).toBeNull())
  })

  it('erro de gravação restaura a estrela e o cartão filtrado', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/favorite')
        ? new Response(JSON.stringify({ error: 'falha' }), { status: 500 })
        : new Response('{}', { status: 200 }))
    render(<Sidebar />)
    fireEvent.click(favoritesSwitch())
    fireEvent.click(screen.getByRole('button', { name: 'Remover Alpha dos favoritos' }))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível salvar o favorito/)
    expect(screen.getByRole('button', { name: 'Remover Alpha dos favoritos' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('restaura o filtro e explica a lista vazia sem confundir com falta de terminais', () => {
    localStorage.setItem('claudinei:favoritesOnly', '1')
    useStore.setState({ projects: [project(2, 'Beta')], groups: [], sectors: [] })
    render(<Sidebar />)
    expect(favoritesSwitch().checked).toBe(true)
    expect(screen.getByText('Nenhum terminal favorito ainda.')).toBeTruthy()
    fireEvent.click(activeSwitch())
    expect(screen.getByText('Nenhum terminal atende aos filtros.')).toBeTruthy()
  })
})
