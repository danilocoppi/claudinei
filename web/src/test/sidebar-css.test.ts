import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// fileURLToPath direto (e não `new URL('.', import.meta.url)`) porque o jsdom
// substitui o construtor global de URL — ver emoji-font.test.ts.
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

/**
 * O ⋮ dos contêineres nasce `visibility: hidden` e só aparece no hover do
 * cabeçalho. Se a regra que o revela não cobrir o cabeçalho de SETOR, o botão
 * existe no DOM (e passa nos testes de componente) mas é invisível na tela para
 * sempre — foi exatamente o que aconteceu na primeira versão dos setores.
 */
describe('⋮ dos contêineres da sidebar', () => {
  it('é revelado no hover tanto do grupo quanto do setor', () => {
    // o seletor completo da regra que faz `visibility: visible`
    const rule = css.match(/([^{}]*)\{\s*visibility:\s*visible[^{}]*\}/)?.[1] ?? ''
    expect(rule, 'nenhuma regra revela o ⋮ no hover').toContain('.term-group__gear')
    expect(rule).toMatch(/\.term-group__header:hover/)
    expect(rule).toMatch(/\.term-sector__header:hover/)
  })
})
