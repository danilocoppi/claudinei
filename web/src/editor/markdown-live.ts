/**
 * O miolo do live preview: dado o texto e a linha do cursor, quais trechos
 * ganham estilo e quais marcas somem.
 *
 * É função pura de propósito. O CodeMirror precisa de layout para montar uma
 * view, o que o jsdom não fornece; mantendo a decisão aqui, toda a regra de
 * "o que fica bonito" é testável sem navegador. O plugin (markdown-live-plugin)
 * só traduz esta saída para Decoration.set.
 *
 * A marca aparece quando o cursor está na linha: é assim que se edita o que
 * está escondido, sem precisar de um modo "ver fonte".
 */
export interface MdDecoration { from: number; to: number; class?: string; hide?: boolean }

const TITULO = /^(#{1,6})\s+/
const CITACAO = /^>\s?/
const LISTA = /^\s*(?:[-*+]|\d+\.)\s+/
const FENCE = /^\s*(?:```|~~~)/

// Ordem importa: ** antes de *, ~~ antes de qualquer coisa com ~.
const INLINE: { re: RegExp; classe: string }[] = [
  { re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, classe: 'cm-md-strong' },
  { re: /(~~)(?=\S)([\s\S]*?\S)\1/g, classe: 'cm-md-strike' },
  { re: /(?<![*\w])(\*|_)(?=\S)([^*_]*?\S)\1(?![*\w])/g, classe: 'cm-md-em' },
  { re: /(`)([^`]+)\1/g, classe: 'cm-md-code' },
]

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

export function markdownDecorations(text: string, cursorLine: number): MdDecoration[] {
  const saida: MdDecoration[] = []
  let offset = 0
  let dentroDeFence = false

  text.split('\n').forEach((linha, i) => {
    const base = offset
    offset += linha.length + 1
    const naLinhaDoCursor = i === cursorLine
    const esconder = (from: number, to: number) => {
      if (!naLinhaDoCursor) saida.push({ from, to, hide: true })
    }

    if (FENCE.test(linha)) {
      dentroDeFence = !dentroDeFence
      saida.push({ from: base, to: base + linha.length, class: 'cm-md-fence' })
      return
    }
    // Dentro do bloco o texto é código: nada de negrito por causa de um `**`.
    if (dentroDeFence) {
      saida.push({ from: base, to: base + linha.length, class: 'cm-md-codeblock' })
      return
    }

    const titulo = TITULO.exec(linha)
    if (titulo) {
      saida.push({ from: base, to: base + linha.length, class: `cm-md-h${titulo[1].length}` })
      esconder(base, base + titulo[0].length)
    }
    const citacao = CITACAO.exec(linha)
    if (citacao) {
      saida.push({ from: base, to: base + linha.length, class: 'cm-md-quote' })
      esconder(base, base + citacao[0].length)
    }
    // O marcador da lista é conteúdo (some ele, some a estrutura): só estiliza.
    if (LISTA.test(linha)) saida.push({ from: base, to: base + linha.length, class: 'cm-md-list' })

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
