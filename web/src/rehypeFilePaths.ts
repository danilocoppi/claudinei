// Plugin rehype: quebra candidatos a path de arquivo (o MESMO detector da bolha do
// operador, `candidateRanges`) dentro de nós de texto em elementos `<a data-file="...">`.
// O MessageBlock decide via `components.a` do ReactMarkdown se cada um vira link
// clicável (path confirmado no cache de resolve) ou volta a ser texto puro.
import type { ElementContent, Parents, Root, Text } from 'hast'
import { visitParents } from 'unist-util-visit-parents'
import { candidateRanges } from './files'

// Não mexe em BLOCO de código (<pre>, com os spans do rehype-highlight por dentro)
// nem dentro de <a> já existente — evita mascarar código e aninhar links.
//
// Código INLINE (`/caminho/arquivo.md` entre crases) NÃO entra aqui de propósito:
// é como as engines escrevem caminho na prosa quase sempre, e pular <code> deixava
// justamente esses sem link. O <a> vira filho do <code>; se o path não resolver, o
// components.a do MessageBlock devolve o texto puro — code que não é arquivo fica igual.
const SKIP_TAGS = new Set(['pre', 'a'])

export default function rehypeFilePaths() {
  return (tree: Root) => {
    visitParents(tree, 'text', (node, ancestors) => {
      const parent = ancestors[ancestors.length - 1]
      if (!parent || !('children' in parent)) return
      if (ancestors.some((a) => a.type === 'element' && SKIP_TAGS.has(a.tagName))) return

      const text = (node as Text).value
      // As faixas reais do detector, não `indexOf` de cada candidato: a pasta
      // `docs/x/` citada antes de `docs/x/a.tsx` casava DENTRO do arquivo, no
      // mesmo início, e o arquivo sumia como sobreposição.
      const ranges = candidateRanges(text)
      if (ranges.length === 0) return

      const replacement: ElementContent[] = []
      let cursor = 0
      for (const m of ranges) {
        if (m.start > cursor) replacement.push({ type: 'text', value: text.slice(cursor, m.start) })
        replacement.push({
          type: 'element',
          tagName: 'a',
          properties: { 'data-file': m.path, className: ['file-link'] },
          children: [{ type: 'text', value: text.slice(m.start, m.end) }],
        })
        cursor = m.end
      }
      if (cursor < text.length) replacement.push({ type: 'text', value: text.slice(cursor) })

      const children = (parent as Parents).children as ElementContent[]
      const idx = children.indexOf(node as unknown as ElementContent)
      if (idx === -1) return
      children.splice(idx, 1, ...replacement)
    })
  }
}
