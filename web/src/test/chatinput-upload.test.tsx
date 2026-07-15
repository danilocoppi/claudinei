import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'

const okUpload = (name: string) =>
  new Response(JSON.stringify({ path: `/ups/${name}`, name }), { status: 201, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  useStore.setState({ chat: {}, sessions: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
})
afterEach(() => cleanup())

const renderInput = (send = vi.fn()) => {
  render(<WsContext.Provider value={{ send }}><ChatInput localId="s1" disabled={false} /></WsContext.Provider>)
  return { send, textarea: screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement }
}

describe('upload no ChatInput', () => {
  it('paste de arquivo insere token na posição do cursor', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('001-print.png'))
    const { textarea } = renderInput()
    fireEvent.change(textarea, { target: { value: 'olha isso  e me diz' } })
    textarea.setSelectionRange(10, 10) // depois de "olha isso "
    const file = new File(['x'], 'print.png', { type: 'image/png' })
    fireEvent.paste(textarea, { clipboardData: { files: [file] } })
    await vi.waitFor(() => expect(textarea.value).toBe('olha isso [📎 001-print.png] e me diz'))
    expect(spy).toHaveBeenCalledWith('/api/uploads', expect.objectContaining({ method: 'POST' }))
    spy.mockRestore()
  })

  it('send substitui o token pelo path real', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('002-log.txt'))
    const { send, textarea } = renderInput()
    const file = new File(['x'], 'log.txt', { type: 'text/plain' })
    fireEvent.paste(textarea, { clipboardData: { files: [file] } })
    await vi.waitFor(() => expect(textarea.value).toContain('[📎 002-log.txt]'))
    fireEvent.change(textarea, { target: { value: `analisa ${textarea.value} por favor` } })
    fireEvent.click(screen.getByText('Enviar'))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: 'analisa /ups/002-log.txt por favor' })
    spy.mockRestore()
  })

  it('token apagado pelo usuário não é substituído (anexo não vai)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('003-a.txt'))
    const { send, textarea } = renderInput()
    fireEvent.paste(textarea, { clipboardData: { files: [new File(['x'], 'a.txt')] } })
    await vi.waitFor(() => expect(textarea.value).toContain('[📎 003-a.txt]'))
    fireEvent.change(textarea, { target: { value: 'só texto, apaguei o anexo' } })
    fireEvent.click(screen.getByText('Enviar'))
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 's1', text: 'só texto, apaguei o anexo' })
    spy.mockRestore()
  })

  it('drop de arquivo insere token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okUpload('004-doc.pdf'))
    const { textarea } = renderInput()
    fireEvent.drop(textarea, { dataTransfer: { files: [new File(['x'], 'doc.pdf')] } })
    await vi.waitFor(() => expect(textarea.value).toContain('[📎 004-doc.pdf]'))
    spy.mockRestore()
  })

  it('erro de upload mostra aviso e não insere token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'arquivo grande demais (máx. 100 MB)' }), { status: 413, headers: { 'Content-Type': 'application/json' } }),
    )
    const { textarea } = renderInput()
    fireEvent.paste(textarea, { clipboardData: { files: [new File(['x'], 'big.iso')] } })
    await vi.waitFor(() => expect(screen.getByText(/grande demais/)).toBeTruthy())
    expect(textarea.value).toBe('')
    spy.mockRestore()
  })
})
