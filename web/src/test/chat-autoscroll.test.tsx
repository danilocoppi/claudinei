import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { ChatView } from '../components/ChatView'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = {
  localId: 's1', projectId: 1, status: 'working', engineSessionId: 'c', updatedAt: 'x', engine: 'claude',
}
const fala = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: 'assistant_text' as const, text: `linha ${i}` }))

let rolouParaOFim: number

beforeEach(() => {
  rolouParaOFim = 0
  localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = vi.fn(() => { rolouParaOFim++ })
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [], sessions: { s1: sess },
    chat: { s1: fala(20) }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'c' },
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** O jsdom não tem layout: as medidas da caixa de rolagem são plantadas na mão. */
const posicionar = (scrollTop: number) => {
  const caixa = document.querySelector('[data-testid="chat-scroll"]') as HTMLElement
  for (const [k, v] of Object.entries({ scrollTop, scrollHeight: 2000, clientHeight: 500 })) {
    Object.defineProperty(caixa, k, { value: v, configurable: true })
  }
  fireEvent.scroll(caixa)
  return caixa
}
const chegaMaisTexto = () =>
  act(() => { useStore.setState({ chat: { s1: fala(useStore.getState().chat.s1.length + 3) } }) })

/**
 * O defeito relatado: com o agente escrevendo, tentar ler algo que passou era
 * impossível — cada pedaço que chegava puxava a barra de volta para o fim.
 */
describe('ler o que passou enquanto o agente escreve', () => {
  it('subir a rolagem solta a tela: o que chega não puxa mais', () => {
    render(<ChatView />)
    posicionar(0)
    const antes = rolouParaOFim
    chegaMaisTexto()
    expect(rolouParaOFim, 'a tela foi puxada mesmo com o usuário lendo em cima').toBe(antes)
  })

  it('no fim da rolagem, continua acompanhando', () => {
    render(<ChatView />)
    posicionar(1500)
    const antes = rolouParaOFim
    chegaMaisTexto()
    expect(rolouParaOFim).toBeGreaterThan(antes)
  })

  /** Voltar ao fim com a própria rolagem religa o acompanhamento — sem clicar em nada. */
  it('descer de volta ao fim prende a tela outra vez', () => {
    render(<ChatView />)
    posicionar(0)
    posicionar(1500)
    const antes = rolouParaOFim
    chegaMaisTexto()
    expect(rolouParaOFim).toBeGreaterThan(antes)
  })
})

describe('o aviso de que a tela está solta', () => {
  it('só aparece quando se está lendo mais acima', () => {
    render(<ChatView />)
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
    posicionar(0)
    expect(screen.getByTestId('chat-tofoot')).toBeTruthy()
  })

  it('some ao voltar para o fim', () => {
    render(<ChatView />)
    posicionar(0)
    posicionar(1500)
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
  })

  it('clicar leva ao fim e volta a acompanhar', () => {
    render(<ChatView />)
    posicionar(0)
    const antes = rolouParaOFim
    fireEvent.click(screen.getByTestId('chat-tofoot'))
    expect(rolouParaOFim).toBeGreaterThan(antes)
    const depoisDoClique = rolouParaOFim
    chegaMaisTexto()
    expect(rolouParaOFim, 'não voltou a acompanhar depois do clique').toBeGreaterThan(depoisDoClique)
  })

  /** Trocar de terminal é chegar numa conversa nova: começa no fim dela. */
  it('trocar de terminal recomeça acompanhando', () => {
    render(<ChatView />)
    posicionar(0)
    expect(screen.getByTestId('chat-tofoot')).toBeTruthy()
    act(() => {
      useStore.setState({
        sessions: { s1: sess, s2: { ...sess, localId: 's2', projectId: 1 } },
        chat: { s1: fala(20), s2: fala(5) }, historyLoadedFor: { s1: 'c', s2: 'c' },
        activeLocalId: 's2',
      })
    })
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
  })
})
