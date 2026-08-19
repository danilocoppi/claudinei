import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// fileURLToPath direto: o jsdom substitui o construtor global de URL (ver emoji-font.test.ts).
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

/** Onde os temas acabam e o resto da folha começa. */
const THEMES_END = '--scheme: light;\n}\n'
const afterThemes = css.slice(css.indexOf(THEMES_END) + THEMES_END.length)

/** Um bloco `seletor { ... }` do CSS, pelo seletor. */
const blockOf = (selector: string) => {
  const start = css.indexOf(selector + ' {')
  return start === -1 ? '' : css.slice(start, css.indexOf('\n}', start))
}

/**
 * O contrato que faz um pacote de tema novo custar ~25 linhas: nenhuma cor pode
 * ser escrita direta fora do bloco dos temas. Sem este teste a tokenização é
 * desfeita aos poucos — cada `rgba()` acrescentado "só desta vez" volta a prender
 * a folha ao tema escuro, e o próximo pacote vira uma varredura pelo arquivo.
 */
describe('nenhuma cor cravada fora dos temas', () => {
  it('não há hex nem rgb() no resto da folha', () => {
    const found = afterThemes.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([0-9][0-9., ]*\)/g) ?? []
    expect(found, `use um token em vez de: ${found.slice(0, 5).join(', ')}`).toEqual([])
  })

  it('as cores vivem em tokens ou em color-mix a partir deles', () => {
    expect(afterThemes).toMatch(/color-mix\(in srgb, var\(--/)
    expect(afterThemes.match(/var\(--/g)?.length ?? 0).toBeGreaterThan(300)
  })
})

/**
 * Um pacote que esqueça um token não aparece quebrado na tela: falha aqui. O
 * conjunto sai do :root, então acrescentar um token novo ao padrão obriga todos os
 * pacotes a declará-lo.
 */
describe('todo tema declara o conjunto completo', () => {
  const tokensOf = (block: string) => new Set((block.match(/^\s*--[a-z0-9-]+(?=:)/gm) ?? []).map((t) => t.trim()))
  // do :root, só os do TEMA: forma e tipografia não pertencem ao pacote
  const NOT_THEME = new Set([
    '--glass-blur', '--radius', '--density', '--font-ui', '--font-code', '--chat-max', '--emoji',
  ])

  it('light-fun declara tudo que o padrão declara', () => {
    const base = [...tokensOf(blockOf(':root, [data-theme="dark-fun"]'))].filter((t) => !NOT_THEME.has(t))
    const light = tokensOf(blockOf('[data-theme="light-fun"]'))
    expect(base.length).toBeGreaterThan(15)
    expect(base.filter((t) => !light.has(t))).toEqual([])
  })

  it('nenhum token do tema fica sem uso (token morto engana quem cria o próximo pacote)', () => {
    for (const token of tokensOf(blockOf('[data-theme="light-fun"]'))) {
      if (token === '--scheme') continue  // usado via color-scheme no :root
      expect(afterThemes.includes(`var(${token})`), `${token} não é usado em lugar nenhum`).toBe(true)
    }
  })
})

/**
 * Os controles de forma só funcionam se a folha REALMENTE os usar. O raio nasceu
 * com 5 usos contra 86 valores cravados — o controle existia e não movia nada.
 */
describe('os controles de forma alcançam a folha', () => {
  it('o raio é derivado do token, não cravado', () => {
    // Qualquer px DENTRO da declaração, não só o primeiro: um raio assimétrico
    // (`var(--radius-lg) 12px 2px 12px`) escapava da checagem anterior.
    const hardcoded = afterThemes.match(/border-radius:[^;]*\d+px[^;]*/g) ?? []
    // 999px (pílula), 50% (círculo) e o 2px do bico da bolha de fala não são
    // "cantos": são a FORMA da coisa, e arredondá-los descaracterizaria o objeto.
    const real = hardcoded.filter((r) => !/999px/.test(r) && !/\b[12]px\b/.test(r))
    expect(real, `ainda cravados: ${real.slice(0, 6).join(', ')}`).toEqual([])
    expect((afterThemes.match(/var\(--radius/g) ?? []).length).toBeGreaterThan(50)
  })

  it('a densidade alcança a lista lateral, os cartões e o chat', () => {
    for (const selector of ['.sidebar', '.term-card', '.chat-scroll__inner', '.msg-bubble']) {
      // O seletor pode ter mais de um bloco na folha; basta um deles escalar.
      const blocks = [...afterThemes.matchAll(new RegExp(`\\${selector} \\{[^}]*`, 'g'))].map((m) => m[0])
      expect(blocks.length, selector).toBeGreaterThan(0)
      expect(blocks.some((b) => b.includes('var(--density)')), selector).toBe(true)
    }
  })
})
