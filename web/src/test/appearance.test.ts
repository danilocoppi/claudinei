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
    // O padrão seguro de tudo que não é o tema é "do tema": manda o pacote.
    expect(out.fontUi).toBe('theme')
    expect(out.radius).toBe('theme')
  })

  it('preserva o que é válido', () => {
    expect(normalize({ theme: 'light-fun', density: 'compact', glass: 'off' }))
      .toMatchObject({ theme: 'light-fun', density: 'compact', glass: 'off' })
  })
})

describe('applyAppearance', () => {
  it('escreve tema e movimento como atributos do <html>', () => {
    applyAppearance({ theme: 'light-fun', reducedMotion: true }, root)
    expect(root.dataset.theme).toBe('light-fun')
    expect(root.dataset.motion).toBe('reduced')
  })

  /**
   * A regra que faz um pacote poder nascer compacto, chapado ou monoespaçado: o
   * painel só escreve o token quando o usuário DISCORDA do tema — e limpa quando
   * ele volta a concordar, senão a escolha antiga fica grudada no estilo inline e
   * o pacote nunca mais manda naquele token.
   */
  it('"do tema" não escreve nada, e voltar a ele limpa o que foi escrito', () => {
    applyAppearance({ density: 'compact', radius: 'square', glass: 'off', fontUi: 'serif' }, root)
    expect(root.style.getPropertyValue('--density')).toBe('.8')
    expect(root.style.getPropertyValue('--glass-blur')).toBe('0px')

    applyAppearance({ density: 'theme', radius: 'theme', glass: 'theme', fontUi: 'theme' }, root)
    for (const token of ['--density', '--radius', '--glass-blur', '--font-ui']) {
      expect(root.style.getPropertyValue(token), token).toBe('')
    }
  })

  /** Antes o vidro era booleano: um "desligado" explícito não pode virar "do tema". */
  it('aceita o formato antigo do vidro', () => {
    expect(normalize({ glass: false } as never).glass).toBe('off')
    expect(normalize({ glass: true } as never).glass).toBe('theme')
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
    // Cai em "do tema", que não escreve nada — a fonte fica a do pacote.
    expect(root.style.getPropertyValue('--font-ui')).toBe('')
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
    // "do tema" não tem stack própria: ela vem do pacote.
    for (const f of UI_FONTS.filter((x) => x.css)) {
      expect(f.css, f.id).toMatch(/(sans-serif|serif|monospace)$/)
    }
  })
})
