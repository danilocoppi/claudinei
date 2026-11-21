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
 * Busca por expressão regular, sem parser de HTML. Uma passada só pelo
 * documento, que reconhece comentário, `<script>…</script>`, `<style>…</style>`
 * e as demais tags: assim o JS e o CSS recém-embutidos não são varridos de novo,
 * e um `<img src>` escrito dentro de uma string de script não é mexido.
 */

export interface EmbedResult {
  html: string
  /** Um item por arquivo; `bytes` soma o que entrou no documento (o data: URL ou o texto). */
  embedded: Array<{ ref: string; bytes: number }>
  /** Referência como escrita: ausente, fora do projeto, diretório ou extensão sem MIME. */
  missing: string[]
}

/** Atributos de uma tag, tolerando `>` dentro de valor entre aspas. */
const ATTRS = `((?:"[^"]*"|'[^']*'|[^'">])*)`
const TOKEN = new RegExp(
  `<!--[\\s\\S]*?-->|<(script|style)\\b${ATTRS}>([\\s\\S]*?)<\\/\\1\\s*>|<([a-zA-Z][\\w:-]*)\\b${ATTRS}>`,
  'gi',
)
const ATTR = /(\s*)([^\s"'>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]*))\s*\)/gi

interface Attr { name: string; value: string | null; quote: string; start: number; end: number; ws: string; raw: string; eq: string }

function parseAttrs(s: string): Attr[] {
  const out: Attr[] = []
  for (const m of s.matchAll(ATTR)) {
    if (!m[2]) continue
    const quote = m[4] !== undefined ? '"' : m[5] !== undefined ? "'" : ''
    out.push({
      name: m[2].toLowerCase(), raw: m[2], ws: m[1], eq: m[3] ?? '',
      value: m[4] ?? m[5] ?? m[6] ?? null, quote, start: m.index!, end: m.index! + m[0].length,
    })
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
      if (!statSync(real).isFile() || !isUnderProjectRoot(real, root)) return false
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
      reads.set(real, buf)
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

  /** Arquivo local como texto (CSS ou JS); undefined = não é local; null = vira aviso. */
  function asText(ref: string, baseDir: string, path = ref): { real: string; text: string } | null | undefined {
    const real = locate(path, baseDir)
    if (real === null) return undefined
    const buf = real ? read(real) : null
    if (!real || !buf) { missing.add(ref); return null }
    return { real, text: buf.toString('utf8') }
  }

  /** `url(...)` do CSS, resolvido a partir de `baseDir`. */
  function css(text: string, baseDir: string): string {
    return text.replace(CSS_URL, (whole, dq?: string, sq?: string, bare?: string) => {
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

  const out = html.replace(TOKEN, (whole, block?: string, blockAttrs?: string, body?: string, tag?: string, attrs?: string) => {
    if (block) {
      const kind = block.toLowerCase()
      if (kind === 'style') {
        return `<${block}${styleAttr(blockAttrs!)}>${css(body!, opts.baseDir)}</${block}>`
      }
      const src = parseAttrs(blockAttrs!).find((x) => x.name === 'src')
      if (!src || src.value === null) return whole
      const got = asText(src.value, opts.baseDir, unescapeAttr(src.value))
      if (!got) return whole
      record(got.real, src.value, Buffer.byteLength(got.text))
      const rest = blockAttrs!.slice(0, src.start) + blockAttrs!.slice(src.end)
      // `</script` no meio do JS fecharia a tag antes da hora.
      return `<${block}${rest}>${got.text.replace(/<\/(script)/gi, '<\\/$1')}</${block}>`
    }
    if (!tag) return whole // comentário
    const name = tag.toLowerCase()
    if (name === 'script' || name === 'style') return whole // sem fechamento: não mexe
    let a = attrs!
    const list = parseAttrs(a)
    if (name === 'link') {
      const rel = list.find((x) => x.name === 'rel')?.value?.toLowerCase().split(/\s+/) ?? []
      const href = list.find((x) => x.name === 'href')
      if (rel.includes('stylesheet') && !rel.includes('alternate') && href?.value) {
        const got = asText(href.value, opts.baseDir, unescapeAttr(href.value))
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
    return a === attrs ? whole : `<${tag}${a}>`
  })

  return { html: out, embedded: [...embedded.values()], missing: [...missing] }
}
