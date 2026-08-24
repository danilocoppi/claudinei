import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Sidebar } from '../components/Sidebar'
import { SidebarResizer } from '../components/SidebarResizer'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (localId: string, projectId: number, status: SessionInfo['status']): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

beforeEach(() => {
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁', groupId: 10 },
      { id: 2, name: 'Beta', path: '/b', color: '#fff', icon: '📦' },
    ],
    groups: [{ id: 10, name: 'Backend', color: '#e8992f', icon: '🗂️', sectorId: 100 }],
    sectors: [{ id: 100, name: 'Produto', color: '#58c4dc', icon: '🏢' }],
    schedules: [], sessions: { s1: sess('s1', 1, 'needs_attention') },
    chat: {}, unread: { s1: 3 }, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
    railMode: false,
  })
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const colapsar = () => {
  render(<Sidebar />)
  fireEvent.click(screen.getByTitle(/recolher barra|collapse sidebar/i))
}

/**
 * A barra inteira vira uma régua de 62px: sobram os estados e os ícones. Quem
 * colapsa quer a tela para o chat e um canto de olho no que está acontecendo.
 */
describe('a barra vira régua', () => {
  it('o botão troca a lista pela régua', () => {
    colapsar()
    expect(document.querySelector('.rail')).toBeTruthy()
    expect(document.querySelector('.term-list')).toBeNull()
  })

  it('e volta', () => {
    colapsar()
    fireEvent.click(screen.getByTitle(/expandir barra|expand sidebar/i))
    expect(document.querySelector('.rail')).toBeNull()
    expect(document.querySelector('.term-list')).toBeTruthy()
  })

  it('o estado sobrevive ao reload', () => {
    colapsar()
    cleanup()
    render(<Sidebar />)
    expect(document.querySelector('.rail')).toBeTruthy()
  })

  /** Sem rótulo, o nome tem que estar em algum lugar — senão vira adivinhação. */
  it('cada linha diz o nome no tooltip', () => {
    colapsar()
    expect(screen.getByTitle('Alpha')).toBeTruthy()
    expect(screen.getByTitle('Produto')).toBeTruthy()
  })

  it('o rosto do estado continua ali', () => {
    colapsar()
    const alpha = screen.getByTitle('Alpha')
    expect(alpha.querySelector('[data-face]')!.getAttribute('data-face')).toBe('attention')
  })

  it('e o badge de não-lidas também', () => {
    colapsar()
    expect(within(screen.getByTitle('Alpha')).getByText('3')).toBeTruthy()
  })

  /** O chamado de quem espera não pode sumir justamente na visão de canto de olho. */
  it('o sonar acompanha', () => {
    colapsar()
    expect(screen.getByTitle('Alpha').querySelector('.sonar')).toBeTruthy()
  })

  it('clicar num terminal abre a sessão dele', () => {
    useStore.setState({ sessions: { s1: sess('s1', 1, 'idle') } })
    colapsar()
    fireEvent.click(screen.getByTitle('Alpha'))
    expect(useStore.getState().activeLocalId).toBe('s1')
  })

  it('clicar num contêiner abre e fecha ele', () => {
    colapsar()
    expect(screen.getByTitle('Alpha')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Backend'))
    expect(screen.queryByTitle('Alpha')).toBeNull()
  })
})

describe('a profundidade sem recuo', () => {
  it('conta uma guia por contêiner que envolve a linha', () => {
    colapsar()
    expect(screen.getByTitle('Alpha').querySelectorAll('.rail-guide i')).toHaveLength(2)
    expect(screen.getByTitle('Beta').querySelectorAll('.rail-guide i')).toHaveLength(0)
  })

  it('a guia sai na cor do contêiner dela', () => {
    colapsar()
    const guias = [...screen.getByTitle('Alpha').querySelectorAll<HTMLElement>('.rail-guide i')]
    expect(guias.map((g) => g.style.getPropertyValue('--c'))).toEqual(['#58c4dc', '#e8992f'])
  })
})

describe('o que a régua desliga', () => {
  it('o resizer sai de cena — arrastar uma régua não faz sentido', () => {
    useStore.setState({ railMode: true })
    const { container } = render(<SidebarResizer />)
    expect(container.firstChild).toBeNull()
  })

  it('a largura fixa vence a do arrasto', () => {
    const bloco = css.slice(css.indexOf('.sidebar.rail-mode'))
    expect(bloco.slice(0, 300)).toMatch(/width: *\d+px/)
  })
})
