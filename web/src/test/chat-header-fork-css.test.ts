import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// fileURLToPath direto (e não `new URL('.', import.meta.url)`) porque o jsdom
// substitui o construtor global de URL — ver emoji-font.test.ts.
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

/** O corpo de todas as regras cujo seletor é exatamente `sel` (fora de @media), juntos. */
const regra = (sel: string) => {
  const esc = sel.replace(/[.]/g, '\\.')
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';')
}

/**
 * No ramo, o selo "ramo de X · cópia até HH:MM" (nowrap) transbordava o bloco do
 * projeto, invadia as abas de motor e o nome do terminal sumia (1500 px). Agora o
 * bloco corta o que sobra, o selo encolhe com reticências e o nome tem prioridade.
 * Sem transition nem animation (frontend sem GPU).
 */
describe('selo do ramo no cabeçalho do chat', () => {
  it('o bloco do projeto não deixa o conteúdo vazar sobre as abas', () => {
    expect(regra('.chat-header__project')).toMatch(/overflow:\s*hidden/)
    expect(regra('.chat-header__project')).toMatch(/min-width:\s*0/)
  })

  it('o selo encolhe com reticências, numa linha', () => {
    const fork = regra('.chat-header__fork')
    expect(fork).toMatch(/min-width:\s*0/)
    expect(fork).toMatch(/overflow:\s*hidden/)
    expect(fork).toMatch(/text-overflow:\s*ellipsis/)
    expect(fork).toMatch(/white-space:\s*nowrap/)
    expect(fork).toMatch(/flex:\s*0 1 auto/)
  })

  it('o nome do terminal não encolhe a zero e cede menos que o selo', () => {
    const nome = regra('.chat-header__project strong')
    expect(nome).toMatch(/min-width:\s*6ch/)
    const shrink = Number(/flex-shrink:\s*([\d.]+)/.exec(nome)?.[1] ?? '1')
    expect(shrink).toBeLessThan(1)
  })

  it('nada anima', () => {
    for (const sel of ['.chat-header__project', '.chat-header__fork', '.chat-header__project strong']) {
      expect(regra(sel)).not.toMatch(/transition|animation/)
    }
  })
})
