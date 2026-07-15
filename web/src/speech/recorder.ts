/** Captura do microfone como PCM 16kHz mono para o Whisper. */

export interface MicHandle {
  /** Encerra a captura e devolve o buffer final acumulado. Idempotente. */
  stop: () => Float32Array
}

/** Há suporte a captura de microfone neste navegador? */
export function micSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

/** Concatena chunks Float32 num único buffer, preservando a ordem. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Float32Array(len)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * Começa a capturar o microfone. A cada `intervalMs`, chama `onBuffer` com o
 * buffer PCM acumulado (16kHz mono). Retorna um handle cujo `stop()` encerra
 * tudo e devolve o buffer final. Camada fina sobre Web Audio — smoke manual.
 */
export async function startMicCapture(
  onBuffer: (pcm: Float32Array) => void,
  intervalMs = 1500,
): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ac = new Ctx({ sampleRate: 16000 })
  const source = ac.createMediaStreamSource(stream)
  const processor = ac.createScriptProcessor(4096, 1, 1)
  const mute = ac.createGain()
  mute.gain.value = 0 // evita eco: processa sem tocar o som de volta
  const chunks: Float32Array[] = []
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  source.connect(processor)
  processor.connect(mute)
  mute.connect(ac.destination)
  const timer = setInterval(() => onBuffer(concatFloat32(chunks)), intervalMs)

  let stopped = false
  return {
    stop() {
      if (!stopped) {
        stopped = true
        clearInterval(timer)
        processor.disconnect()
        source.disconnect()
        mute.disconnect()
        stream.getTracks().forEach((t) => t.stop())
        void ac.close()
      }
      return concatFloat32(chunks)
    },
  }
}
