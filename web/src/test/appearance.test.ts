import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyAppearance, normalize, readCachedAppearance, cacheAppearance,
  DEFAULT_APPEARANCE, ACCENTS, UI_FONTS,
} from '../appearance'

let root: HTMLElement

beforeEach(() => {
  root = document.createElement('html')
  localStorage.clear()
})

describe('normalize', () => {
  it('completa o que falta com o padrão', () => {
    expect(normalize({})).toEqual(DEFAULT_APPEARANCE)
    expect(normalize(null)).toEqual(DEFAULT_APPEARANCE)
  })

  /** Um pacote removido, ou um servidor mais novo, não pode travar a tela. */
  it('chave desconhecida cai no padrão em vez de virar CSS', () => {
    const out = normalize({ theme: 'neon-inexistente', fontUi: 'comic', radius: 'oval' })
    expect(out.theme).toBe('dark-fun')
    expect(out.fontUi).toBe('system')
    expect(out.radius).toBe('default')
  })

  it('preserva o que é válido', () => {
    expect(normalize({ theme: 'light-fun', density: 'compact', glass: false }))
      .toMatchObject({ theme: 'light-fun', density: 'compact', glass: false })
  })
})

describe('applyAppearance', () => {
  it('escreve tema, vidro e movimento como atributos do <html>', () => {
    applyAppearance({ theme: 'light-fun', glass: false, reducedMotion: true }, root)
    expect(root.dataset.theme).toBe('light-fun')
    expect(root.dataset.glass).toBe('off')
    expect(root.dataset.motion).toBe('reduced')
  })

  it('traduz as chaves em valores de CSS', () => {
    applyAppearance({ chatWidth: '800', fontUi: 'serif', fontCode: 'fira', density: 'compact', radius: 'square' }, root)
    expect(root.style.getPropertyValue('--chat-max')).toBe('800px')
    expect(root.style.getPropertyValue('--font-ui')).toContain('Georgia')
    expect(root.style.getPropertyValue('--font-code')).toContain('Fira Code')
    expect(root.style.getPropertyValue('--density')).toBe('.8')
    expect(root.style.getPropertyValue('--radius')).toBe('4px')
  })

  /**
   * Cada pacote afina o próprio roxo para o contraste do seu fundo. O acento "do
   * tema" não pode escrever nada — e voltar para ele precisa REMOVER o que a
   * escolha anterior escreveu, senão a cor antiga fica grudada.
   */
  it('acento "do tema" não sobrescreve o do pacote, e voltar a ele limpa', () => {
    applyAppearance({ accent: 'pink' }, root)
    expect(root.style.getPropertyValue('--accent')).toBe('#db2777')
    applyAppearance({ accent: 'theme' }, root)
    expect(root.style.getPropertyValue('--accent')).toBe('')
    expect(root.style.getPropertyValue('--accent-2')).toBe('')
  })

  it('devolve o objeto normalizado que aplicou', () => {
    expect(applyAppearance({ theme: 'inexistente' }, root).theme).toBe('dark-fun')
  })

  /** Nada que veio do banco pode escapar para uma regra de CSS. */
  it('valor hostil não chega ao estilo', () => {
    applyAppearance({ fontUi: 'x; } body { display: none } .a{' }, root)
    expect(root.style.getPropertyValue('--font-ui')).toBe(UI_FONTS[0].css)
    expect(root.dataset.theme).toBe('dark-fun')
  })
})

describe('cache de pintura', () => {
  it('guarda e relê', () => {
    cacheAppearance(normalize({ theme: 'light-fun' }))
    expect(readCachedAppearance()?.theme).toBe('light-fun')
  })

  it('cache corrompido não derruba o boot', () => {
    localStorage.setItem('claudinei:appearance', 'isto não é json')
    expect(readCachedAppearance()).toBeNull()
  })

  it('sem cache, devolve null (e o boot usa o padrão)', () => {
    expect(readCachedAppearance()).toBeNull()
  })
})

describe('as listas de opções', () => {
  it('toda opção com css tem id único', () => {
    const ids = ACCENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('as fontes terminam num genérico, para degradar em qualquer máquina', () => {
    for (const f of UI_FONTS) {
      expect(f.css, f.id).toMatch(/(sans-serif|serif|monospace)$/)
    }
  })
})
