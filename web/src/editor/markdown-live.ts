/**
 * O miolo do live preview: dado o texto e a linha do cursor, o que vira
 * documento e o que continua aparecendo como marcação.
 *
 * É função pura de propósito. O CodeMirror precisa de layout para montar uma
 * view, o que o jsdom não fornece; mantendo a decisão aqui, toda a regra de
 * "o que fica bonito" é testável sem navegador. O plugin (markdown-live-plugin)
 * só traduz esta saída para Decoration.
 *
 * A marca aparece quando o cursor está na linha: é assim que se edita o que
 * está escondido, sem precisar de um modo "ver fonte".
 *
 * Três formas de decoração, e a distinção importa:
 * - `line`: classe na LINHA inteira (título, citação, item de lista). É o que
 *   permite margem, marcador e tamanho — um mark esticado pela linha não faz
 *   nada disso.
 * - `hide`: o trecho de marcação some.
 * - o resto: classe num trecho (negrito, código inline, texto do link).
 */
export interface MdDecoration {
  from: number; to: number; class?: string; hide?: boolean; line?: boolean
  /** Bloco que vira desenho: as células já separadas (cabeçalho na primeira). */
  table?: string[][]
}

const TITULO = /^(#{1,6})\s+/
const CITACAO = /^>\s?/
const LISTA = /^(\s*)([-*+])\s+/
const LISTA_NUM = /^(\s*)(\d+\.)\s+/
const FENCE = /^\s*(?:```|~~~)/
const REGUA = /^\s*(?:---+|\*\*\*+|___+)\s*$/

// Ordem importa: ** antes de *, ~~ antes de qualquer coisa com ~.
const INLINE: { re: RegExp; classe: string }[] = [
  { re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, classe: 'cm-md-strong' },
  { re: /(~~)(?=\S)([\s\S]*?\S)\1/g, classe: 'cm-md-strike' },
  { re: /(?<![*\w])(\*|_)(?=\S)([^*_]*?\S)\1(?![*\w])/g, classe: 'cm-md-em' },
  { re: /(`)([^`]+)\1/g, classe: 'cm-md-code' },
]

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

const LINHA_TABELA = /^\s*\|.*\|\s*$/
const SEPARADOR_TABELA = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/

const celulas = (linha: string): string[] =>
  linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

/**
 * Onde começa e termina uma tabela a partir da linha `i`, ou null.
 *
 * Exige a linha separadora (`| --- |`) logo abaixo do cabeçalho: sem ela, um
 * parágrafo que por acaso tem barras viraria tabela, o que assusta mais do que
 * ajuda.
 */
function acharTabela(linhas: string[], i: number): { fim: number; celulas: string[][] } | null {
  if (!LINHA_TABELA.test(linhas[i] ?? '') || !SEPARADOR_TABELA.test(linhas[i + 1] ?? '')) return null
  let fim = i + 1
  while (LINHA_TABELA.test(linhas[fim + 1] ?? '')) fim++
  const corpo = [linhas[i], ...linhas.slice(i + 2, fim + 1)]
  return { fim, celulas: corpo.map(celulas) }
}

export function markdownDecorations(text: string, cursorLine: number): MdDecoration[] {
  const saida: MdDecoration[] = []
  const todas = text.split('\n')
  // Início de cada linha no texto, para não recontar offsets no salto da tabela.
  const inicios: number[] = []
  let acc = 0
  for (const l of todas) { inicios.push(acc); acc += l.length + 1 }

  let offset = 0
  let dentroDeFence = false
  let pularAte = -1

  todas.forEach((linha, i) => {
    const base = offset
    offset += linha.length + 1
    if (i <= pularAte) return
    const naLinhaDoCursor = i === cursorLine
    const esconder = (from: number, to: number) => {
      if (!naLinhaDoCursor && to > from) saida.push({ from, to, hide: true })
    }
    const aLinha = (classe: string) => saida.push({ from: base, to: base, class: classe, line: true })

    if (FENCE.test(linha)) {
      dentroDeFence = !dentroDeFence
      aLinha('cm-md-fence')
      return
    }
    // Dentro do bloco o texto é código: nada de negrito por causa de um `**`.
    if (dentroDeFence) {
      aLinha('cm-md-codeblock')
      return
    }
    if (!linha.trim()) return

    // Tabela vira desenho — a não ser que o cursor esteja nela, quando volta a
    // ser texto para poder ser editada.
    const tabela = acharTabela(todas, i)
    if (tabela) {
      const fim = inicios[tabela.fim] + todas[tabela.fim].length
      if (cursorLine < i || cursorLine > tabela.fim) {
        saida.push({ from: base, to: fim, table: tabela.celulas })
        pularAte = tabela.fim
        return
      }
    }

    const titulo = TITULO.exec(linha)
    if (titulo) {
      aLinha(`cm-md-h${titulo[1].length}`)
      esconder(base, base + titulo[0].length)
    }
    const citacao = CITACAO.exec(linha)
    if (citacao) {
      aLinha('cm-md-quote')
      esconder(base, base + citacao[0].length)
    }
    if (REGUA.test(linha)) aLinha('cm-md-rule')
    // Lista com marcador: o `-` vira bolinha desenhada pelo CSS, então some.
    // A numerada mantém o número — ele é conteúdo, não enfeite.
    const lista = LISTA.exec(linha)
    if (lista) {
      aLinha('cm-md-list')
      esconder(base + lista[1].length, base + lista[0].length)
    }
    if (LISTA_NUM.test(linha)) aLinha('cm-md-ol')

    for (const { re, classe } of INLINE) {
      re.lastIndex = 0
      for (let m = re.exec(linha); m; m = re.exec(linha)) {
        const inicio = base + m.index
        const marca = m[1].length
        saida.push({ from: inicio + marca, to: inicio + m[0].length - marca, class: classe })
        esconder(inicio, inicio + marca)
        esconder(inicio + m[0].length - marca, inicio + m[0].length)
      }
    }

    LINK.lastIndex = 0
    for (let m = LINK.exec(linha); m; m = LINK.exec(linha)) {
      const inicio = base + m.index
      saida.push({ from: inicio + 1, to: inicio + 1 + m[1].length, class: 'cm-md-link' })
      esconder(inicio, inicio + 1)
      esconder(inicio + 1 + m[1].length, inicio + m[0].length)
    }
  })

  return saida
}
