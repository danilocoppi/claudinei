import { describe, it, expect, afterEach } from 'vitest'
import { micSupported, concatFloat32 } from '../speech/recorder'

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
