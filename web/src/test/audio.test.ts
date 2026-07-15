import { describe, it, expect } from 'vitest'
import { normalizePeak, rmsOf } from '../speech/audio'

describe('normalizePeak', () => {
  it('amplifica áudio baixo para pico ~0.95 (mic com ganho fraco)', () => {
    const out = normalizePeak(new Float32Array([0.005, -0.01, 0.002]))
    expect(Math.max(...Array.from(out).map(Math.abs))).toBeCloseTo(0.95, 5)
    // proporções preservadas
    expect(out[0] / out[1]).toBeCloseTo(-0.5, 5)
  })
  it('áudio já forte volta intacto (mesma referência)', () => {
    const pcm = new Float32Array([0.96, -0.5])
    expect(normalizePeak(pcm)).toBe(pcm)
  })
  it('silêncio real (pico ~0) não é amplificado', () => {
    const pcm = new Float32Array([0.00005, -0.00003])
    expect(normalizePeak(pcm)).toBe(pcm)
  })
  it('buffer vazio volta intacto', () => {
    const pcm = new Float32Array(0)
    expect(normalizePeak(pcm)).toBe(pcm)
  })
})

describe('rmsOf', () => {
  it('calcula o RMS', () => {
    expect(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 5)
  })
  it('buffer vazio → 0', () => {
    expect(rmsOf(new Float32Array(0))).toBe(0)
  })
})
