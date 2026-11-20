import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { UndoToast } from '../components/UndoToast'
import { useStore } from '../store'
import type { Project, SessionInfo, TriageItem } from '../types'

const project = (id: number, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, path: `/tmp/${id}`, icon: '📁', color: '#fff', ...extra })
const session = (projectId: number, status: SessionInfo['status']): SessionInfo =>
  ({ localId: `s${projectId}`, projectId, status, engine: 'claude', engineSessionId: 'c', updatedAt: 'x' })
// A ⭐ e "Somente fixados" leem o pin do usuário (triagem), não `projects.favorite`.
const pin = (projectId: number, pinned = true): TriageItem => ({ projectId, pinned, settled: false, snoozedUntil: null })

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    projects: [
      // `favorite` de propósito trocado em relação ao pin: a interface não o lê mais.
      project(1, 'Alpha', { groupId: 10 }),
      project(2, 'Beta', { favorite: true, groupId: 10 }),
      project(3, 'Gama', { sectorId: 20 }),
    ],
    groups: [{ id: 10, name: 'Grupo', sectorId: 20 }],
    sectors: [{ id: 20, name: 'Setor' }],
    // Alpha "idle" (vivo) em vez de "working": a faixa Trabalhando repetiria o nome.
    sessions: { s1: session(1, 'idle'), s2: session(2, 'stopped'), s3: session(3, 'stopped') },
    triage: { 1: pin(1), 3: pin(3) },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, schedules: [],
    view: 'dashboard', activeLocalId: undefined, railMode: false,
    me: { setupRequired: false, id: 1, username: 'root', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const pinnedSwitch = () => screen.getByRole('checkbox', { name: 'Somente fixados' }) as HTMLInputElement
const activeSwitch = () => screen.getByRole('checkbox', { name: 'Somente ativos' }) as HTMLInputElement
const pinnedSection = () => within(screen.getByTestId('triage-pinned'))

describe('Sidebar — fixados', () => {
  it('"somente fixados" deixa só a seção Fixados; o fixado inativo fica', () => {
    render(<Sidebar />)
    fireEvent.click(pinnedSwitch())
    expect(pinnedSection().getByText('Alpha')).toBeTruthy()
    expect(pinnedSection().getByText('Gama')).toBeTruthy()
    expect(screen.queryByText('Beta')).toBeNull()
    // O setor e o grupo esvaziaram (os fixados moram na seção deles): somem.
    expect(screen.queryByTestId('term-group')).toBeNull()
    expect(screen.queryByTestId('term-sector')).toBeNull()
    // Os Fixados estão inteiros na tela: a ordem do usuário continua arrastável.
    expect(screen.getAllByTestId('term-card').every((c) => c.getAttribute('draggable') === 'true')).toBe(true)
    expect(localStorage.getItem('claudinei:favoritesOnly')).toBe('1')
  })

  it('sem filtro, os fixados saem do grupo e do setor, que contam visíveis/total', () => {
    render(<Sidebar />)
    expect(pinnedSection().getByText('Alpha')).toBeTruthy()
    expect(within(screen.getByTestId('term-group')).getByText('1/2')).toBeTruthy()
    expect(within(screen.getByTestId('term-sector')).getByText('1/3')).toBeTruthy()
  })

  it('combina fixados e ativos; cada switch pode ser desligado separadamente', () => {
    render(<Sidebar />)
    fireEvent.click(pinnedSwitch())
    fireEvent.click(activeSwitch())
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText('Gama')).toBeNull()
    expect(screen.queryByText('Beta')).toBeNull()
    fireEvent.click(activeSwitch())
    expect(screen.getByText('Gama')).toBeTruthy()
    fireEvent.click(pinnedSwitch())
    expect(screen.getByText('Beta')).toBeTruthy()
  })

  it('fixar e desafixar pela ⭐ grava a triagem do usuário sem abrir o terminal', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/triage')) {
        const pinned = JSON.parse(String(init?.body)).pinned
        return new Response(JSON.stringify(pin(2, pinned)), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Fixar Beta' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Desafixar Beta' }).getAttribute('aria-pressed')).toBe('true'))
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === '/api/projects/2/triage' && JSON.parse(String(init?.body)).pinned === true)).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/favorite'))).toBe(false)
    expect(useStore.getState().view).toBe('dashboard')
    fireEvent.click(pinnedSwitch())
    expect(screen.getByText('Beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Desafixar Beta' }))
    await waitFor(() => expect(screen.queryByText('Beta')).toBeNull())
  })

  it('erro de gravação restaura a estrela e o cartão filtrado', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/triage')
        ? new Response(JSON.stringify({ error: 'falha' }), { status: 500 })
        : new Response('{}', { status: 200 }))
    render(<><Sidebar /><UndoToast /></>)
    fireEvent.click(pinnedSwitch())
    fireEvent.click(screen.getByRole('button', { name: 'Desafixar Alpha' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível fixar ou desafixar/))
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Desafixar Alpha' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('restaura o filtro e explica a lista vazia sem confundir com falta de terminais', () => {
    localStorage.setItem('claudinei:favoritesOnly', '1')
    useStore.setState({ projects: [project(2, 'Beta')], groups: [], sectors: [] })
    render(<Sidebar />)
    expect(pinnedSwitch().checked).toBe(true)
    expect(screen.getByText('Nenhum terminal fixado ainda.')).toBeTruthy()
    fireEvent.click(activeSwitch())
    expect(screen.getByText('Nenhum terminal atende aos filtros.')).toBeTruthy()
  })
})
