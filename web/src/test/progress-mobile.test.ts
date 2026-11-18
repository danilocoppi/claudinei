import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * No celular a coluna do acompanhamento cobre a tela inteira (inclusive a
 * topbar): instalado como aplicativo (viewport-fit=cover), o X de fechar e o
 * rodapé precisam fugir do entalhe e do indicador de início, como a topbar e o
 * campo do chat já fazem.
 */
// Mesmo motivo do emoji-font.test.ts para resolver o caminho assim (jsdom + URL).
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')

describe('coluna do acompanhamento no celular', () => {
  it('respeita as áreas seguras do topo e da base', () => {
    const mobile = css.slice(css.lastIndexOf('.progress { position: fixed'))
    const regra = mobile.slice(0, mobile.indexOf('}') + 1)
    expect(regra).toMatch(/padding-top: env\(safe-area-inset-top/)
    expect(regra).toMatch(/padding-bottom: env\(safe-area-inset-bottom/)
  })
})
