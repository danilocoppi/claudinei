import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useRef } from 'react'
import { MicButton, type MicDeps } from '../components/MicButton'

/**
 * Ctrl+Espaço aciona o 🎤 do chat. Toque rápido liga e o próximo atalho para;
 * segurar (0,4 s ou mais) grava só enquanto as teclas estão apertadas.
 */
const SPEECH = new Float32Array(1000).fill(0.1)
let agora = 1_000

beforeEach(() => {
  agora = 1_000
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

function makeDeps(start?: MicDeps['startMicCapture']) {
  const stop = vi.fn(() => SPEECH)
  const deps: MicDeps = {
    startMicCapture: start ?? vi.fn(async () => ({ stop })),
    transcribeAudio: vi.fn(async () => ({ text: 'ditado' })),
    now: () => agora,
  }
  return { deps, stop }
}

function Chat({ deps, onText, disabled }: { deps: MicDeps; onText: (t: string) => void; disabled?: boolean }) {
  const field = useRef<HTMLTextAreaElement>(null)
  return (
    <div>
      <textarea ref={field} aria-label="mensagem" />
      <input aria-label="busca da lateral" />
      <button type="button">outro botão</button>
      <MicButton field={field} disabled={disabled} onText={onText} onDone={vi.fn()} onError={vi.fn()} deps={deps} />
    </div>
  )
}

const mic = () => screen.getByRole('button', { name: /Gravar áudio|Parar gravação|transcrevendo/ })
const gravando = () => mic().textContent?.includes('⏺')
const down = (target: Element = document.body, extra: object = {}) =>
  fireEvent.keyDown(target, { key: ' ', code: 'Space', ctrlKey: true, ...extra })
const up = (target: Element = document.body, extra: object = {}) =>
  fireEvent.keyUp(target, { key: ' ', code: 'Space', ctrlKey: true, ...extra })

describe('Ctrl+Espaço no microfone', () => {
  it('toque rápido liga e continua gravando; o próximo Ctrl+Espaço para e transcreve', async () => {
    const onText = vi.fn()
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={onText} />)
    down(); agora += 120; up()
    await waitFor(() => expect(gravando()).toBe(true))
    agora += 3_000
    down(); up()
    await waitFor(() => expect(onText).toHaveBeenCalledWith('ditado'))
    expect(deps.startMicCapture).toHaveBeenCalledTimes(1)
  })

  it('segurando, grava só enquanto as teclas estão apertadas', async () => {
    const onText = vi.fn()
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={onText} />)
    down()
    await waitFor(() => expect(gravando()).toBe(true))
    agora += 900
    up()
    await waitFor(() => expect(onText).toHaveBeenCalledWith('ditado'))
  })

  it('soltar o Ctrl antes do Espaço também conta como soltar', async () => {
    const onText = vi.fn()
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={onText} />)
    down()
    await waitFor(() => expect(gravando()).toBe(true))
    agora += 900
    fireEvent.keyUp(document.body, { key: 'Control', code: 'ControlLeft' })
    await waitFor(() => expect(onText).toHaveBeenCalledWith('ditado'))
  })

  it('a repetição do teclado com as teclas apertadas não reinicia nem para', async () => {
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} />)
    down()
    for (let i = 0; i < 4; i++) down(document.body, { repeat: true })
    await waitFor(() => expect(gravando()).toBe(true))
    expect(deps.startMicCapture).toHaveBeenCalledTimes(1)
  })

  it('não digita o espaço nem rola a página', () => {
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} />)
    expect(down(screen.getByLabelText('mensagem'))).toBe(false) // false = preventDefault
  })

  it('a partir de qualquer ponto da página, leva o foco ao campo do chat', async () => {
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} />)
    const outro = screen.getByRole('button', { name: 'outro botão' })
    outro.focus()
    down(outro); agora += 100; up(outro)
    await waitFor(() => expect(gravando()).toBe(true))
    expect(document.activeElement).toBe(screen.getByLabelText('mensagem'))
  })

  it('com o foco em outro campo, o atalho é dele: não grava nem impede a tecla', () => {
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} />)
    expect(down(screen.getByLabelText('busca da lateral'))).toBe(true)
    expect(deps.startMicCapture).not.toHaveBeenCalled()
  })

  it('com o chat desabilitado (sessão parada), não grava', () => {
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} disabled />)
    expect(down()).toBe(true)
    expect(deps.startMicCapture).not.toHaveBeenCalled()
  })

  it('outras combinações (Ctrl+Shift+Espaço, Espaço sozinho) não fazem nada', () => {
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} />)
    down(document.body, { shiftKey: true })
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' })
    expect(deps.startMicCapture).not.toHaveBeenCalled()
  })

  it('sair da janela segurando as teclas conta como soltar', async () => {
    const onText = vi.fn()
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={onText} />)
    down()
    await waitFor(() => expect(gravando()).toBe(true))
    agora += 900
    fireEvent.blur(window)
    await waitFor(() => expect(onText).toHaveBeenCalledWith('ditado'))
  })

  it('soltar antes de o microfone abrir cancela: a gravação não começa sozinha depois', async () => {
    let abrir!: () => void
    const stop = vi.fn(() => SPEECH)
    const { deps } = makeDeps(vi.fn(() => new Promise<{ stop: () => Float32Array }>((r) => { abrir = () => r({ stop }) })))
    render(<Chat deps={deps} onText={vi.fn()} />)
    down()
    agora += 900
    up()
    await act(async () => { abrir() })
    expect(stop).toHaveBeenCalled() // microfone liberado assim que abriu
    expect(gravando()).toBe(false)
  })

  it('a dica do botão ensina o atalho', () => {
    render(<Chat deps={makeDeps().deps} onText={vi.fn()} />)
    expect(mic().getAttribute('title')).toMatch(/Ctrl\+Espaço/)
  })
})
