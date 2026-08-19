import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (localId: string, projectId: number, status: SessionInfo['status'] = 'idle'): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: 'x', engine: 'claude' })

/**  Setor 100 → Grupo 10 → Alpha; Beta solto no setor; Gama na raiz. */
beforeEach(() => {
  useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#fff', icon: '🅰️', groupId: 10 },
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#fff', icon: '🅱️', sectorId: 100 },
      { id: 3, name: 'Gama', path: '/tmp/c', color: '#fff', icon: '🇬' },
    ],
    groups: [{ id: 10, name: 'Backend', sectorId: 100 }],
    sectors: [{ id: 100, name: 'Produto' }],
    schedules: [], sessions: { s1: sess('s1', 1), s2: sess('s2', 2, 'needs_attention') },
    chat: {}, unread: { s2: 4 }, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const cardOf = (name: string) =>
  screen.getAllByTestId('term-card').find((c) => within(c).queryByText(name))!

describe('recolher e expandir tudo', () => {
  it('recolhe os três níveis de uma vez: setor, grupo e terminal', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle(/recolher tudo/i))
    // setor fechado esconde o que está dentro dele
    expect(screen.queryByText('Backend')).toBeNull()
    expect(screen.queryByText('Alpha')).toBeNull()
    // o terminal da raiz continua visível, mas compacto
    expect(cardOf('Gama').className).toMatch(/\bcollapsed\b/)
  })

  it('expandir tudo devolve os três níveis', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle(/recolher tudo/i))
    fireEvent.click(screen.getByTitle(/expandir tudo/i))
    expect(screen.getByText('Backend')).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(cardOf('Gama').className).not.toMatch(/\bcollapsed\b/)
  })

  it('o estado sobrevive ao reload (é estado de visão, como os grupos)', () => {
    const { unmount } = render(<Sidebar />)
    fireEvent.click(screen.getByTitle(/recolher tudo/i))
    unmount()
    render(<Sidebar />)
    expect(cardOf('Gama').className).toMatch(/\bcollapsed\b/)
  })
})

describe('terminal colapsável', () => {
  it('o caret do cartão colapsa só aquele terminal', () => {
    render(<Sidebar />)
    fireEvent.click(within(cardOf('Gama')).getByTitle(/recolher/i))
    expect(cardOf('Gama').className).toMatch(/\bcollapsed\b/)
    expect(cardOf('Alpha').className).not.toMatch(/\bcollapsed\b/)
  })

  it('colapsar não abre a sessão (o clique não vaza para o cartão)', () => {
    render(<Sidebar />)
    fireEvent.click(within(cardOf('Alpha')).getByTitle(/recolher/i))
    expect(useStore.getState().view).toBe('dashboard')
  })

  /**
   * O modo compacto não pode virar um jeito de perder o aviso: a bolinha de status
   * e o badge de não lidas continuam na linha, é o TEXTO do status que sai.
   */
  it('colapsado esconde o texto do status, mas mantém bolinha e badge', () => {
    render(<Sidebar />)
    const beta = cardOf('Beta')
    fireEvent.click(within(beta).getByTitle(/recolher/i))
    const collapsed = cardOf('Beta')
    expect(within(collapsed).queryByText(/aguardando você/i)).toBeNull()
    expect(collapsed.querySelector('.status-dot')).toBeTruthy()
    expect(within(collapsed).getByText('4')).toBeTruthy()
  })

  /**
   * O ▶ de iniciar/reviver morava DENTRO da linha de status, que o modo compacto
   * esconde inteira — e o terminal colapsado ficava sem como subir. Colapsar é
   * economizar espaço, não perder a única ação que aquele cartão oferece.
   */
  it('terminal SEM sessão continua tendo como iniciar quando colapsado', () => {
    render(<Sidebar />)
    // Gama não tem sessão: o cartão dele só oferece "iniciar"
    fireEvent.click(within(cardOf('Gama')).getByTitle(/recolher/i))
    expect(within(cardOf('Gama')).getByTitle(/iniciar sessão/i)).toBeTruthy()
  })

  it('terminal PARADO continua tendo como reviver quando colapsado', () => {
    useStore.setState({ sessions: { s3: sess('s3', 3, 'stopped') } })
    render(<Sidebar />)
    fireEvent.click(within(cardOf('Gama')).getByTitle(/recolher/i))
    expect(within(cardOf('Gama')).getByTitle(/reviver/i)).toBeTruthy()
  })

  it('terminal vivo não ganha botão de iniciar (não há o que subir)', () => {
    render(<Sidebar />)
    fireEvent.click(within(cardOf('Alpha')).getByTitle(/recolher/i))
    expect(within(cardOf('Alpha')).queryByTitle(/iniciar sessão|reviver/i)).toBeNull()
  })

  it('expandir de volta traz o texto do status', () => {
    render(<Sidebar />)
    fireEvent.click(within(cardOf('Beta')).getByTitle(/recolher/i))
    fireEvent.click(within(cardOf('Beta')).getByTitle(/expandir/i))
    expect(within(cardOf('Beta')).getByText(/aguardando você/i)).toBeTruthy()
  })
})

/**
 * O defeito relatado: com a sidebar estreita o rótulo quebrava DENTRO do botão
 * ("+" numa linha, "Terminal" na outra). Quem manda no espaço é a largura da
 * sidebar (que é redimensionável), não a da janela — daí container query.
 */
describe('a barra de ferramentas não quebra por dentro', () => {
  it('os botões do cabeçalho são nowrap', () => {
    const start = css.indexOf('.term-header__add,')
    expect(start, 'a regra dos botões do cabeçalho sumiu').toBeGreaterThan(-1)
    expect(css.slice(start, css.indexOf('}', start))).toMatch(/white-space: *nowrap/)
  })

  it('a sidebar é um contêiner de consulta, e o rótulo some no estreito', () => {
    expect(css).toMatch(/container-type: *inline-size/)
    expect(css).toMatch(/@container[^{]*\([^)]*width[^)]*\)/)
  })
})
