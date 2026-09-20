import { describe, it, expect } from 'vitest'
import { markdownDecorations } from '../editor/markdown-live'

/** Só as decorações que escondem texto, como pares [from,to). */
const escondidos = (texto: string, linha: number) =>
  markdownDecorations(texto, linha).filter((d) => d.hide).map((d) => [d.from, d.to])
/** As classes aplicadas, em ordem. */
const classes = (texto: string, linha: number) =>
  markdownDecorations(texto, linha).filter((d) => d.class).map((d) => d.class)

describe('títulos', () => {
  it('# Título vira h1 e esconde a marca quando o cursor está noutra linha', () => {
    const texto = '# Título\noutra linha'
    expect(classes(texto, 1)).toContain('cm-md-h1')
    expect(escondidos(texto, 1)).toContainEqual([0, 2])
  })

  it('com o cursor na linha do título, a marca aparece', () => {
    const texto = '# Título\noutra linha'
    expect(classes(texto, 0)).toContain('cm-md-h1')
    expect(escondidos(texto, 0)).toEqual([])
  })

  it('### vira h3', () => {
    expect(classes('### Três\n', 1)).toContain('cm-md-h3')
  })

  it('#sem espaço não é título', () => {
    expect(classes('#semespaço\n', 1)).not.toContain('cm-md-h1')
  })
})

describe('ênfase', () => {
  it('**negrito** estiliza o miolo e esconde os asteriscos', () => {
    const texto = 'um **forte** aqui'
    expect(classes(texto, 1)).toContain('cm-md-strong')
    expect(escondidos(texto, 1)).toContainEqual([3, 5])
    expect(escondidos(texto, 1)).toContainEqual([10, 12])
  })

  it('*itálico* vira em', () => {
    expect(classes('um *leve* aqui', 1)).toContain('cm-md-em')
  })

  it('~~riscado~~ vira strike', () => {
    expect(classes('um ~~fora~~ aqui', 1)).toContain('cm-md-strike')
  })

  it('`código` vira code e esconde as crases', () => {
    const texto = 'rode `npm test` agora'
    expect(classes(texto, 1)).toContain('cm-md-code')
    expect(escondidos(texto, 1)).toContainEqual([5, 6])
  })

  it('com o cursor na linha, nada é escondido', () => {
    expect(escondidos('um **forte** aqui', 0)).toEqual([])
  })
})

describe('links', () => {
  it('[texto](url) mostra só o texto', () => {
    const texto = 'veja o [manual](https://exemplo.com) ali'
    expect(classes(texto, 1)).toContain('cm-md-link')
    expect(escondidos(texto, 1)).toContainEqual([7, 8])
    expect(escondidos(texto, 1)).toContainEqual([14, 36])
  })
})

describe('linha inteira', () => {
  it('> citação recebe a classe e esconde a marca', () => {
    const texto = '> pensei\noutra'
    expect(classes(texto, 1)).toContain('cm-md-quote')
    expect(escondidos(texto, 1)).toContainEqual([0, 2])
  })

  it('- item recebe classe de lista e NÃO esconde o marcador', () => {
    const texto = '- item\noutra'
    expect(classes(texto, 1)).toContain('cm-md-list')
    expect(escondidos(texto, 1)).toEqual([])
  })
})

describe('bloco de código', () => {
  it('não estiliza marcação dentro de fence', () => {
    const texto = '```js\nconst x = "**não é negrito**"\n```\n'
    expect(classes(texto, 5)).not.toContain('cm-md-strong')
  })

  it('volta a estilizar depois do fence fechar', () => {
    const texto = '```\nx\n```\n**forte**'
    expect(classes(texto, 0)).toContain('cm-md-strong')
  })
})
