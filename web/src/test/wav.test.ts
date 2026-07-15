import { describe, it, expect } from 'vitest'
import { pcmToWav } from '../speech/wav'

async function bytes(b: Blob): Promise<DataView> {
  return new DataView(await b.arrayBuffer())
}

describe('pcmToWav', () => {
  it('gera header RIFF/WAVE correto para 16kHz mono PCM16', async () => {
    const blob = pcmToWav(new Float32Array([0, 0.5, -0.5, 1]))
    expect(blob.type).toBe('audio/wav')
    const v = await bytes(blob)
    const str = (off: number, len: number) => Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('')
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 4)).toBe('WAVE')
    expect(str(12, 4)).toBe('fmt ')
    expect(v.getUint32(4, true)).toBe(36 + 8) // riff size = 36 + dados (4 amostras × 2 bytes)
    expect(v.getUint16(20, true)).toBe(1)      // PCM
    expect(v.getUint16(22, true)).toBe(1)      // mono
    expect(v.getUint32(24, true)).toBe(16000)  // sample rate
    expect(v.getUint32(28, true)).toBe(32000)  // byte rate = rate × 2
    expect(v.getUint16(32, true)).toBe(2)      // block align
    expect(v.getUint16(34, true)).toBe(16)     // bits
    expect(str(36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(8)      // data size
  })
  it('converte as amostras para PCM16 little-endian com clamp', async () => {
    const v = await bytes(pcmToWav(new Float32Array([0, 0.5, -1, 2])))
    expect(v.getInt16(44, true)).toBe(0)
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 32767))
    expect(v.getInt16(48, true)).toBe(-32768)
    expect(v.getInt16(50, true)).toBe(32767) // 2 → clamp em 1
  })
})
