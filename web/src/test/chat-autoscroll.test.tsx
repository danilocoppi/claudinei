import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { VirtuosoMockContext } from 'react-virtuoso'
import { ChatView } from '../components/ChatView'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, SessionInfo } from '../types'
import * as grouping from '../chat/grouping'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess: SessionInfo = {
  localId: 's1', projectId: 1, status: 'working', engineSessionId: 'c', updatedAt: 'x', engine: 'claude',
}
const fala = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: 'assistant_text' as const, text: `linha ${i}` }))

// Lista virtual com medidas fixas: janela de 500px, item de 50px (10 na tela,
// mais a sobra montada acima e abaixo). "Puxou a tela para o fim" = o último
// item está montado.
const JANELA = 500
const ITEM = 50

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }],
    groups: [], sectors: [], schedules: [], sessions: { s1: sess },
    chat: { s1: fala(100) }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'c' },
    view: 'chat', activeLocalId: 's1', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const esperar = () => act(async () => { await new Promise((r) => setTimeout(r, 200)) })
const abrir = async () => {
  render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: JANELA, itemHeight: ITEM }}><ChatView /></VirtuosoMockContext.Provider>,
  )
  await esperar()
}
const ultimoMontado = () => {
  const linhas = document.querySelectorAll('.chat-entry')
  return linhas[linhas.length - 1]?.textContent?.match(/linha \d+/)?.[0]
}

/** O jsdom não tem layout: as medidas da caixa de rolagem são plantadas na mão. */
const posicionar = async (scrollTop: number) => {
  const caixa = document.querySelector('[data-testid="chat-scroll"]') as HTMLElement
  const scrollHeight = useStore.getState().chat.s1.length * ITEM
  for (const [k, v] of Object.entries({ scrollTop, scrollHeight, clientHeight: JANELA })) {
    Object.defineProperty(caixa, k, { value: v, configurable: true, writable: true })
  }
  fireEvent.scroll(caixa)
  await esperar()
  return caixa
}
const NO_FIM = () => useStore.getState().chat.s1.length * ITEM - JANELA
/** Mais itens do que a sobra montada abaixo da tela: só o último aparece se a tela desceu. */
const chegaMaisTexto = async () => {
  act(() => { useStore.setState({ chat: { s1: fala(useStore.getState().chat.s1.length + 30) } }) })
  await esperar()
}
const ultimaFala = () => `linha ${useStore.getState().chat.s1.length - 1}`

/**
 * O defeito relatado: com o agente escrevendo, tentar ler algo que passou era
 * impossível — cada pedaço que chegava puxava a barra de volta para o fim.
 */
describe('ler o que passou enquanto o agente escreve', () => {
  it('após o result, mantém shell visível como tarefa de background sem subagentes nem indicador de processamento', async () => {
    await abrir()
    act(() => useStore.getState().applyWsMessage({ type: 'session_status', localId: 's1', status: 'needs_attention', backgroundTasks: [
      { id: 'b1', taskType: 'local_bash', description: 'Hardhat local', type: '', prompt: '' },
    ] }))
    expect(screen.getByTestId('background-processes')).toBeTruthy()
    expect(screen.getByText('Hardhat local')).toBeTruthy()
    expect(screen.queryByTestId('running-subagents')).toBeNull()
    expect(screen.queryByTestId('typing-indicator')).toBeNull()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('streaming e eventos de outra sessão não reprocessam os grupos do histórico', async () => {
    const group = vi.spyOn(grouping, 'groupActions')
    await abrir()
    group.mockClear()
    act(() => useStore.getState().applyWsMessage({ type: 'session_event', localId: 's1', event: { kind: 'stream', text: 'novo trecho', raw: {} } }))
    expect(screen.getByTestId('streaming-preview').textContent).toContain('novo trecho')
    act(() => useStore.getState().applyWsMessage({ type: 'session_event', localId: 'other', event: { kind: 'stream', text: 'outra conversa', raw: {} } }))
    expect(group).not.toHaveBeenCalled()
    expect(screen.getByTestId('streaming-preview').textContent).not.toContain('outra conversa')
  })

  it('subir a rolagem solta a tela: o que chega não puxa mais', async () => {
    await abrir()
    await posicionar(0)
    await chegaMaisTexto()
    expect(ultimoMontado(), 'a tela foi puxada mesmo com o usuário lendo em cima').not.toBe(ultimaFala())
  })

  it('no fim da rolagem, continua acompanhando', async () => {
    await abrir()
    await posicionar(NO_FIM())
    await chegaMaisTexto()
    expect(ultimoMontado()).toBe(ultimaFala())
  })

  /** Voltar ao fim com a própria rolagem religa o acompanhamento — sem clicar em nada. */
  it('descer de volta ao fim prende a tela outra vez', async () => {
    await abrir()
    await posicionar(0)
    await posicionar(NO_FIM())
    await chegaMaisTexto()
    expect(ultimoMontado()).toBe(ultimaFala())
  })
})

describe('o aviso de que a tela está solta', () => {
  it('só aparece quando se está lendo mais acima', async () => {
    await abrir()
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
    await posicionar(0)
    expect(screen.getByTestId('chat-tofoot')).toBeTruthy()
  })

  it('some ao voltar para o fim', async () => {
    await abrir()
    await posicionar(0)
    await posicionar(NO_FIM())
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
  })

  it('clicar leva ao fim e volta a acompanhar', async () => {
    await abrir()
    await posicionar(0)
    expect(ultimoMontado()).not.toBe(ultimaFala())
    fireEvent.click(screen.getByTestId('chat-tofoot'))
    await esperar()
    expect(ultimoMontado()).toBe(ultimaFala())
    await chegaMaisTexto()
    expect(ultimoMontado(), 'não voltou a acompanhar depois do clique').toBe(ultimaFala())
  })

  /** Trocar de terminal é chegar numa conversa nova: começa no fim dela. */
  it('trocar de terminal recomeça acompanhando', async () => {
    await abrir()
    await posicionar(0)
    expect(screen.getByTestId('chat-tofoot')).toBeTruthy()
    act(() => {
      useStore.setState({
        sessions: { s1: sess, s2: { ...sess, localId: 's2', projectId: 1 } },
        chat: { s1: fala(100), s2: fala(50) }, historyLoadedFor: { s1: 'c', s2: 'c' },
        activeLocalId: 's2',
      })
    })
    await esperar()
    expect(screen.queryByTestId('chat-tofoot')).toBeNull()
    expect(ultimoMontado()).toBe('linha 49')
  })
})
