import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../speech/recorder', () => ({
  micSupported: () => true,
  startMicCapture: vi.fn(async () => ({ stop: () => new Float32Array(1000).fill(0.1) })), // RMS saudável
}))

import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { startMicCapture } from '../speech/recorder'
import type { MicDeps } from '../components/MicButton'

/**
 * Ctrl+Enter envia a mensagem do chat de qualquer ponto da tela, como o Enter no
 * campo. Ditando, o envio espera a transcrição final — senão iria só o parcial e
 * o final cairia depois no campo vazio, repetindo o que foi dito.
 */
const transcribeAudio = vi.fn<MicDeps['transcribeAudio']>()

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ chat: {}, sessions: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
  vi.clearAllMocks()
  transcribeAudio.mockResolvedValue({ text: 'ditado final' })
})
afterEach(() => cleanup())

function renderInput() {
  const send = vi.fn()
  render(
    <WsContext.Provider value={{ send }}>
      <input aria-label="busca da lateral" />
      <ChatInput localId="s1" disabled={false} micDeps={{ startMicCapture, transcribeAudio }} />
    </WsContext.Provider>,
  )
  return send
}
const campo = () => screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
const ctrlEnter = (alvo: Element = document.body) => fireEvent.keyDown(alvo, { key: 'Enter', code: 'Enter', ctrlKey: true })
const enviados = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map(([m]) => m as { type: string; text?: string }).filter((m) => m.type === 'send_message')
const mic = () => screen.getByRole('button', { name: /Gravar áudio|Parar gravação|transcrevendo/ })

describe('Ctrl+Enter envia de qualquer ponto da tela', () => {
  it('com o foco fora do campo, envia o que está escrito', () => {
    const send = renderInput()
    fireEvent.change(campo(), { target: { value: 'oi' } })
    expect(ctrlEnter(document.body)).toBe(false) // false = preventDefault
    expect(enviados(send)).toEqual([{ type: 'send_message', localId: 's1', text: 'oi' }])
    expect(campo().value).toBe('')
  })

  it('dentro do campo continua enviando uma vez só', () => {
    const send = renderInput()
    fireEvent.change(campo(), { target: { value: 'oi' } })
    ctrlEnter(campo())
    expect(enviados(send)).toHaveLength(1)
  })

  it('com o foco em outro campo, o atalho é dele: não envia nem impede a tecla', () => {
    const send = renderInput()
    fireEvent.change(campo(), { target: { value: 'oi' } })
    expect(ctrlEnter(screen.getByLabelText('busca da lateral'))).toBe(true)
    expect(enviados(send)).toEqual([])
  })

  it('campo vazio não envia nada', () => {
    const send = renderInput()
    ctrlEnter(document.body)
    expect(send).not.toHaveBeenCalled()
  })

  it('!comando roda no terminal, como pelo Enter', () => {
    const send = renderInput()
    fireEvent.change(campo(), { target: { value: '!ls' } })
    ctrlEnter(document.body)
    expect(send).toHaveBeenCalledWith({ type: 'shell', localId: 's1', command: 'ls' })
  })
})

describe('enviar enquanto dita', () => {
  const gravar = async () => {
    fireEvent.click(mic())
    await waitFor(() => expect(mic().textContent).toContain('⏺'))
  }

  it('Ctrl+Enter com o foco no 🎤 encerra a gravação e envia a transcrição final', async () => {
    const send = renderInput()
    await gravar()
    mic().focus()
    ctrlEnter(mic())
    await waitFor(() => expect(enviados(send)).toEqual([{ type: 'send_message', localId: 's1', text: 'ditado final' }]))
    expect(campo().value).toBe('')
    expect(mic().textContent).toContain('🎤')
  })

  it('o Enter no campo também espera: vai a mensagem inteira, e o campo não recebe o ditado de novo', async () => {
    const send = renderInput()
    fireEvent.change(campo(), { target: { value: 'nota:' } })
    campo().setSelectionRange(5, 5)
    await gravar()
    fireEvent.keyDown(campo(), { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(enviados(send)).toHaveLength(1))
    expect(enviados(send)[0].text).toBe('nota: ditado final')
    await new Promise((r) => setTimeout(r, 30))
    expect(campo().value).toBe('')
  })

  it('o botão Enviar também espera a transcrição', async () => {
    const send = renderInput()
    await gravar()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(enviados(send)).toEqual([{ type: 'send_message', localId: 's1', text: 'ditado final' }]))
  })

  it('se a transcrição falhar, nada é enviado e o erro aparece', async () => {
    transcribeAudio.mockRejectedValue(new Error('caiu'))
    const send = renderInput()
    await gravar()
    ctrlEnter(document.body)
    await waitFor(() => expect(screen.getByText(/A transcrição falhou/)).toBeTruthy())
    expect(enviados(send)).toEqual([])
  })
})
