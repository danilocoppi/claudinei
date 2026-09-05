import { describe, it, expect } from 'vitest'
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW } from '../src/claude/context-window.js'

describe('contextWindowFor', () => {
  it('modelos de 1M: fable, opus e sonnet atuais (inclusive os aliases do CLI)', () => {
    for (const m of ['fable', 'claude-fable-5', 'claude-mythos-5', 'opus', 'claude-opus-5',
                     'claude-opus-4-8', 'claude-opus-4-6', 'sonnet', 'claude-sonnet-5', 'claude-sonnet-4-6']) {
      expect(contextWindowFor(m), m).toBe(1_000_000)
    }
  })

  it('o sufixo [1m] manda, venha em que modelo vier', () => {
    expect(contextWindowFor('claude-opus-5[1m]')).toBe(1_000_000)
    expect(contextWindowFor('CLAUDE-OPUS-5[1M]')).toBe(1_000_000)
  })

  it('haiku é 200k mesmo sendo da geração atual', () => {
    expect(contextWindowFor('haiku')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowFor('claude-haiku-4-5')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('desconhecido/ausente cai no conservador (200k) — subestimar a janela só compacta cedo', () => {
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowFor('')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowFor('claude-opus-4-1')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowFor('modelo-que-nao-existe')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})
