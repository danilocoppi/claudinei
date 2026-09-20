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

  it('- item esconde o hífen; o marcador passa a ser desenhado pelo CSS', () => {
    const texto = '- item\noutra'
    expect(escondidos(texto, 1)).toContainEqual([0, 2])
  })

  it('com o cursor no item, o hífen volta a aparecer (é preciso editá-lo)', () => {
    expect(escondidos('- item\noutra', 0)).toEqual([])
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

/** As decorações de LINHA (classe aplicada à linha inteira, não a um trecho). */
const linhas = (texto: string, cursor: number) =>
  markdownDecorations(texto, cursor).filter((d) => d.line).map((d) => `${d.from}:${d.class}`)

describe('decoração de linha (o que deixa o texto com cara de documento)', () => {
  it('título marca a LINHA, não um trecho dela', () => {
    expect(linhas('# Título\noutra', 1)).toContain('0:cm-md-h1')
    // e não sobra um mark cobrindo a linha inteira competindo com ela
    expect(markdownDecorations('# Título\noutra', 1).filter((d) => !d.line && d.class === 'cm-md-h1')).toEqual([])
  })

  it('lista marca a linha e esconde o marcador (o bullet vem do CSS)', () => {
    const texto = '- item\noutra'
    expect(linhas(texto, 1)).toContain('0:cm-md-list')
    expect(escondidos(texto, 1)).toContainEqual([0, 2])
  })

  it('lista numerada mantém o número visível (ele é informação)', () => {
    const texto = '1. primeiro\noutra'
    expect(linhas(texto, 1)).toContain('0:cm-md-ol')
    expect(escondidos(texto, 1)).toEqual([])
  })

  it('citação marca a linha', () => {
    expect(linhas('> pensei\noutra', 1)).toContain('0:cm-md-quote')
  })

  it('linha de bloco de código marca a linha', () => {
    const texto = '```\nx = 1\n```\n'
    expect(linhas(texto, 9)).toContain('4:cm-md-codeblock')
  })

  it('linha vazia não gera decoração de linha (nada a estilizar)', () => {
    expect(linhas('a\n\nb', 0)).toEqual([])
  })
})

/** Blocos que o editor troca por um desenho (hoje: tabela). */
const blocos = (texto: string, cursor: number) =>
  markdownDecorations(texto, cursor).filter((d) => d.table).map((d) => ({ from: d.from, to: d.to, linhas: d.table }))

const TABELA = [
  '| Nome | Papel |',
  '| --- | --- |',
  '| Ana | dev |',
  '| Bia | infra |',
].join('\n')

describe('tabela', () => {
  it('fora dela, o bloco inteiro vira uma tabela desenhada', () => {
    const b = blocos(TABELA + '\ndepois', 4)
    expect(b).toHaveLength(1)
    expect(b[0].from).toBe(0)
    expect(b[0].to).toBe(TABELA.length)
    expect(b[0].linhas).toEqual([
      ['Nome', 'Papel'],
      ['Ana', 'dev'],
      ['Bia', 'infra'],
    ])
  })

  it('com o cursor dentro, volta a ser texto editável', () => {
    expect(blocos(TABELA, 2)).toEqual([])
  })

  it('sem a linha separadora não é tabela (é texto com barras)', () => {
    expect(blocos('| a | b |\n| c | d |', 5)).toEqual([])
  })

  it('tabela dentro de bloco de código continua código', () => {
    const texto = '```\n| a | b |\n| --- | --- |\n```'
    expect(blocos(texto, 9)).toEqual([])
  })

  it('a tabela não recebe também as decorações de linha (seria estilo em cima de desenho)', () => {
    const decs = markdownDecorations(TABELA + '\ndepois', 9)
    expect(decs.filter((d) => d.line && d.from < TABELA.length)).toEqual([])
  })
})
