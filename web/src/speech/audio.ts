/**
 * Normaliza o pico do PCM para ~0.95. O Whisper degrada muito com áudio de nível
 * baixo (mic com ganho fraco); normalizar recupera esses casos e é inócuo para
 * áudio saudável. Silêncio (pico ~0) é devolvido intacto para não amplificar ruído puro.
 */
export function normalizePeak(pcm: Float32Array, target = 0.95): Float32Array {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i])
    if (v > peak) peak = v
  }
  if (peak < 1e-4 || peak >= target) return pcm // silêncio real ou já forte
  const gain = target / peak
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * gain
  return out
}

/** RMS do buffer (nível médio do sinal). Usado para detectar mic quase mudo. */
export function rmsOf(pcm: Float32Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / pcm.length)
}
