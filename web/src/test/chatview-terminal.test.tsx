import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

function setup(status: string, engineSessionId: string | null = 'conv-1') {
  useStore.setState({
    projects: [{ id: 1, name: 'P', icon: '📂', path: '/p' } as never],
    sessions: { s1: { localId: 's1', projectId: 1, status, engineSessionId } as never },
    chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'x' },
    activeLocalId: 's1', view: 'chat',
  })
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  // Response FRESCO por chamada: um único Response compartilhado tem o body lido
  // só uma vez — múltiplos fetch (histórico + engines) davam "Body is unusable".
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('botão Abrir no terminal no título', () => {
  it('idle → abre direto (view terminal)', () => {
    setup('idle')
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByText(/terminal/i, { selector: 'button' }))
    expect(useStore.getState().view).toBe('terminal')
  })

  it('working → abre o diálogo; confirmar envia interrupt e, quando o status muda, abre o terminal', async () => {
    const send = vi.fn()
    setup('working')
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByText(/terminal/i, { selector: 'button' }))
    expect(screen.getByText('O turno em andamento será interrompido para abrir esta conversa no terminal.')).toBeTruthy()
    fireEvent.click(screen.getByText('Confirmar'))
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
    expect(useStore.getState().view).toBe('chat') // ainda não abriu — espera o status
    act(() => { useStore.setState((s) => ({ sessions: { s1: { ...s.sessions.s1, status: 'needs_attention' } as never } })) })
    await waitFor(() => expect(useStore.getState().view).toBe('terminal'))
  })

  it('working → cancelar o diálogo não interrompe nem abre', () => {
    const send = vi.fn()
    setup('working')
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByText(/terminal/i, { selector: 'button' }))
    fireEvent.click(screen.getByText('Cancelar'))
    expect(send).not.toHaveBeenCalled()
    expect(useStore.getState().view).toBe('chat')
  })

  it('starting COM conversa (sessão revivida, engineSessionId presente) → habilitado e abre direto', () => {
    useStore.setState({
      projects: [{ id: 1, name: 'P', icon: '📂', path: '/p' } as never],
      sessions: { s1: { localId: 's1', projectId: 1, status: 'starting', engineSessionId: 'conv-1' } as never },
      chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'x' },
      activeLocalId: 's1', view: 'chat',
    })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    const btn = screen.getByText(/terminal/i, { selector: 'button' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(useStore.getState().view).toBe('terminal')
  })

  it('starting SEM conversa (revive --continue esperando a 1ª msg) → HABILITADO (backend retoma o último da pasta ou abre fresh)', () => {
    useStore.setState({
      projects: [{ id: 1, name: 'P', icon: '📂', path: '/p' } as never],
      sessions: { s1: { localId: 's1', projectId: 1, status: 'starting', engineSessionId: null } as never },
      chat: { s1: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'x' },
      activeLocalId: 's1', view: 'chat',
    })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    const btn = screen.getByText(/terminal/i, { selector: 'button' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(useStore.getState().view).toBe('terminal')
  })

  it('stopped/dead → desabilitado com dica (status inativo, mas há conversa)', () => {
    for (const status of ['stopped', 'dead']) {
      setup(status)
      const { unmount } = render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
      const btn = screen.getByTitle('Disponível quando a sessão estiver ativa.') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      unmount()
    }
  })

  it('sessão in_terminal → aviso tem botão que REABRE a visão do terminal (não fica preso no chat)', () => {
    setup('in_terminal')
    useStore.setState({ view: 'chat' })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByText('Voltar ao terminal'))
    expect(useStore.getState().view).toBe('terminal')
    expect(useStore.getState().activeLocalId).toBe('s1')
  })

  it('sessão ativa SEM conversa (Codex turn-based antes do 1º turno) → HABILITADO (abre sessão nova no terminal)', () => {
    setup('idle', null) // idle mas sem engineSessionId: o thread ainda não existe → terminal fresh
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    const btn = screen.getByText(/terminal/i, { selector: 'button' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(useStore.getState().view).toBe('terminal')
  })

  it('trocar de sessão com handoff pendente CANCELA (não abre o terminal da outra)', async () => {
    const send = vi.fn()
    useStore.setState({
      projects: [{ id: 1, name: 'P', icon: '📂', path: '/p' } as never],
      sessions: {
        s1: { localId: 's1', projectId: 1, status: 'working', engineSessionId: 'c1' } as never,
        s2: { localId: 's2', projectId: 1, status: 'idle', engineSessionId: 'c2' } as never,
      },
      chat: { s1: [], s2: [] }, unread: {}, streaming: {}, historyLoadedFor: { s1: 'x', s2: 'x' },
      activeLocalId: 's1', view: 'chat',
    })
    render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: /terminal/i }))
    fireEvent.click(screen.getByText('Confirmar'))
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
    // usuário troca para s2 antes do interrupt completar
    act(() => { useStore.getState().openSession('s2') })
    // s1 sai de working depois (interrupt completou) — NÃO pode abrir terminal de ninguém
    act(() => { useStore.setState((s) => ({ sessions: { ...s.sessions, s1: { ...s.sessions.s1, status: 'needs_attention' } as never } })) })
    await new Promise((r) => setTimeout(r, 50))
    expect(useStore.getState().view).toBe('chat')
    expect(useStore.getState().activeLocalId).toBe('s2')
  })
})
