import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')
/** O corpo de todas as regras cujo seletor é exatamente `sel`, juntos. */
const regra = (sel: string) => {
  const esc = sel.replace(/[.,]/g, (c) => `\\${c}`).replace(/ /g, '\\s*')
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';')
}

/**
 * O botão de copiar o caminho, no rodapé do Acompanhamento, não fica dentro de
 * um `.copy-wrap`. Com o `position: absolute` do `.copy-btn`, ele subia até a
 * coluna da direita e parava, invisível, sobre o × de fechar: o clique copiava
 * o caminho em vez de fechar. No rodapé ele fica no fluxo, ao lado do caminho.
 */
describe('botão de copiar o caminho no rodapé do Acompanhamento', () => {
  it('fica no fluxo, ao lado do caminho, e não flutua sobre o cabeçalho', () => {
    expect(regra('.progress__path .copy-btn')).toMatch(/position:\s*static/)
  })
  it('fica visível, já que não há bloco com hover que o revele', () => {
    expect(regra('.progress__path .copy-btn')).toMatch(/opacity:\s*1/)
  })
})
