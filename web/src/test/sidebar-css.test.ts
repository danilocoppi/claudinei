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

/**
 * O topo da lateral transbordava: com um nome de usuário mais longo (ou a barra
 * de rolagem clássica do Linux), logo + «, ⚙, usuário e bandeira não cabiam e a
 * lateral inteira ganhava barra de rolagem horizontal. Agora o topo cede espaço
 * em ordem: o nome encolhe, depois sai a palavra "Claudinei", e só no limite os
 * botões descem de linha.
 */
describe('topo da lateral cede espaço em vez de transbordar', () => {
  const regra = (sel: string) => css.match(new RegExp(`${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  it('o nome do usuário encolhe: a fileira e o botão podem ficar menores que o conteúdo', () => {
    expect(regra('.sidebar__top-actions')).toMatch(/min-width:\s*0/)
    expect(regra('.user-menu__btn')).toMatch(/min-width:\s*0/)
    expect(regra('.user-menu__name')).toMatch(/text-overflow:\s*ellipsis/)
    // Só o NOME encolhe: o 👤 fica inteiro (no primeiro ensaio ele foi esmagado junto).
    expect(regra('.user-menu__btn svg')).toMatch(/flex:\s*none/)
  })
  it('apertando mais, sai a palavra "Claudinei" e, no limite, os botões descem de linha', () => {
    const queries = [...css.matchAll(/@container sidebar \(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)]
    const semTexto = queries.find(([, , corpo]) => /\.sidebar__logo-text\s*\{\s*display:\s*none/.test(corpo))
    const quebra = queries.find(([, , corpo]) => /\.sidebar__top\s*\{[^}]*flex-wrap:\s*wrap/.test(corpo))
    expect(semTexto, 'nenhuma regra tira o texto do logo').toBeTruthy()
    expect(quebra, 'nenhuma regra deixa a fileira descer').toBeTruthy()
    expect(Number(quebra![1])).toBeLessThan(Number(semTexto![1]))
  })
})
