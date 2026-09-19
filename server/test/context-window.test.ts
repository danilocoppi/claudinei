import { describe, it, expect } from 'vitest'
import { contextWindowFor, windowFromModelUsage, DEFAULT_CONTEXT_WINDOW } from '../src/claude/context-window.js'

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

describe('windowFromModelUsage: a janela que a própria CLI reporta', () => {
  // O result traz modelUsage[modelo].contextWindow (medido: 1.000.000 no
  // claude-opus-5). Dado autoritativo: vale mais que reconhecer o nome, e é o
  // que salva um modelo novo de cair no conservador de 200k.
  const usage = {
    'claude-haiku-4-5-20251001': { contextWindow: 200_000, canonicalModel: 'claude-haiku-4-5' },
    'claude-opus-5': { contextWindow: 1_000_000, canonicalModel: 'claude-opus-5' },
  }

  it('acha a janela do modelo da sessão pela chave', () => {
    expect(windowFromModelUsage(usage, 'claude-opus-5')).toBe(1_000_000)
  })

  it('não confunde com o modelo auxiliar: haiku aparece no mesmo result', () => {
    expect(windowFromModelUsage(usage, 'claude-haiku-4-5-20251001')).toBe(200_000)
  })

  it('casa pelo canonicalModel quando a chave traz a data', () => {
    expect(windowFromModelUsage(usage, 'claude-haiku-4-5')).toBe(200_000)
  })

  it('modelo ausente, modelUsage malformado ou janela zerada → undefined (quem decide é o fallback por nome)', () => {
    expect(windowFromModelUsage(usage, 'claude-mimir-9')).toBeUndefined()
    expect(windowFromModelUsage(undefined, 'claude-opus-5')).toBeUndefined()
    expect(windowFromModelUsage({ 'claude-opus-5': { contextWindow: 0 } }, 'claude-opus-5')).toBeUndefined()
  })
})
