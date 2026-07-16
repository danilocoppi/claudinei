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

describe('marcador de interrupção do CLI', () => {
  it('"[Request interrupted by user]" vira chip de interrupção, não bolha de usuário', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: '[Request interrupted by user]' }} />)
    expect(screen.getByText('Interrompido pelo usuário')).toBeTruthy()
    // não renderiza o texto cru do marcador nem a bolha
    expect(screen.queryByText('[Request interrupted by user]')).toBeNull()
    expect(document.querySelector('.msg-interrupt')).toBeTruthy()
  })

  it('variante "for tool use" ganha o rótulo de ferramenta recusada', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: '[Request interrupted by user for tool use]' }} />)
    expect(screen.getByText('Interrompido pelo usuário — ferramenta recusada')).toBeTruthy()
  })

  it('chip não tem botão de encaminhar nem de editar', () => {
    render(
      <MessageBlock item={{ kind: 'user_text', text: '[Request interrupted by user]' }}
                    currentLocalId="l1" onEdit={() => {}} />,
    )
    expect(screen.queryByText('Encaminhar')).toBeNull()
    expect(document.querySelector('.msg-edit')).toBeNull()
  })

  it('texto normal de usuário continua bolha', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: 'Requisição normal' }} />)
    expect(document.querySelector('.msg-interrupt')).toBeNull()
    expect(screen.getByText('Requisição normal')).toBeTruthy()
  })
})

describe('bolha de usuário gerada pela engine (fromEngine)', () => {
  it('ganha cor distinta e cabeçalho "by <engine>"', () => {
    useStore.setState({
      sessions: { l1: { localId: 'l1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'codex' } as never },
      engines: [{ id: 'codex', label: 'Codex', icon: '◆', models: [], efforts: [], permissions: [], slashSource: 'curated', slashCommands: [] } as never],
    })
    render(<MessageBlock item={{ kind: 'user_text', text: 'injetado pela engine', fromEngine: true }} currentLocalId="l1" />)
    expect(screen.getByText('by Codex')).toBeTruthy()
    expect(document.querySelector('.msg-bubble--engine')).toBeTruthy()
    expect(screen.getByText('injetado pela engine')).toBeTruthy()
  })

  it('sem sessão/engine conhecida cai no rótulo genérico "by engine"', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: 'injetado', fromEngine: true }} />)
    expect(screen.getByText('by engine')).toBeTruthy()
  })

  it('bolha normal não tem cabeçalho by', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: 'meu texto' }} />)
    expect(screen.queryByText(/^by /)).toBeNull()
  })
})

describe('mensagem longa do usuário colapsa em 13 linhas', () => {
  const long = Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join('\n')

  it('mostra 13 linhas + … + botão com o resto; expande e recolhe', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: long }} />)
    expect(screen.getByText(/linha 13/)).toBeTruthy()
    expect(screen.queryByText(/linha 14/)).toBeNull()
    const btn = screen.getByRole('button', { name: /mostrar tudo \(\+7 linhas\)/ })
    fireEvent.click(btn)
    expect(screen.getByText(/linha 20/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /recolher/ }))
    expect(screen.queryByText(/linha 20/)).toBeNull()
  })

  it('mensagem curta não ganha botão', () => {
    render(<MessageBlock item={{ kind: 'user_text', text: 'linha 1\nlinha 2' }} />)
    expect(screen.queryByRole('button', { name: /mostrar tudo/ })).toBeNull()
  })
})

it('bolha do operador usa o design glass padrão (.msg-bubble, sem variante engine)', () => {
  render(<MessageBlock item={{ kind: 'user_text', text: 'meu pedido' }} />)
  const bubble = document.querySelector('.msg-bubble')
  expect(bubble).toBeTruthy()
  expect(bubble!.classList.contains('msg-bubble--engine')).toBe(false)
})

describe('callout de erro da API da engine', () => {
  it('assistant_text com isApiError vira callout distinto (sem markdown normal)', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'API Error: Server error mid-response. The response above may be incomplete', isApiError: true }} />)
    expect(document.querySelector('.api-error')).toBeTruthy()
    expect(screen.getByText('Erro da API da engine')).toBeTruthy()
    expect(screen.getByText(/Server error mid-response/)).toBeTruthy()
    expect(screen.getByText(/pode estar incompleta/)).toBeTruthy()
    // sem botão de encaminhar num erro
    expect(screen.queryByText('Encaminhar')).toBeNull()
  })

  it('assistant_text normal não vira callout', () => {
    render(<MessageBlock item={{ kind: 'assistant_text', text: 'resposta ok' }} />)
    expect(document.querySelector('.api-error')).toBeNull()
  })
})
