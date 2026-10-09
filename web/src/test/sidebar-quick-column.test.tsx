import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import type { Project, SessionInfo, SessionStatus } from '../types'

const project = (id: number, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, path: `/tmp/${id}`, icon: '📁', color: '#fff', ...extra })
const sess = (localId: string, projectId: number, status: SessionStatus, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...extra })
const at = (min: number) => `2026-10-09T12:${String(min).padStart(2, '0')}:00.000Z`

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  useStore.setState({
    projects: [project(1, 'Vaexa - Admin'), project(2, 'AIFinex'), project(3, 'Azivon - Backend'), project(4, 'NFE')],
    groups: [], sectors: [],
    sessions: {
      a: sess('a', 1, 'idle', { lastInputAt: at(10) }),
      b: sess('b', 2, 'stopped', { lastInputAt: at(59) }),
      c: sess('c', 3, 'needs_attention', { lastInputAt: at(1) }),
      d: sess('d', 4, 'in_terminal', { lastInputAt: at(30) }),
    },
    chat: {}, unread: { c: 22 }, streaming: {}, historyLoadedFor: {}, schedules: [], engines: [],
    view: 'dashboard', activeLocalId: undefined, railMode: false,
    me: { setupRequired: false, id: 1, username: 'root', isAdmin: true },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const coluna = () => screen.getByRole('navigation', { name: 'Terminais ligados' })
const rostos = () => within(coluna()).getAllByRole('button')
const nomes = () => rostos().map((b) => b.getAttribute('aria-label'))

describe('Sidebar — coluna de rostinhos', () => {
  it('mostra só os ligados: quem pede ação primeiro, depois o que você mexeu por último', () => {
    render(<Sidebar />)
    expect(nomes()).toEqual([
      'Azivon - Backend — aguardando você',
      'NFE — no terminal',
      'Vaexa - Admin — ociosa',
    ])
  })

  it('cada rostinho traz o rosto do estado, o ícone do terminal e o contador', () => {
    render(<Sidebar />)
    const primeiro = rostos()[0]
    expect(primeiro.querySelector('.agent-face')).toBeTruthy()
    expect(primeiro.querySelector('.rail-ico')).toBeTruthy()
    expect(primeiro.querySelector('.sonar')).toBeTruthy()
    expect(within(primeiro).getByText('22')).toBeTruthy()
    expect(rostos()[2].querySelector('.sonar')).toBeNull()
  })

  it('o clique abre como o cartão: chat, ou o terminal quando a sessão está nele', () => {
    render(<Sidebar />)
    fireEvent.click(rostos()[2])
    expect(useStore.getState()).toMatchObject({ view: 'chat', activeLocalId: 'a' })
    expect(rostos()[2].getAttribute('aria-current')).toBe('true')
    fireEvent.click(rostos()[1])
    expect(useStore.getState()).toMatchObject({ view: 'terminal', activeLocalId: 'd' })
  })

  it('a busca e os filtros mexem na lista, não na coluna', () => {
    render(<Sidebar />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar terminais' }), { target: { value: 'nfe' } })
    expect(nomes()).toHaveLength(3)
  })

  it('sem nenhum terminal ligado, a coluna não aparece', () => {
    useStore.setState({ sessions: { b: sess('b', 2, 'stopped') } })
    render(<Sidebar />)
    expect(screen.queryByRole('navigation', { name: 'Terminais ligados' })).toBeNull()
  })

  it('com a lateral recolhida, a coluna não aparece (a régua já é só rostinhos)', () => {
    useStore.setState({ railMode: true })
    render(<Sidebar />)
    expect(screen.queryByRole('navigation', { name: 'Terminais ligados' })).toBeNull()
  })

  it('CSS: a coluna fica parada ao rolar a lateral e rola por conta própria', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
    const regra = css.match(/\.quick-col\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(regra).toMatch(/position:\s*sticky/)
    expect(regra).toMatch(/top:\s*0/)
    expect(regra).toMatch(/overflow-y:\s*auto/)
    expect(regra).toMatch(/max-height:/)
    // Lição do desempenho: nada de blur na lateral (AGENTS.md).
    expect(regra).not.toMatch(/backdrop-filter/)
  })
})
