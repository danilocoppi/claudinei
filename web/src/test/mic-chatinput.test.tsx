import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

// Mocka a captura de microfone para o MicButton real rodar sem tocar Web Audio.
// transcribeAudio (transcrição no servidor) é injetado via prop (micDeps) — o
// mock direto do módulo '../api' não é necessário porque o ChatInput repassa
// micDeps.transcribeAudio direto para o MicButton, sem passar pelo default real.
vi.mock('../speech/recorder', () => ({
  micSupported: () => true,
  startMicCapture: vi.fn(async () => ({ stop: () => new Float32Array(1000).fill(0.1) })), // RMS saudável
}))

import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { startMicCapture } from '../speech/recorder'
import type { MicDeps } from '../components/MicButton'

beforeEach(() => {
  useStore.setState({ chat: {}, sessions: {}, unread: {}, streaming: {}, historyLoadedFor: {} })
  // limpa o histórico de chamadas entre testes (os mocks de módulo são
  // compartilhados pelo arquivo inteiro) sem descartar a implementação padrão.
  vi.clearAllMocks()
  transcribeAudio.mockResolvedValue({ text: 'ditado' })
})
afterEach(() => cleanup())

const transcribeAudio = vi.fn<MicDeps['transcribeAudio']>().mockResolvedValue({ text: 'ditado' })

const renderInput = () =>
  render(
    <WsContext.Provider value={{ send: vi.fn() }}>
      <ChatInput localId="s1" disabled={false} micDeps={{ startMicCapture, transcribeAudio }} />
    </WsContext.Provider>,
  )

describe('microfone no ChatInput', () => {
  it('transcrição entra no campo na posição do cursor', async () => {
    renderInput()
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'nota:' } })
    textarea.setSelectionRange(5, 5)
    const btn = screen.getByLabelText('Gravar áudio')
    fireEvent.click(btn) // grava
    await waitFor(() => expect(startMicCapture).toHaveBeenCalled())
    fireEvent.click(btn) // para → envia ao servidor → 'ditado'
    await waitFor(() => expect(textarea.value).toBe('nota: ditado'))
  })

  // Regressão: parar a 1ª gravação deixa um POST pendente (server ainda não
  // respondeu); regravar rápido (2ª sessão) não pode ser sobrescrita nem
  // duplicada quando a resposta atrasada da 1ª finalmente chega. O MicButton
  // já descarta a resposta atrasada via genRef; este teste garante que o
  // encaixe com o ChatInput (captureMicBase em cada onStart, endMic em onDone)
  // não deixa vazar texto da sessão superada nem duplica a base da nova.
  it('parar A com POST pendente, gravar e parar B: resposta atrasada de A não sobrescreve nem duplica', async () => {
    let releaseA!: (v: { text: string }) => void
    transcribeAudio
      .mockImplementationOnce(() => new Promise((r) => { releaseA = r }))
      .mockResolvedValueOnce({ text: 'dois' })

    renderInput()
    const textarea = screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
    const btn = screen.getByLabelText('Gravar áudio')

    fireEvent.click(btn) // grava A
    await waitFor(() => expect(startMicCapture).toHaveBeenCalledTimes(1))
    fireEvent.click(btn) // para A → POST pendente (fica preso em releaseA)
    await waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))

    fireEvent.click(btn) // grava B (clique durante "transcrevendo" invalida A)
    await waitFor(() => expect(startMicCapture).toHaveBeenCalledTimes(2))
    fireEvent.click(btn) // para B → POST resolve 'dois' de imediato
    await waitFor(() => expect(textarea.value).toBe('dois'))

    releaseA({ text: 'um' }) // resposta atrasada de A finalmente chega
    await Promise.resolve(); await Promise.resolve()
    expect(textarea.value).toBe('dois') // nem sobrescrita nem duplicada
  })
})
