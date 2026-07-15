import { describe, it, expect } from 'vitest'
import { isLoopbackHost, assertExposureAllowed } from '../src/expose-guard.js'

describe('isLoopbackHost', () => {
  it('reconhece loopback', () => {
    for (const h of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(h)).toBe(true)
  })
  it('IP de rede não é loopback', () => {
    for (const h of ['0.0.0.0', '192.168.0.10']) expect(isLoopbackHost(h)).toBe(false)
  })
})

describe('assertExposureAllowed', () => {
  it('loopback nunca bloqueia (mesmo sem auth/insecure)', () => {
    expect(() => assertExposureAllowed('127.0.0.1', { insecure: false, authConfigured: false })).not.toThrow()
  })
  it('não-loopback sem auth e sem insecure → lança', () => {
    expect(() => assertExposureAllowed('0.0.0.0', { insecure: false, authConfigured: false })).toThrow(/insecure|autentic/i)
  })
  it('não-loopback com --insecure → não lança', () => {
    expect(() => assertExposureAllowed('0.0.0.0', { insecure: true, authConfigured: false })).not.toThrow()
  })
  it('não-loopback com auth configurada → não lança', () => {
    expect(() => assertExposureAllowed('0.0.0.0', { insecure: false, authConfigured: true })).not.toThrow()
  })
})
