import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { isUnderProjectRoot } from '../files/scope.js'
import { PREVIEW_MIME } from '../routes/files.js'

/**
 * Embute no próprio documento as imagens, o CSS, o JS e as fontes locais que a
 * página puxa por caminho relativo. A página publicada é servida de outro lugar
 * (um arquivo só, sob token), onde esses caminhos não existem mais.
 *
 * Só entra o que, depois do `realpath`, fica dentro da raiz real do projeto: um
 * `../` ou um symlink que aponte para fora não vira porta para ler o disco. O
 * que não dá para embutir fica como está e volta em `missing`, para o agente
 * saber o que a página perdeu. Referência com esquema (`http:`, `data:`…),
 * `//host` ou `#âncora` não é local: segue intacta e sem aviso.
 *
 * Sem parser de HTML: uma passada só pelo documento, com `indexOf` e expressões
 * regulares curtas, que reconhece comentário, `<script>…</script>`,
 * `<style>…</style>` e as demais tags. Assim o JS e o CSS recém-embutidos não
 * são varridos de novo, e um `<img src>` escrito dentro de uma string de script
 * não é mexido. A passada é linear mesmo em entrada hostil (ver `find`).
 */

export interface EmbedResult {
  html: string
  /** Um item por arquivo; `bytes` soma o que entrou no documento (o data: URL ou o texto). */
  embedded: Array<{ ref: string; bytes: number }>
  /**
   * Referência como escrita: ausente, fora do projeto, diretório, extensão sem
   * MIME, tipo errado para a tag (só JS em `<script>`, só CSS em `<link>`) ou
   * arquivo maior que o teto da página.
   */
  missing: string[]
}

/** Teto de um arquivo embutido: o da página inteira. Maior que isso, ela já não caberia. */
const MAX_FILE_BYTES = 524_288

/** Nome da tag logo depois do `<`; `<style-box>` é `style-box`, não `style`. */
const TAG_NAME = /[a-zA-Z][\w:-]*/y
/**
 * Um atributo. Sem `\s*` na frente: com ele, uma tag cheia de espaços fazia o
 * motor recuar sobre eles a cada posição (tempo quadrático). O espaço antes do
 * nome é achado à parte, em `parseAttrs`.
 */
const ATTR = /([^\s"'>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
/**
 * `url(...)` do CSS. `(?=(\s*))\1` é um `\s*` atômico: casa os espaços uma vez e
 * não devolve — sem isso, `url(` seguido de muitos espaços sem `)` recuava
 * sobre cada um (tempo quadrático). Grupos: 2 = "…", 3 = '…', 4 = sem aspas.
 */
const CSS_URL = /url\((?=(\s*))\1(?:"([^"]*)"|'([^']*)'|([^"'()\s]*))(?=(\s*))\5\)/gi

interface Attr { name: string; value: string | null; quote: string; start: number; end: number; ws: string; raw: string; eq: string }

function parseAttrs(s: string): Attr[] {
  const out: Attr[] = []
  let prevEnd = 0
  for (const m of s.matchAll(ATTR)) {
    // O espaço antes do nome conta como parte do atributo (para tirá-lo junto).
    let start = m.index!
    while (start > prevEnd && /\s/.test(s[start - 1])) start--
    const quote = m[3] !== undefined ? '"' : m[4] !== undefined ? "'" : ''
    out.push({
      name: m[1].toLowerCase(), raw: m[1], ws: s.slice(start, m.index!), eq: m[2] ?? '',
      value: m[3] ?? m[4] ?? m[5] ?? null, quote, start, end: m.index! + m[0].length,
    })
    prevEnd = m.index! + m[0].length
  }
  return out
}

/** Troca o valor de um atributo; sem aspas no original, passa a usar `"` (base64 tem `=`). */
function setAttr(s: string, a: Attr, value: string): string {
  const q = a.quote || '"'
  return s.slice(0, a.start) + a.ws + a.raw + (a.eq || '=') + q + value + q + s.slice(a.end)
}

/** Entidades que mudam um caminho escrito num atributo. */
const unescapeAttr = (v: string) => v.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")

/** O tipo sem parâmetros: `text/css; charset=utf-8` → `text/css`. */
const mimeOf = (real: string) => PREVIEW_MIME[extname(real).toLowerCase()]?.split(';')[0].trim()

export function embedLocalResources(html: string, opts: { baseDir: string; projectRoot: string }): EmbedResult {
  const root = { path: opts.projectRoot }
  const reads = new Map<string, Buffer | null>()
  const dataUrls = new Map<string, string>()
  const embedded = new Map<string, { ref: string; bytes: number }>()
  const missing = new Set<string>()

  /** null = não é local (ignora calado); false = local, mas não serve (aviso). */
  function locate(ref: string, baseDir: string): string | null | false {
    const raw = ref.trim()
    if (!raw || raw.startsWith('#') || /^[\\/]{2}/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
    let p = raw.replace(/[?#].*$/s, '')
    try { p = decodeURI(p) } catch { /* % solto: fica o texto cru */ }
    if (!p) return false
    try {
      const real = realpathSync(resolve(baseDir, p))
      const st = statSync(real)
      // Acima do teto nem se lê: um vídeo de 1 GB travaria o laço ou estouraria a string.
      if (!st.isFile() || st.size > MAX_FILE_BYTES || !isUnderProjectRoot(real, root)) return false
      return real
    } catch {
      return false
    }
  }

  // A mesma referência repetida é lida do disco uma vez só.
  function read(real: string): Buffer | null {
    if (!reads.has(real)) {
      let buf: Buffer | null = null
      try { buf = readFileSync(real) } catch { /* sumiu entre o stat e a leitura */ }
      // Cresceu entre o stat e a leitura: vale o mesmo teto.
      reads.set(real, buf && buf.length <= MAX_FILE_BYTES ? buf : null)
    }
    return reads.get(real)!
  }

  function record(real: string, ref: string, bytes: number) {
    const e = embedded.get(real)
    if (e) e.bytes += bytes
    else embedded.set(real, { ref, bytes })
  }

  /**
   * Arquivo local como data: URL; undefined = não é local; null = vira aviso.
   * `ref` vai para `embedded`/`missing` como escrito; `path` é o que se resolve.
   */
  function asDataUrl(ref: string, baseDir: string, path = ref): string | null | undefined {
    const real = locate(path, baseDir)
    if (real === null) return undefined
    const mime = real && PREVIEW_MIME[extname(real).toLowerCase()]
    const buf = real && mime ? read(real) : null
    if (!real || !mime || !buf) { missing.add(ref); return null }
    let url = dataUrls.get(real)
    if (!url) {
      url = `data:${mime.replace(/\s+/g, '')};base64,${buf.toString('base64')}`
      dataUrls.set(real, url)
    }
    record(real, ref, Buffer.byteLength(url))
    return url
  }

  /**
   * Arquivo local como texto, só se for do tipo pedido (CSS para `<link>`, JS
   * para `<script>`): `<script src=".env">` não pode virar o `.env` no documento.
   * undefined = não é local; null = vira aviso.
   */
  function asText(
    ref: string, baseDir: string, path: string, type: 'text/css' | 'text/javascript',
  ): { real: string; text: string } | null | undefined {
    const real = locate(path, baseDir)
    if (real === null) return undefined
    const buf = real && mimeOf(real) === type ? read(real) : null
    if (!real || !buf) { missing.add(ref); return null }
    // O BOM do arquivo não tem lugar no meio do documento.
    return { real, text: buf.toString('utf8').replace(/^\uFEFF/, '') }
  }

  /** `url(...)` do CSS, resolvido a partir de `baseDir`. */
  function css(text: string, baseDir: string): string {
    return text.replace(CSS_URL, (whole, _ws, dq?: string, sq?: string, bare?: string) => {
      const ref = dq ?? sq ?? bare ?? ''
      const url = asDataUrl(ref, baseDir)
      if (!url) return whole
      const q = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
      return `url(${q}${url}${q})`
    })
  }

  function styleAttr(attrs: string): string {
    const a = parseAttrs(attrs).find((x) => x.name === 'style')
    if (!a || a.value === null) return attrs
    const out = css(a.value, opts.baseDir)
    return out === a.value ? attrs : setAttr(attrs, a, out)
  }

  /** `<script>…</script>` ou `<style>…</style>` completo; null = fica como está. */
  function block(tag: string, attrs: string, body: string): string | null {
    if (tag.toLowerCase() === 'style') {
      const a = styleAttr(attrs)
      const b = css(body, opts.baseDir)
      return a === attrs && b === body ? null : `<${tag}${a}>${b}</${tag}>`
    }
    const src = parseAttrs(attrs).find((x) => x.name === 'src')
    if (!src || src.value === null) return null
    const got = asText(src.value, opts.baseDir, unescapeAttr(src.value), 'text/javascript')
    if (!got) return null
    record(got.real, src.value, Buffer.byteLength(got.text))
    const rest = attrs.slice(0, src.start) + attrs.slice(src.end)
    // `</script` no meio do JS fecharia a tag antes da hora.
    return `<${tag}${rest}>${got.text.replace(/<\/(script)/gi, '<\\/$1')}</${tag}>`
  }

  /** Qualquer outra tag de abertura; null = fica como está. */
  function element(tag: string, attrs: string): string | null {
    const name = tag.toLowerCase()
    let a = attrs
    const list = parseAttrs(a)
    if (name === 'link') {
      const rel = list.find((x) => x.name === 'rel')?.value?.toLowerCase().split(/\s+/) ?? []
      const href = list.find((x) => x.name === 'href')
      if (rel.includes('stylesheet') && !rel.includes('alternate') && href?.value) {
        const got = asText(href.value, opts.baseDir, unescapeAttr(href.value), 'text/css')
        if (got) {
          const text = css(got.text, dirname(got.real)).replace(/<\/(style)/gi, '<\\/$1')
          record(got.real, href.value, Buffer.byteLength(text))
          const media = list.find((x) => x.name === 'media')
          const m = media?.value ? ` media="${media.value.replace(/"/g, '&quot;')}"` : ''
          return `<style${m}>${text}</style>`
        }
      }
    } else if (name === 'img') {
      const src = list.find((x) => x.name === 'src')
      if (src?.value) {
        const url = asDataUrl(src.value, opts.baseDir, unescapeAttr(src.value))
        if (url) a = setAttr(a, src, url)
      }
    }
    a = styleAttr(a)
    return a === attrs ? null : `<${tag}${a}>`
  }

  /*
   * Leitura em tempo linear. Tudo que pode não fechar (comentário, bloco, aspas)
   * é procurado com `find`, que lembra de onde em diante o fechamento não existe:
   * quem não acha `-->` a partir de x também não acha a partir de nada depois de
   * x. Sem essa memória (e era o caso da expressão regular única de antes), cada
   * `<` sem par varria o resto do documento de novo — 512 KB de `<a b` levavam
   * ~40 s com o laço de eventos parado.
   */
  const absentFrom = new Map<string, number>()
  function find(key: string, from: number, search: (from: number) => { start: number; end: number } | null) {
    const gone = absentFrom.get(key)
    if (gone !== undefined && from >= gone) return null
    const at = search(from)
    if (!at) absentFrom.set(key, from)
    return at
  }
  const indexOf = (needle: string) => (from: number) => {
    const at = html.indexOf(needle, from)
    return at === -1 ? null : { start: at, end: at + needle.length }
  }
  const closers = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi }
  const closer = (kind: 'script' | 'style') => (from: number) => {
    const re = closers[kind]
    re.lastIndex = from
    const m = re.exec(html)
    return m ? { start: m.index, end: m.index + m[0].length } : null
  }

  /**
   * Fim da tag cujos atributos começam em `from`: `ok` com o índice do `>`, ou o
   * ponto onde a leitura continua quando ela não fecha. `>` entre aspas não
   * fecha; `<` fora de aspas é o começo de outra tag.
   */
  function tagEnd(from: number): { ok: boolean; at: number } {
    for (let j = from; j < html.length; j++) {
      const c = html[j]
      if (c === '>') return { ok: true, at: j }
      if (c === '<') return { ok: false, at: j }
      if (c === '"' || c === "'") {
        const q = find(c, j + 1, indexOf(c))
        if (!q) return { ok: false, at: j + 1 }
        j = q.start
      }
    }
    return { ok: false, at: html.length }
  }

  const parts: string[] = []
  let copied = 0
  const emit = (start: number, end: number, text: string) => {
    parts.push(html.slice(copied, start), text)
    copied = end
  }

  let i = 0
  while ((i = html.indexOf('<', i)) !== -1) {
    if (html.startsWith('<!--', i)) {
      const end = find('-->', i + 4, indexOf('-->'))
      // Comentário sem fim: o `<` fica como texto e a leitura segue.
      i = end ? end.end : i + 1
      continue
    }
    TAG_NAME.lastIndex = i + 1
    const nm = TAG_NAME.exec(html)
    if (!nm) { i++; continue }
    const tag = nm[0]
    const t = tagEnd(i + 1 + tag.length)
    if (!t.ok) { i = t.at; continue }
    const attrs = html.slice(i + 1 + tag.length, t.at)
    const after = t.at + 1
    const kind = tag.toLowerCase()
    if (kind === 'script' || kind === 'style') {
      const c = find(kind, after, closer(kind))
      if (c) {
        const out = block(tag, attrs, html.slice(after, c.start))
        if (out !== null) emit(i, c.end, out)
        i = c.end
      } else {
        i = after // sem fechamento: não mexe, e o resto segue como HTML
      }
      continue
    }
    const out = element(tag, attrs)
    if (out !== null) emit(i, after, out)
    i = after
  }
  parts.push(html.slice(copied))

  return { html: parts.join(''), embedded: [...embedded.values()], missing: [...missing] }
}
