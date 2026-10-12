import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Mesmo motivo do emoji-font.test.ts para resolver o caminho assim (jsdom + URL).
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

/**
 * O Chrome derrubava a aba ("Aw, Snap!", código 4) num clique no texto de uma
 * mensagem quando o foco estava num botão dela (Forward, editar): o foco sai,
 * a mensagem passa de `content-visibility: visible` para `auto` no meio do
 * clique, e uma verificação interna do Chrome falha ao calcular onde o clique
 * caiu (visto no 151 e no 153). O `auto` já mantém desenhado o que tem foco ou
 * seleção — trocar a propriedade pelo foco era redundante.
 */
describe('mensagens do chat e content-visibility', () => {
  it('continuam com content-visibility: auto (o histórico longo segue leve)', () => {
    expect(css).toMatch(/^\.chat-entry \{[^}]*content-visibility:\s*auto/m)
  })

  it('nenhuma regra troca content-visibility conforme foco, hover ou clique', () => {
    const seletores = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , corpo]) => /content-visibility/.test(corpo))
      .map(([, seletor]) => seletor.trim())
    expect(seletores.filter((s) => /:(focus|focus-within|focus-visible|hover|active)\b/.test(s))).toEqual([])
  })
})
