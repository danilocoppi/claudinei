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
 * Os seis estados do design "Rostos de Agente". O rosto É o estado: uma bolinha
 * dizia a mesma coisa com menos expressão.
 */
describe('o estado vira expressão', () => {
  it('traduz cada status num dos seis estados do design', () => {
    expect(faceStateOf(sess({ status: 'idle' }))).toBe('idle')
    expect(faceStateOf(sess({ status: 'working' }))).toBe('working')
    expect(faceStateOf(sess({ status: 'needs_attention' }))).toBe('waiting')
    expect(faceStateOf(sess({ status: 'starting' }))).toBe('uploading')
    expect(faceStateOf(sess({ status: 'stopped' }))).toBe('sleeping')
    expect(faceStateOf(sess({ status: 'dead' }))).toBe('sleeping')
  })

  /** O sexto estado: a sessão aberta no TUI, que o desenho antigo não tinha. */
  it('sessão no terminal tem estado próprio', () => {
    expect(faceStateOf(sess({ status: 'in_terminal' }))).toBe('terminal')
    expect(faceStateOf(sess({ status: 'in_terminal', terminalActivity: 'waiting' }))).toBe('waiting')
    expect(faceStateOf(sess({ status: 'in_terminal', terminalActivity: 'working' }))).toBe('working')
  })

  it('sem sessão, o agente dorme', () => {
    expect(faceStateOf(undefined)).toBe('sleeping')
  })

  it('o estado vai no atributo, como o tema — quem desenha é o CSS', () => {
    const { container } = render(<AgentFace state="working" />)
    expect(container.querySelector('[data-face]')!.getAttribute('data-face')).toBe('working')
  })

  /** Um gesto por estado, e a escala inteira sai de `--face`. */
  it('tudo escala a partir de um número só', () => {
    const { container } = render(<AgentFace state="idle" size={44} />)
    expect((container.firstChild as HTMLElement).style.getPropertyValue('--face')).toBe('44px')
  })

  /** "Subindo" sem as setas seria idêntico a "ocioso" — o adereço É o estado. */
  it('só o subindo carrega adereço nesta escala', () => {
    expect(render(<AgentFace state="uploading" />).container.querySelector('.agent-face__arrows')).toBeTruthy()
    cleanup()
    expect(render(<AgentFace state="idle" />).container.querySelector('.agent-face__arrows')).toBeNull()
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

  /** O ícone que o operador escolheu continua sendo dele: o rosto não o substitui. */
  it('o rosto não engole o ícone', () => {
    useStore.setState({ sessions: { s1: sess() } })
    render(<Sidebar />)
    expect(screen.getByTestId('term-card').querySelector('.term-card__icon')).toBeTruthy()
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
  /** Um gesto por estado — cada um tem o seu, e nenhum fica parado. */
  it('cada estado tem o seu gesto', () => {
    for (const state of ['idle', 'working', 'waiting', 'uploading', 'sleeping', 'terminal']) {
      const bloco = css.slice(css.indexOf(`[data-face="${state}"]`))
      expect(bloco.slice(0, 500), state).toMatch(/animation: *face-/)
    }
  })

  it('o "reduzir movimento" alcança o corpo, os olhos e os adereços', () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block).toMatch(/agent-face__body/)
    expect(block).toMatch(/agent-face__arrows/)
    const forced = css.slice(css.indexOf('[data-motion="reduced"]'))
    expect(forced.slice(0, 900)).toMatch(/agent-face__body/)
  })
})
