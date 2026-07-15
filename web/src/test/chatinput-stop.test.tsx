import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import type { SessionInfo } from '../types'

const SESSION = { localId: 's1', projectId: 1, status: 'working' } as unknown as SessionInfo

beforeEach(() => {
  useStore.setState({ chat: {}, sessions: { s1: SESSION }, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => cleanup())

const renderInput = (send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  return { send, textarea: screen.getByPlaceholderText(/processando|Mensagem para o Claude/) as HTMLTextAreaElement }
}

describe('botão Parar', () => {
  it('aparece durante working e envia interrupt ao clicar', () => {
    const { send } = renderInput()
    fireEvent.click(screen.getByLabelText('Parar o turno'))
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
  })

  it('não aparece fora de working', () => {
    useStore.setState({ sessions: { s1: { ...SESSION, status: 'idle' } as never } })
    renderInput()
    expect(screen.queryByLabelText('Parar o turno')).toBeNull()
  })

  it('Esc no campo envia interrupt quando working (sem slash aberto)', () => {
    const { send, textarea } = renderInput()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', localId: 's1' })
  })

  it('Esc com o menu de slash aberto fecha o menu, não interrompe', () => {
    useStore.setState({ slashCommands: ['compact', 'cost'] } as never)
    const { send, textarea } = renderInput()
    fireEvent.change(textarea, { target: { value: '/co' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt' }))
  })

  it('Esc fora de working não envia nada', () => {
    useStore.setState({ sessions: { s1: { ...SESSION, status: 'idle' } as never } })
    const { send, textarea } = renderInput()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(send).not.toHaveBeenCalled()
  })
})
