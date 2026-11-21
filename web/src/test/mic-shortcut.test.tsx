import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useRef } from 'react'
import { MicButton, type MicDeps } from '../components/MicButton'
import { ConfirmDialog } from '../components/ConfirmDialog'

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

  it('com o foco num diálogo, o atalho é dele: não grava nem impede a tecla', () => {
    const { deps } = makeDeps()
    render(
      <>
        <Chat deps={deps} onText={vi.fn()} />
        <div role="dialog" aria-modal="true"><button type="button">no diálogo</button></div>
      </>,
    )
    expect(down(screen.getByRole('button', { name: 'no diálogo' }))).toBe(true)
    expect(deps.startMicCapture).not.toHaveBeenCalled()
  })

  it('com o ConfirmDialog aberto e o foco fora dele (no body), o atalho é do modal: não grava nem impede a tecla', () => {
    const { deps } = makeDeps()
    render(
      <>
        <Chat deps={deps} onText={vi.fn()} />
        <ConfirmDialog title="Trocar de motor?" message="A conversa passa para o Codex." onConfirm={vi.fn()} onClose={vi.fn()} />
      </>,
    )
    expect(down()).toBe(true)
    expect(down(screen.getByRole('button', { name: 'outro botão' }))).toBe(true)
    expect(deps.startMicCapture).not.toHaveBeenCalled()
  })

  it('um role="dialog" não modal na página (o menu de menção de arquivo) não impede ligar de fora dele', async () => {
    const { deps } = makeDeps()
    render(
      <>
        <Chat deps={deps} onText={vi.fn()} />
        <div className="file-mention" role="dialog" aria-label="Arquivos"><button type="button">a.ts</button></div>
      </>,
    )
    expect(down()).toBe(false)
    agora += 100; up()
    await waitFor(() => expect(gravando()).toBe(true))
  })

  // Ligar fica bloqueado num modal, mas PARAR não: a gravação em curso não pode
  // ficar presa porque um diálogo se abriu por cima.
  it('gravando, com o foco num diálogo, Ctrl+Espaço para (e consome a tecla)', async () => {
    const onText = vi.fn()
    const { deps } = makeDeps()
    const tela = (dialogo: boolean) => (
      <>
        <Chat deps={deps} onText={onText} />
        {dialogo && <div role="dialog" aria-modal="true"><button type="button">no diálogo</button></div>}
      </>
    )
    const { rerender } = render(tela(false))
    down(); agora += 120; up()
    await waitFor(() => expect(gravando()).toBe(true))
    rerender(tela(true))
    const noDialogo = screen.getByRole('button', { name: 'no diálogo' })
    agora += 2_000
    expect(down(noDialogo), 'a tecla parou a gravação: não aperta o botão do diálogo').toBe(false)
    up(noDialogo)
    await waitFor(() => expect(onText).toHaveBeenCalledWith('ditado'))
    // Parado, o próximo Ctrl+Espaço no diálogo não liga de novo.
    expect(down(noDialogo)).toBe(true)
    expect(deps.startMicCapture).toHaveBeenCalledTimes(1)
  })

  it('gravando, com o ConfirmDialog aberto e o foco no body, Ctrl+Espaço para', async () => {
    const onText = vi.fn()
    const { deps } = makeDeps()
    const tela = (confirmando: boolean) => (
      <>
        <Chat deps={deps} onText={onText} />
        {confirmando && <ConfirmDialog title="Trocar de motor?" message="A conversa passa para o Codex." onConfirm={vi.fn()} onClose={vi.fn()} />}
      </>
    )
    const { rerender } = render(tela(false))
    down(); agora += 120; up()
    await waitFor(() => expect(gravando()).toBe(true))
    rerender(tela(true))
    agora += 2_000
    expect(down()).toBe(false)
    up()
    await waitFor(() => expect(onText).toHaveBeenCalledWith('ditado'))
  })

  it('gravando, com o foco em outro campo de texto, a tecla continua dele: não para', async () => {
    const { deps } = makeDeps()
    render(<Chat deps={deps} onText={vi.fn()} />)
    down(); agora += 120; up()
    await waitFor(() => expect(gravando()).toBe(true))
    agora += 2_000
    expect(down(screen.getByLabelText('busca da lateral'))).toBe(true)
    expect(gravando()).toBe(true)
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
