import { describe, it, expect } from 'vitest'
import { windowFor, expectedPercent, paceRatio, paceColor } from '../usage/pace'

const H = 3_600_000
const SESSION = { windowMs: 5 * H, chunkMs: H / 3 }   // 5h, chunks de 20min
const WEEKLY = { windowMs: 168 * H, chunkMs: H }       // 7d, chunks de 1h

describe('windowFor', () => {
  it('session → 5h/20min; weekly → 7d/1h; desconhecido → null', () => {
    expect(windowFor('session')).toEqual(SESSION)
    expect(windowFor('weekly')).toEqual(WEEKLY)
    expect(windowFor('mensal_do_futuro')).toBeNull()
  })
})

describe('expectedPercent (chunks decorridos / total, chunk atual conta cheio)', () => {
  // janela de sessão: reset daqui a 4h → 1h decorrida → 3 chunks de 20min / 15 = 20%
  const now = Date.parse('2026-07-12T10:00:00Z')
  const reset4h = new Date(now + 4 * H).toISOString()
  it('1h decorrida da sessão → 20%', () => {
    expect(expectedPercent(reset4h, SESSION.windowMs, SESSION.chunkMs, now)).toBeCloseTo(20, 5)
  })
  it('início da janela → 1º chunk conta cheio (1/15 ≈ 6,67%), sem explosão', () => {
    const resetQuaseCheio = new Date(now + 5 * H - 1000).toISOString() // 1s decorrido
    expect(expectedPercent(resetQuaseCheio, SESSION.windowMs, SESSION.chunkMs, now)).toBeCloseTo(100 / 15, 3)
  })
  it('resets_at no passado → clampa em 100', () => {
    const resetPassado = new Date(now - 1000).toISOString()
    expect(expectedPercent(resetPassado, SESSION.windowMs, SESSION.chunkMs, now)).toBe(100)
  })
  it('semana: 84h decorridas → 50%', () => {
    const reset84h = new Date(now + 84 * H).toISOString()
    expect(expectedPercent(reset84h, WEEKLY.windowMs, WEEKLY.chunkMs, now)).toBeCloseTo(50, 5)
  })
})

describe('paceRatio + paceColor (exemplos canônicos do usuário)', () => {
  it('10% usado com 20% esperado → razão 0,5 → verde', () => {
    const ratio = paceRatio(10, 20)
    expect(ratio).toBeCloseTo(0.5)
    expect(paceColor(ratio)).toBe('var(--ok)')
  })
  it('40% usado com 20% esperado → razão 2,0 → vermelho', () => {
    const ratio = paceRatio(40, 20)
    expect(ratio).toBeCloseTo(2)
    expect(paceColor(ratio)).toBe('var(--err)')
  })
  it('razão 1,5 → matiz intermediário (amarelo ~70°)', () => {
    expect(paceColor(1.5)).toBe('hsl(70 70% 55%)')
  })
  it('razão exatamente 1 → verde; null (grupo desconhecido) → accent', () => {
    expect(paceColor(1)).toBe('var(--ok)')
    expect(paceColor(null)).toBe('var(--accent)')
  })
  it('esperado 0 não acontece (chunk mínimo), mas por segurança razão vira Infinity → vermelho', () => {
    expect(paceColor(paceRatio(10, 0))).toBe('var(--err)')
  })
})
