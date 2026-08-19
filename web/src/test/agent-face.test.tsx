import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AgentFace, faceStateOf } from '../components/AgentFace'
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
const sess = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...over })

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#7c5cff', icon: '🅰️' }],
    groups: [], sectors: [], schedules: [], sessions: {},
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/**
 * O rosto É o estado. A bolinha dizia a mesma coisa com menos expressão — e um
 * agente que olha comunica "há alguém aqui" de um jeito que um ponto não comunica.
 */
describe('o estado vira expressão', () => {
  it('traduz cada status numa expressão', () => {
    expect(faceStateOf(sess({ status: 'idle' }))).toBe('idle')
    expect(faceStateOf(sess({ status: 'working' }))).toBe('working')
    expect(faceStateOf(sess({ status: 'needs_attention' }))).toBe('waiting')
    expect(faceStateOf(sess({ status: 'starting' }))).toBe('starting')
    expect(faceStateOf(sess({ status: 'stopped' }))).toBe('asleep')
    expect(faceStateOf(sess({ status: 'dead' }))).toBe('asleep')
  })

  /** O TUI parado esperando é "esperando você" tanto quanto o needs_attention. */
  it('o terminal parado esperando também acorda o rosto', () => {
    expect(faceStateOf(sess({ status: 'in_terminal', terminalActivity: 'waiting' }))).toBe('waiting')
    expect(faceStateOf(sess({ status: 'in_terminal', terminalActivity: 'working' }))).toBe('working')
  })

  it('sem sessão, o rosto dorme', () => {
    expect(faceStateOf(undefined)).toBe('asleep')
  })

  it('o estado vai no atributo, como o tema — quem desenha é o CSS', () => {
    const { container } = render(<AgentFace state="working" />)
    expect(container.querySelector('[data-face]')!.getAttribute('data-face')).toBe('working')
  })

  it('herda a cor de quem o contém, para pegar a cor do terminal', () => {
    const { container } = render(<AgentFace state="idle" />)
    expect(container.querySelector('.agent-face__head')!.getAttribute('fill')).toBe('currentColor')
  })
})

describe('no cartão do terminal', () => {
  it('o rosto vem antes do ícone, e os dois convivem', () => {
    useStore.setState({ sessions: { s1: sess() } })
    render(<Sidebar />)
    const title = screen.getByTestId('term-card').querySelector('.term-card__title')!
    const face = title.querySelector('[data-face]')!
    const icon = title.querySelector('.term-card__icon')!
    expect(face).toBeTruthy()
    expect(icon).toBeTruthy()
    // ordem no documento: rosto primeiro
    expect(face.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('o rosto mostra o estado da sessão principal', () => {
    useStore.setState({ sessions: { s1: sess({ status: 'needs_attention' }) } })
    render(<Sidebar />)
    expect(screen.getByTestId('term-card').querySelector('[data-face]')!.getAttribute('data-face')).toBe('waiting')
  })

  /** Uma bolinha ao lado do rosto diria a mesma coisa duas vezes. */
  it('com uma engine só, a bolinha some — quem fala é o rosto', () => {
    useStore.setState({ sessions: { s1: sess({ status: 'working' }) } })
    render(<Sidebar />)
    expect(screen.getByTestId('term-card').querySelectorAll('.status-dot')).toHaveLength(0)
  })

  /** Duas engines vivas são dois estados: o rosto sozinho não dá conta. */
  it('com duas engines vivas, as bolinhas voltam', () => {
    useStore.setState({
      sessions: {
        s1: sess({ localId: 's1', status: 'idle', engine: 'claude' }),
        s2: sess({ localId: 's2', status: 'working', engine: 'codex' }),
      },
    })
    render(<Sidebar />)
    expect(screen.getByTestId('term-card').querySelectorAll('.status-dot').length).toBeGreaterThan(1)
  })

  it('colapsado, o rosto continua na linha', () => {
    useStore.setState({ sessions: { s1: sess({ status: 'needs_attention' }) } })
    render(<Sidebar />)
    const card = screen.getByTestId('term-card')
    within(card).getByTitle(/recolher/i).click()
    expect(screen.getByTestId('term-card').querySelector('[data-face]')).toBeTruthy()
  })
})

describe('movimento', () => {
  it('só o rosto trabalhando se mexe', () => {
    expect(css).toMatch(/\[data-face="working"\][^{]*\{[^}]*animation/)
  })

  it('o "reduzir movimento" para o rosto também', () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toMatch(/agent-face|data-face/)
    const forced = css.match(/\[data-motion="reduced"\][\s\S]{0,600}/)?.[0] ?? ''
    expect(forced).toMatch(/agent-face|data-face/)
  })
})
