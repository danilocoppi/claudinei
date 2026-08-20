/**
 * O portão entre um serviço de terceiro e o `innerHTML` do navegador.
 *
 * O miolo do SVG vem de api.iconify.design e é injetado como HTML na página. Um
 * `<script>` inserido assim não roda — mas `onload=`, `onbegin=` e `href=
 * "javascript:"` rodam, e um comprometimento lá viraria execução de código na
 * sessão de quem só queria escolher um ícone.
 *
 * Aqui se RECUSA, não se limpa. Um desenho de ícone é um punhado de formas
 * geométricas; o que não se parece com isso não entra no cache. Limpador erra pela
 * metade (e cada tentativa de contorno é um bug novo); lista branca erra fechando
 * a porta, e o pior que acontece é um ícone não aparecer.
 */

/** Os elementos de que um ícone é feito. Tudo que desenha, nada que executa. */
const ALLOWED_TAGS = new Set([
  'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon',
  'g', 'defs', 'use', 'symbol', 'mask', 'clippath', 'title', 'desc',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'filter',
  'fegaussianblur', 'femerge', 'femergenode', 'feoffset', 'feblend',
  'fecolormatrix', 'fecomposite', 'feflood', 'text', 'tspan',
])

/** Um ícone não tem 200 KB de traçado — o que tem, é outra coisa. */
const MAX_BODY = 96 * 1024

export function isSafeIconBody(body: string): boolean {
  if (typeof body !== 'string') return false
  const trimmed = body.trim()
  if (trimmed === '' || trimmed.length > MAX_BODY) return false

  // Manipulador de evento em QUALQUER forma de escrita. O `\s*` entre `on` e o
  // nome cobre o disfarce com espaço ou tabulação no meio do atributo.
  if (/\bon\s*[a-z]+\s*=/i.test(trimmed)) return false
  // Protocolos que executam ou embutem, em qualquer atributo.
  if (/(javascript|data|vbscript)\s*:/i.test(trimmed)) return false
  // `style` carrega url() e expressões: não faz falta num ícone monocromático.
  if (/\bstyle\s*=/i.test(trimmed)) return false

  // Toda referência tem que ser interna à própria página.
  for (const m of trimmed.matchAll(/\b(?:xlink:)?href\s*=\s*["']?([^"'\s>]*)/gi)) {
    if (!m[1].startsWith('#')) return false
  }

  // E todo elemento tem que estar na lista.
  const tags = [...trimmed.matchAll(/<\s*\/?\s*([a-z][a-z0-9-]*)/gi)]
  if (tags.length === 0) return false
  return tags.every((m) => ALLOWED_TAGS.has(m[1].toLowerCase()))
}
