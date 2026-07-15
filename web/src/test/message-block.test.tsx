import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MessageBlock } from '../components/MessageBlock'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

afterEach(() => {
  cleanup()
  useStore.setState({ projects: [], sessions: {}, chat: {} })
})

describe('MessageBlock', () => {
  it('renderiza markdown do assistente (negrito vira <strong>)', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'isso é **importante**' }} />)
    expect(screen.getByText('importante').tagName).toBe('STRONG')
  })

  it('user_text renderiza como bolha do usuário', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: 'faça X' }} />)
    expect(screen.getByText('faça X')).toBeTruthy()
  })

  it('thinking começa recolhido e expande no clique', () => {
    render(<MessageBlock item={{ kind: 'thinking', text: 'raciocínio interno' }} />)
    expect(screen.queryByText('raciocínio interno')).toBeNull()
    fireEvent.click(screen.getByText(/Pensamento/))
    expect(screen.getByText('raciocínio interno')).toBeTruthy()
  })

  it('sem currentLocalId não mostra botão Encaminhar', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'oi' }} />)
    expect(screen.queryByText('Encaminhar')).toBeNull()
  })

  it('item com fromSubagent mostra o marcador "subagente"', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'resposta', fromSubagent: true }} />)
    expect(screen.getByText('↳ subagente')).toBeTruthy()
  })

  it('item sem fromSubagent não mostra o marcador "subagente"', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'oi' }} />)
    expect(screen.queryByText('↳ subagente')).toBeNull()
  })
})

describe('Encaminhar para…', () => {
  afterEach(() => cleanup())

  it('lista "Nenhum outro agente ativo" quando não há outra sessão ativa', () => {
    useStore.setState({
      projects: [{ id: 1, name: 'P1', path: '/tmp/a', color: '#f00', icon: '📁' }],
      sessions: { a: { localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' } },
    })
    render(
      <WsContext.Provider value={{ send: vi.fn() }}>
        <MessageBlock item={{ kind: 'assistant_text', text: 'oi' }} currentLocalId="a" />
      </WsContext.Provider>,
    )
    fireEvent.click(screen.getByText('Encaminhar'))
    expect(screen.getByText('Nenhum outro agente ativo')).toBeTruthy()
  })

  it('encaminha o texto para a sessão ativa de outro projeto via ws send_message', () => {
    const send = vi.fn()
    const addLocalUserText = vi.fn()
    useStore.setState({
      projects: [
        { id: 1, name: 'Origem', path: '/tmp/a', color: '#f00', icon: '📁' },
        { id: 2, name: 'Destino', path: '/tmp/b', color: '#0f0', icon: '📁' },
      ],
      sessions: {
        a: { localId: 'a', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude' },
        b: { localId: 'b', projectId: 2, status: 'needs_attention', engineSessionId: 'd', updatedAt: 'y', engine: 'claude' },
      },
    })
    useStore.setState({ addLocalUserText })

    render(
      <WsContext.Provider value={{ send }}>
        <MessageBlock item={{ kind: 'assistant_text', text: 'texto pra encaminhar' }} currentLocalId="a" />
      </WsContext.Provider>,
    )
    fireEvent.click(screen.getByText('Encaminhar'))
    fireEvent.click(screen.getByText('Destino'))

    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 'b', text: 'texto pra encaminhar' })
    expect(addLocalUserText).toHaveBeenCalledWith('b', 'texto pra encaminhar')
    expect(screen.getByText(/encaminhado para Destino/)).toBeTruthy()
  })
})
