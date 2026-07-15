import { describe, it, expect } from 'vitest'
import { shouldNotify } from '../notifications'

describe('shouldNotify', () => {
  it('working → needs_attention notifica', () => {
    expect(shouldNotify('needs_attention', 'working').notify).toBe(true)
  })
  it('qualquer → dead notifica', () => {
    expect(shouldNotify('dead', 'working').notify).toBe(true)
    expect(shouldNotify('dead', 'idle').notify).toBe(true)
  })
  it('idle → working NÃO notifica', () => {
    expect(shouldNotify('working', 'idle').notify).toBe(false)
  })
  it('needs_attention sem prev (snapshot inicial) NÃO notifica', () => {
    expect(shouldNotify('needs_attention', undefined).notify).toBe(false)
  })
})
