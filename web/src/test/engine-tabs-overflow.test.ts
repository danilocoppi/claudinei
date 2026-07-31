import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Mesmo motivo do emoji-font.test.ts para resolver o caminho assim (jsdom + URL).
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

const baseRule = css.match(/^\.engine-tabs \{[^}]*\}/m)?.[0] ?? ''

describe('barra de engines não vaza da janela', () => {
  it('a regra BASE (não só o mobile) deixa a barra encolher e rolar', () => {
    // min-width: auto (default do flex item) fazia a barra empurrar o header
    // para fora numa janela estreita, deixando a última engine inalcançável.
    expect(baseRule).toMatch(/min-width:\s*0/)
    expect(baseRule).toMatch(/overflow-x:\s*auto/)
  })

  it('as abas não encolhem individualmente (o que rola é a barra)', () => {
    expect(css).toMatch(/^\.engine-tab \{ flex: none; \}/m)
  })

  it('a rolagem não depende mais do media query de 768px', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'))
    const mobileRule = mobile.match(/^\s*\.engine-tabs \{[^}]*\}/m)?.[0] ?? ''
    // no mobile sobra só esconder a barrinha (o dedo arrasta)
    expect(mobileRule).toMatch(/scrollbar-width:\s*none/)
    expect(mobileRule).not.toMatch(/overflow-x/)
  })
})
