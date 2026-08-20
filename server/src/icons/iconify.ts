import { isSafeIconBody } from './safety.js'

/**
 * Cliente da API pública do Iconify — ~250 mil ícones de 200+ acervos.
 *
 * A documentação deles endossa este uso em letras miúdas: "use API's search engine
 * in custom icon picker to allow users select icons". É serviço gratuito mantido
 * por doação, então o servidor guarda TUDO que busca (ver store.ts): cada desenho
 * é pedido uma vez na vida da instalação, não uma vez por tela aberta.
 */
export interface IconBody {
  /** `prefix:name` — o mesmo formato que vai gravado no banco. */
  token: string
  /** O miolo do SVG, já com `currentColor` — quem pinta é o CSS de quem usa. */
  body: string
  width: number
  height: number
}

export interface IconifyDeps {
  /** Injetável: o teste não fala com a internet. */
  fetch?: typeof globalThis.fetch
  base?: string
}

const BASE = 'https://api.iconify.design'
/** Um pedido travado não pode segurar a tela do seletor. */
const TIMEOUT_MS = 8000

/**
 * Quem aparece primeiro. Buscar "admin" devolve 96 desenhos parecidos espalhados
 * por 40 acervos; sem uma ordem, o seletor vira sopa. Estes são os acervos de
 * linha coerente — o resto vem depois, agrupado.
 */
export const PREFERRED_SETS = [
  'lucide', 'tabler', 'material-symbols', 'ph', 'mdi',
  'simple-icons', 'carbon', 'fa6-solid', 'solar', 'hugeicons',
]

const rankOf = (prefix: string): number => {
  const i = PREFERRED_SETS.indexOf(prefix)
  return i === -1 ? PREFERRED_SETS.length : i
}

async function getJson(url: string, deps: IconifyDeps): Promise<unknown> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await doFetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`iconify ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Busca por UM termo, restrita aos acervos da peneira (ver sets.ts). O filtro vai
 * na URL e não depois: cortar aqui devolveria uma página cheia de ruído já
 * truncada pelo limite deles, e o termo bom ficaria de fora.
 *
 * Falha de rede devolve lista vazia — um termo que não respondeu não pode derrubar
 * os outros do leque.
 */
export async function searchIconify(
  term: string, limit: number, prefixes: string[] = [], deps: IconifyDeps = {},
): Promise<string[]> {
  const base = deps.base ?? BASE
  const filtro = prefixes.length > 0 ? `&prefixes=${prefixes.join(',')}` : ''
  try {
    const data = await getJson(`${base}/search?query=${encodeURIComponent(term)}&limit=${limit}${filtro}`, deps)
    const icons = (data as { icons?: unknown })?.icons
    if (!Array.isArray(icons)) return []
    return icons.filter((x): x is string => typeof x === 'string' && x.includes(':'))
  } catch {
    return []
  }
}

/** `['mdi:server', 'mdi:cpu', 'lucide:box']` → `{ mdi: [...], lucide: [...] }` */
function byPrefix(tokens: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const t of tokens) {
    const at = t.indexOf(':')
    if (at <= 0) continue
    const prefix = t.slice(0, at)
    const name = t.slice(at + 1)
    if (!/^[a-z0-9-]+$/.test(prefix) || !/^[a-z0-9-]+$/.test(name)) continue
    const list = out.get(prefix)
    if (list) list.push(name)
    else out.set(prefix, [name])
  }
  return out
}

/**
 * Os desenhos de uma leva de tokens, um pedido por acervo (`/{prefix}.json?icons=…`).
 *
 * Alias: quando o nome pedido é apelido de outro, a resposta o põe em `aliases`
 * apontando para o `parent`, e o desenho vem no pai. Seguimos o pai — o que se
 * perde são as transformações raras (rotação/espelho) que alguns apelidos
 * carregam, e um ícone de cabeça para baixo é melhor que um buraco na tela.
 */
export async function fetchIconBodies(tokens: string[], deps: IconifyDeps = {}): Promise<IconBody[]> {
  const base = deps.base ?? BASE
  const groups = [...byPrefix(tokens)]

  const perSet = await Promise.all(groups.map(async ([prefix, names]) => {
    try {
      const data = await getJson(`${base}/${prefix}.json?icons=${names.join(',')}`, deps) as {
        icons?: Record<string, { body?: string; width?: number; height?: number }>
        aliases?: Record<string, { parent?: string }>
        width?: number
        height?: number
      }
      const icons = data?.icons ?? {}
      const aliases = data?.aliases ?? {}
      const w = data?.width ?? 24
      const h = data?.height ?? 24

      return names.flatMap<IconBody>((name) => {
        const direct = icons[name]
        const parent = aliases[name]?.parent
        const icon = direct ?? (parent ? icons[parent] : undefined)
        // O portão: o que não se parece com desenho não passa daqui, e portanto
        // nunca chega ao cache nem ao innerHTML do navegador.
        if (!icon?.body || !isSafeIconBody(icon.body)) return []
        return [{ token: `${prefix}:${name}`, body: icon.body, width: icon.width ?? w, height: icon.height ?? h }]
      })
    } catch {
      return []
    }
  }))

  return perSet.flat()
}
