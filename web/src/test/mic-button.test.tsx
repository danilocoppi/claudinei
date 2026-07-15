import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { MicButton, type MicDeps } from '../components/MicButton'

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

const SPEECH = new Float32Array(1000).fill(0.1) // RMS 0.1 — fala saudável

function makeDeps(text = 'olá mundo', pcm: Float32Array = SPEECH) {
  const stop = vi.fn(() => pcm)
  const deps: MicDeps = {
    startMicCapture: vi.fn(async () => ({ stop })),
    transcribeAudio: vi.fn(async () => ({ text })),
  }
  return { deps, stop }
}

describe('MicButton (transcrição no servidor)', () => {
  it('não renderiza sem suporte a microfone', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    const { container } = render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={makeDeps().deps} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('gravar → parar → envia WAV ao servidor → onText(texto) + onDone', async () => {
    const onText = vi.fn(); const onDone = vi.fn()
    const { deps, stop } = makeDeps('texto final pontuado.')
    render(<MicButton onText={onText} onDone={onDone} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    expect(deps.transcribeAudio).not.toHaveBeenCalled() // nada ao vivo
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onText).toHaveBeenCalledWith('texto final pontuado.'))
    expect(stop).toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
    const sent = (deps.transcribeAudio as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob
    expect(sent.type).toBe('audio/wav')
  })

  it('mostra o estado transcrevendo entre o parar e a resposta', async () => {
    let release!: (v: { text: string }) => void
    const deps: MicDeps = {
      startMicCapture: vi.fn(async () => ({ stop: () => SPEECH })),
      transcribeAudio: vi.fn(() => new Promise<{ text: string }>((r) => { release = r })),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('…'))
    release({ text: 'x' })
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('🎤'))
  })

  it('sinal quase mudo → errLowSignal, sem chamar o servidor', async () => {
    const onError = vi.fn()
    const { deps } = makeDeps('x', new Float32Array(1000).fill(0.001))
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Sinal do microfone muito baixo — verifique o ganho/volume do mic.'))
    expect(deps.transcribeAudio).not.toHaveBeenCalled()
  })

  it('falha do servidor → errTranscribe e volta a idle', async () => {
    const onError = vi.fn()
    const deps: MicDeps = {
      startMicCapture: vi.fn(async () => ({ stop: () => SPEECH })),
      transcribeAudio: vi.fn(async () => { throw new Error('offline') }),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('A transcrição falhou — o servidor está no ar com o modelo instalado?'))
    expect(screen.getByRole('button').textContent).toContain('🎤')
  })

  it('permissão negada → errPermission', async () => {
    const onError = vi.fn()
    const deps: MicDeps = {
      startMicCapture: vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
      transcribeAudio: vi.fn(),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Permita o microfone para gravar.'))
  })

  it('onStart dispara quando a gravação começa', async () => {
    const onStart = vi.fn()
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} onStart={onStart} deps={makeDeps().deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
  })

  it('desmontar durante a gravação libera o microfone', async () => {
    const { deps, stop } = makeDeps()
    const { unmount } = render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(deps.startMicCapture).toHaveBeenCalled())
    unmount()
    expect(stop).toHaveBeenCalled()
  })

  it('ao vivo: tick do buffer gera POST parcial e onText durante a gravação', async () => {
    const onText = vi.fn()
    let feed: ((pcm: Float32Array) => void) | null = null
    const deps: MicDeps = {
      startMicCapture: vi.fn(async (onBuffer: (pcm: Float32Array) => void) => { feed = onBuffer; return { stop: () => SPEECH } }),
      transcribeAudio: vi.fn(async () => ({ text: 'parcial ao vivo' })),
    }
    render(<MicButton onText={onText} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(feed).not.toBeNull())
    feed!(SPEECH) // tick do recorder com o buffer acumulado
    await waitFor(() => expect(onText).toHaveBeenCalledWith('parcial ao vivo'))
    const sent = (deps.transcribeAudio as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob
    expect(sent.type).toBe('audio/wav')
    // continua gravando (⏺), não foi para transcribing
    expect(screen.getByRole('button').textContent).toContain('⏺')
  })

  it('ao vivo: backpressure — tick com parcial em voo é ignorado', async () => {
    let feed: ((pcm: Float32Array) => void) | null = null
    let release!: (v: { text: string }) => void
    const deps: MicDeps = {
      startMicCapture: vi.fn(async (onBuffer: (pcm: Float32Array) => void) => { feed = onBuffer; return { stop: () => SPEECH } }),
      transcribeAudio: vi.fn(() => new Promise<{ text: string }>((r) => { release = r })),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(feed).not.toBeNull())
    feed!(SPEECH)
    await waitFor(() => expect(deps.transcribeAudio).toHaveBeenCalledTimes(1))
    feed!(SPEECH) // 2º tick com a 1ª parcial pendente → ignorado
    feed!(SPEECH) // 3º idem
    expect(deps.transcribeAudio).toHaveBeenCalledTimes(1)
    release({ text: 'x' })
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    feed!(SPEECH) // trava liberada → novo tick passa
    await waitFor(() => expect(deps.transcribeAudio).toHaveBeenCalledTimes(2))
  })

  it('ao vivo: parcial que resolve após o parar é descartada (a final vence)', async () => {
    const onText = vi.fn()
    let feed: ((pcm: Float32Array) => void) | null = null
    let releasePartial!: (v: { text: string }) => void
    const transcribeAudio = vi.fn()
      .mockImplementationOnce(() => new Promise<{ text: string }>((r) => { releasePartial = r })) // parcial (pendente)
      .mockResolvedValue({ text: 'FINAL' })
    const deps: MicDeps = {
      startMicCapture: vi.fn(async (onBuffer: (pcm: Float32Array) => void) => { feed = onBuffer; return { stop: () => SPEECH } }),
      transcribeAudio,
    }
    render(<MicButton onText={onText} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(feed).not.toBeNull())
    feed!(SPEECH) // parcial fica pendente
    await waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button')) // para → final
    await waitFor(() => expect(onText).toHaveBeenCalledWith('FINAL'))
    releasePartial({ text: 'PARCIAL-ATRASADA' })
    await Promise.resolve(); await Promise.resolve()
    expect(onText).not.toHaveBeenCalledWith('PARCIAL-ATRASADA')
    expect(onText.mock.calls.at(-1)?.[0]).toBe('FINAL')
  })

  it('ao vivo: tick quase mudo não gera POST', async () => {
    let feed: ((pcm: Float32Array) => void) | null = null
    const deps: MicDeps = {
      startMicCapture: vi.fn(async (onBuffer: (pcm: Float32Array) => void) => { feed = onBuffer; return { stop: () => SPEECH } }),
      transcribeAudio: vi.fn(async () => ({ text: 'x' })),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(feed).not.toBeNull())
    feed!(new Float32Array(1000).fill(0.001)) // só ruído de fundo
    await Promise.resolve(); await Promise.resolve()
    expect(deps.transcribeAudio).not.toHaveBeenCalled()
  })

  it('ao vivo: falha da parcial é silenciosa (sem onError) e a gravação segue', async () => {
    const onError = vi.fn()
    let feed: ((pcm: Float32Array) => void) | null = null
    const transcribeAudio = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))   // parcial falha
      .mockResolvedValue({ text: 'FINAL-OK' })       // final funciona
    const deps: MicDeps = {
      startMicCapture: vi.fn(async (onBuffer: (pcm: Float32Array) => void) => { feed = onBuffer; return { stop: () => SPEECH } }),
      transcribeAudio,
    }
    const onText = vi.fn()
    render(<MicButton onText={onText} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(feed).not.toBeNull())
    feed!(SPEECH)
    await waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    expect(onError).not.toHaveBeenCalled() // silêncio na parcial
    expect(screen.getByRole('button').textContent).toContain('⏺') // segue gravando
    fireEvent.click(screen.getByRole('button')) // stop normal funciona
    await waitFor(() => expect(onText).toHaveBeenCalledWith('FINAL-OK'))
    expect(onError).not.toHaveBeenCalled()
  })

  it('regravação rápida: resposta atrasada da sessão anterior é descartada', async () => {
    const onText = vi.fn()
    let releaseA!: (v: { text: string }) => void
    const transcribeAudio = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { releaseA = r }))
      .mockResolvedValue({ text: 'B' })
    const deps: MicDeps = { startMicCapture: vi.fn(async () => ({ stop: () => SPEECH })), transcribeAudio }
    render(<MicButton onText={onText} onDone={vi.fn()} onError={vi.fn()} deps={deps} />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn) // grava A
    await waitFor(() => expect(deps.startMicCapture).toHaveBeenCalledTimes(1))
    fireEvent.click(btn) // para A → POST pendente
    await waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    fireEvent.click(btn) // grava B
    await waitFor(() => expect(deps.startMicCapture).toHaveBeenCalledTimes(2))
    releaseA({ text: 'A-ATRASADO' })
    await Promise.resolve(); await Promise.resolve()
    expect(onText).not.toHaveBeenCalledWith('A-ATRASADO')
  })

  it('falha de captura (não-permissão) → errCapture, não aponta para o servidor', async () => {
    const onError = vi.fn()
    const deps: MicDeps = {
      startMicCapture: vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { name: 'NotFoundError' })),
      transcribeAudio: vi.fn(),
    }
    render(<MicButton onText={vi.fn()} onDone={vi.fn()} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Não foi possível acessar o microfone (ocupado ou indisponível).'))
  })

  it('desmontar durante a transcrição suprime os callbacks da sessão morta', async () => {
    const onText = vi.fn(); const onDone = vi.fn(); const onError = vi.fn()
    let release!: (v: { text: string }) => void
    const deps: MicDeps = {
      startMicCapture: vi.fn(async () => ({ stop: () => SPEECH })),
      transcribeAudio: vi.fn(() => new Promise<{ text: string }>((r) => { release = r })),
    }
    const { unmount } = render(<MicButton onText={onText} onDone={onDone} onError={onError} deps={deps} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('⏺'))
    fireEvent.click(screen.getByRole('button')) // para → POST pendente
    await waitFor(() => expect(deps.transcribeAudio).toHaveBeenCalled())
    unmount()
    release({ text: 'TARDE-DEMAIS' })
    await Promise.resolve(); await Promise.resolve()
    expect(onText).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
