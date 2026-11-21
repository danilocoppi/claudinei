import { describe, it, expect, vi } from 'vitest'
import Module from 'node:module'
import { inspectorFallbackLoader, installInspectorFallback } from '../src/pkg-runtime.js'

describe('desvio do inspector (Node do pkg sem inspector)', () => {
  it('inspectorFallbackLoader repassa o verdadeiro quando ele carrega', () => {
    const real = { url: () => undefined }
    const orig = vi.fn(() => real)
    const load = inspectorFallbackLoader(orig)
    expect(load('inspector', null, false)).toBe(real)
    expect(load('node:inspector', null, false)).toBe(real)
    expect(orig).toHaveBeenCalledWith('inspector', null, false)
  })

  it("devolve {} só quando o verdadeiro lança, e só para 'inspector' e 'node:inspector'", () => {
    const orig = vi.fn(() => { throw new Error('No such built-in module: inspector') })
    const load = inspectorFallbackLoader(orig)
    expect(load('inspector', null, false)).toEqual({})
    expect(load('node:inspector', null, false)).toEqual({})
    expect(() => load('node:inspector/promises', null, false)).toThrow('No such built-in module')
  })

  it('outro módulo que lança continua lançando; outro que carrega passa direto', () => {
    const orig = vi.fn((request: string) => {
      if (request === 'fs') return { ok: true }
      throw new Error(`Cannot find module '${request}'`)
    })
    const load = inspectorFallbackLoader(orig)
    expect(() => load('playwright-core', null, false)).toThrow("Cannot find module 'playwright-core'")
    expect(load('fs', null, false)).toEqual({ ok: true })
  })

  it('installInspectorFallback é idempotente e o require normal segue funcionando', () => {
    const mod = Module as unknown as { _load: unknown }
    const before = mod._load
    try {
      installInspectorFallback()
      const once = mod._load
      installInspectorFallback()
      expect(mod._load).toBe(once)
      const req = Module.createRequire(import.meta.url)
      expect(typeof (req('node:inspector') as { url: unknown }).url).toBe('function')
      expect(req('node:path')).toHaveProperty('join')
    } finally {
      mod._load = before
    }
  })
})
