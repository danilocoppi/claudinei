import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Mesmo motivo do emoji-font.test.ts para resolver o caminho assim (jsdom + URL).
const here = dirname(fileURLToPath(import.meta.url))
// Sem os comentários: um comentário que explica por que não usar clip-path não é uso.
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const regras = (alvo: RegExp) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, seletor]) => alvo.test(seletor))
  .map(([, seletor, corpo]) => ({ seletor: seletor.trim(), corpo }))

/**
 * A coluna da conversa é feita de três partes da lista virtual (topo, linhas,
 * rodapé). Nada pode cortar o que transborda de uma parte: o menu "Encaminhar"
 * da última mensagem abre abaixo das linhas, e um `clip-path` com inset vertical
 * zero o escondia por inteiro.
 */
describe('a folha da conversa não corta o que transborda', () => {
  it('nenhuma parte da coluna usa clip-path nem overflow que corte', () => {
    const cortam = regras(/\.chat-scroll__inner\b|\.chat-entry\b/)
      .filter(({ corpo }) => /clip-path|overflow(-y|-x)?\s*:\s*(hidden|clip)/.test(corpo))
      .map(({ seletor }) => seletor)
    expect(cortam).toEqual([])
  })

  it('a sombra da coluna não usa filtro (caro sem GPU)', () => {
    const comFiltro = regras(/\.chat-scroll__inner\b/)
      .filter(({ corpo }) => /(^|[\s;])(filter|backdrop-filter)\s*:/.test(corpo))
      .map(({ seletor }) => seletor)
    expect(comFiltro).toEqual([])
  })
})
