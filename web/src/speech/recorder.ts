/** Captura do microfone como PCM 16kHz mono para o Whisper. */

export interface MicHandle {
  /** Encerra a captura e devolve o buffer final acumulado. Idempotente. */
  stop: () => Float32Array
}

/** Teto de gravação: ~10 min a 16kHz. Atingido, a captura para sozinha (o último
 *  `onBuffer` entrega o acumulado) — sem teto, um mic esquecido ligado cresceria
 *  o buffer sem limite. */
export const MAX_CAPTURE_SAMPLES = 16000 * 600

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
 *
 * O acúmulo é INCREMENTAL: um único Float32Array com capacidade dobrada sob
 * demanda, copiando só o chunk novo (concatenar tudo a cada tick era O(n²)).
 * Os callbacks recebem `subarray` do cumulativo — os consumidores só leem.
 * Ao atingir MAX_CAPTURE_SAMPLES a captura para como o stop() pararia e o
 * buffer final é entregue num último `onBuffer`.
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

  let buf = new Float32Array(16000 * 60) // capacidade inicial ~1 min; dobra sob demanda
  let len = 0
  const append = (chunk: Float32Array) => {
    if (len + chunk.length > buf.length) {
      let cap = buf.length * 2
      while (cap < len + chunk.length) cap *= 2
      const bigger = new Float32Array(cap)
      bigger.set(buf.subarray(0, len))
      buf = bigger
    }
    buf.set(chunk, len)
    len += chunk.length
  }

  let stopped = false
  const teardown = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    processor.disconnect()
    source.disconnect()
    mute.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ac.close()
  }

  processor.onaudioprocess = (e) => {
    if (stopped) return
    const data = e.inputBuffer.getChannelData(0)
    const room = MAX_CAPTURE_SAMPLES - len
    append(room < data.length ? data.subarray(0, room) : data)
    if (len >= MAX_CAPTURE_SAMPLES) {
      // teto atingido: libera mic/áudio como o stop() faria e sinaliza pelo
      // mesmo canal dos ticks — o operador ainda transcreve tudo ao parar.
      teardown()
      onBuffer(buf.subarray(0, len))
    }
  }
  source.connect(processor)
  processor.connect(mute)
  mute.connect(ac.destination)
  const timer = setInterval(() => onBuffer(buf.subarray(0, len)), intervalMs)

  return {
    stop() {
      teardown()
      return buf.subarray(0, len)
    },
  }
}
