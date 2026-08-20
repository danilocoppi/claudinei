import type { Db } from '../db.js'
import { fetchIconBodies, searchIconify, PREFERRED_SETS, type IconBody, type IconifyDeps } from './iconify.js'
import { allowedPrefixes, isWholeWord } from './sets.js'
import { expandQuery } from './vocabulary.js'

/**
 * O acervo de ícones do Claudinei: ~250 mil desenhos que NÃO viajam dentro do
 * binário.
 *
 * A troca é essa: o que era um `brands.json` de 4 MB embutido (3.453 logos, e
 * ainda assim zero resultados para "admin", "deploy" ou "financeiro") vira uma
 * consulta ao Iconify com cache permanente no banco. O binário encolheu, o acervo
 * multiplicou por 50, e cada desenho é baixado uma vez na vida da instalação.
 *
 * Duas camadas de guarda cobrem os dois modos de uso:
 *  - desenhos ficam no BANCO, para sempre (a sidebar pinta sem rede depois da
 *    primeira vez);
 *  - resultados de BUSCA ficam em memória, porque busca é coisa de quem está com
 *    o seletor aberto e não merece uma tabela.
 */
export interface IconService {
  /** Procura por texto, já devolvendo o desenho pronto para pintar. */
  search(query: string, limit?: number): Promise<IconBody[]>
  /** Os desenhos destes tokens — cache primeiro, rede só para o que falta. */
  bodies(tokens: string[]): Promise<IconBody[]>
}

/** Quantos resultados uma busca devolve. Mais que isso ninguém percorre com o olho. */
const SEARCH_LIMIT = 240
/** Quantos por termo do leque — o termo digitado merece mais espaço que o sinônimo. */
const PER_TERM = 96
/** Buscas lembradas. Cabe uma sessão inteira de garimpo sem virar vazamento. */
const MEMO_MAX = 200

const TOKEN_RE = /^[a-z0-9-]+:[a-z0-9-]+$/

const rankOfSet = (prefix: string): number => {
  const i = PREFERRED_SETS.indexOf(prefix)
  return i === -1 ? PREFERRED_SETS.length : i
}

export function createIconService(db: Db, deps: IconifyDeps = {}): IconService {
  const read = db.prepare<[string], { body: string; width: number; height: number }>(
    'SELECT body, width, height FROM icon_cache WHERE token = ?')
  const write = db.prepare(
    'INSERT OR REPLACE INTO icon_cache (token, body, width, height) VALUES (?, ?, ?, ?)')
  const saveAll = db.transaction((icons: IconBody[]) => {
    for (const i of icons) write.run(i.token, i.body, i.width, i.height)
  })

  const memo = new Map<string, string[]>()

  async function bodies(tokens: string[]): Promise<IconBody[]> {
    // Um token que não tem a cara certa não vira URL: é ele que compõe o caminho
    // do pedido ao Iconify.
    const wanted = [...new Set(tokens)].filter((t) => TOKEN_RE.test(t))
    if (wanted.length === 0) return []

    const found = new Map<string, IconBody>()
    const missing: string[] = []
    for (const token of wanted) {
      const row = read.get(token)
      if (row) found.set(token, { token, ...row })
      else missing.push(token)
    }

    if (missing.length > 0) {
      const fresh = await fetchIconBodies(missing, deps)
      if (fresh.length > 0) saveAll(fresh)
      for (const icon of fresh) found.set(icon.token, icon)
    }

    // A ordem pedida é a ordem devolvida: quem chamou já ranqueou.
    return wanted.map((t) => found.get(t)).filter((i): i is IconBody => !!i)
  }

  async function search(query: string, limit = SEARCH_LIMIT): Promise<IconBody[]> {
    const terms = expandQuery(query)
    if (terms.length === 0) return []

    const key = terms.join('|')
    let ranked = memo.get(key)
    if (!ranked) {
      const prefixes = await allowedPrefixes(db, deps)
      // O leque inteiro de uma vez: o sinônimo não pode esperar o termo digitado.
      const perTerm = await Promise.all(terms.map((t) => searchIconify(t, PER_TERM, prefixes, deps)))

      // Três chaves, nesta ordem, e cada uma conserta um defeito que apareceu de
      // verdade:
      //  1. o nome É o termo, ou ao menos o contém como PALAVRA — não como caco no
      //     meio de outra: senão "fila" abria com `lightbulb-filament` e "master"
      //     com `mastercard`;
      //  2. o que a pessoa digitou vem antes do que o dicionário sugeriu;
      //  3. acervo de linha coerente antes do desconhecido.
      const seen = new Set<string>()
      const scored: { token: string; key: [number, number, number] }[] = []
      perTerm.forEach((list, termIndex) => {
        const term = terms[termIndex]
        for (const token of list) {
          if (seen.has(token)) continue
          seen.add(token)
          const at = token.indexOf(':')
          const nome = token.slice(at + 1)
          const casa = nome === term ? 0 : isWholeWord(nome, term) ? 1 : 2
          scored.push({ token, key: [casa, termIndex, rankOfSet(token.slice(0, at))] })
        }
      })
      scored.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
      ranked = scored.map((s) => s.token)
      if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string)
      memo.set(key, ranked)
    }

    return bodies(ranked.slice(0, limit))
  }

  return { search, bodies }
}
