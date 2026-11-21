import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

/**
 * As ações escondidas do cartão (⌄, ⚙ e a estrela de quem não é fixado) tinham
 * opacity 0 mas ocupavam ~66 px: no cartão colapsado com o 🎯, o nome virava
 * "Pr…". Fora do hover/foco elas não guardam lugar; em tela de toque seguem como antes.
 */
describe('ações escondidas do cartão não espremem o nome', () => {
  it('com hover disponível, fora do hover/foco a largura é 0 e o gap volta', () => {
    const bloco = css.match(/@media \(hover: hover\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(bloco).toMatch(/\.term-card:not\(:hover\):not\(:focus-within\) button\.term-card__action--reveal/)
    expect(bloco).toMatch(/button\.term-card__favorite:not\(\.is-favorite\)/)
    expect(bloco).toMatch(/width:\s*0/)
    expect(bloco).toMatch(/margin-left:\s*-6px/)
    expect(bloco).not.toMatch(/transition/)
  })
})
