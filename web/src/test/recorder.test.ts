import { describe, it, expect, afterEach, vi } from 'vitest'
import { micSupported, concatFloat32, startMicCapture, MAX_CAPTURE_SAMPLES } from '../speech/recorder'

describe('concatFloat32', () => {
  it('junta vários chunks preservando a ordem', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })
  it('lista vazia → Float32Array vazio', () => {
    expect(concatFloat32([]).length).toBe(0)
  })
})

describe('micSupported', () => {
  const original = navigator.mediaDevices
  afterEach(() => { Object.defineProperty(navigator, 'mediaDevices', { value: original, configurable: true }) })

  it('true quando há getUserMedia', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => {} }, configurable: true })
    expect(micSupported()).toBe(true)
  })
  it('false quando não há mediaDevices', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    expect(micSupported()).toBe(false)
  })
})

describe('startMicCapture (M17: buffer incremental + teto de gravação)', () => {
  class FakeNode {
    connect = vi.fn()
    disconnect = vi.fn()
  }
  type Processor = FakeNode & { onaudioprocess: ((e: { inputBuffer: { getChannelData(i: number): Float32Array } }) => void) | null }
  class FakeAudioContext {
    static last: FakeAudioContext | null = null
    destination = {}
    processor: Processor = Object.assign(new FakeNode(), { onaudioprocess: null })
    close = vi.fn(() => Promise.resolve())
    constructor() { FakeAudioContext.last = this }
    createMediaStreamSource() { return new FakeNode() }
    createScriptProcessor() { return this.processor }
    createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }) }
  }
  const trackStop = vi.fn()
  const original = navigator.mediaDevices

  const setup = () => {
    vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
      configurable: true,
    })
  }
  const feed = (samples: Float32Array) =>
    FakeAudioContext.last!.processor.onaudioprocess!({ inputBuffer: { getChannelData: () => samples } })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'mediaDevices', { value: original, configurable: true })
  })

  it('acumula incrementalmente (dobra a capacidade) e stop() devolve tudo na ordem', async () => {
    setup()
    const handle = await startMicCapture(() => {})
    feed(new Float32Array(600_000).fill(1))
    feed(new Float32Array(600_000).fill(2)) // estoura a capacidade inicial (~1 min) → dobra
    const out = handle.stop()
    expect(out.length).toBe(1_200_000)
    expect(out[0]).toBe(1)
    expect(out[599_999]).toBe(1)
    expect(out[600_000]).toBe(2)
    expect(out[1_199_999]).toBe(2)
  })

  it('tick periódico entrega o acumulado (subarray do cumulativo, sem recópia total)', async () => {
    vi.useFakeTimers()
    try {
      setup()
      const onBuffer = vi.fn()
      const handle = await startMicCapture(onBuffer, 1500)
      feed(new Float32Array([1, 2, 3]))
      vi.advanceTimersByTime(1500)
      expect(onBuffer).toHaveBeenCalledTimes(1)
      expect(Array.from(onBuffer.mock.calls[0][0] as Float32Array)).toEqual([1, 2, 3])
      handle.stop()
      vi.advanceTimersByTime(3000)
      expect(onBuffer).toHaveBeenCalledTimes(1) // stop() encerra o timer
    } finally {
      vi.useRealTimers()
    }
  })

  it('ao atingir o teto (~10 min) para sozinho, libera o mic e entrega o buffer final via onBuffer', async () => {
    setup()
    const onBuffer = vi.fn()
    const handle = await startMicCapture(onBuffer)
    feed(new Float32Array(MAX_CAPTURE_SAMPLES + 5)) // excedente ao teto é descartado
    expect(onBuffer).toHaveBeenCalledTimes(1)
    expect((onBuffer.mock.calls[0][0] as Float32Array).length).toBe(MAX_CAPTURE_SAMPLES)
    expect(trackStop).toHaveBeenCalled() // microfone liberado como no stop()
    feed(new Float32Array([9, 9])) // captura já parou — ignorado
    expect(handle.stop().length).toBe(MAX_CAPTURE_SAMPLES)
  })
})
