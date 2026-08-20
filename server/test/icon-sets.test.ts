import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { allowedPrefixes, FALLBACK_SETS, isWholeWord } from '../src/icons/sets.js'

let db: Db
beforeEach(() => { db = openDb(':memory:') })

/** O catálogo que a Iconify publica em /collections, reduzido ao que importa. */
const catalog = {
  lucide: { category: 'UI 24px', total: 1775 },
  tabler: { category: 'UI 24px', total: 6184 },
  'material-symbols': { category: 'Material', total: 15597 },
  'game-icons': { category: 'Thematic', total: 4133 },
  'circle-flags': { category: 'Flags / Maps', total: 634 },
  'simple-icons': { category: 'Logos', total: 3453 },
  logos: { category: 'Logos', total: 1880 },
  // O ruído: pacotes de ícone de aplicativo, na mesma categoria dos logos bons.
  arcticons: { category: 'Logos', total: 15057 },
  selfhst: { category: 'Logos', total: 7085 },
  // Fora por categoria.
  noto: { category: 'Emoji', total: 3000 },
  'mdi-legacy': { category: 'Archive / Unmaintained', total: 2000 },
  estranho: { total: 900 },
  // Fora por tamanho: um acervo de 12 desenhos não cobre nada e só suja o ranking.
  minusculo: { category: 'UI 24px', total: 12 },
}

const fakeFetch = (body: unknown = catalog, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch

describe('quais acervos entram na busca', () => {
  /**
   * A regra tem que caber numa frase: iconografia de uso geral, sem emoji, sem
   * pacote de logo de aplicativo. Uma lista de 149 prefixos cravada no código
   * ninguém revisa — e apodrece calada quando a Iconify publica acervo novo.
   */
  it('aceita iconografia de uso geral', async () => {
    const out = await allowedPrefixes(db, { fetch: fakeFetch() })
    for (const p of ['lucide', 'tabler', 'material-symbols', 'game-icons', 'circle-flags']) {
      expect(out, p).toContain(p)
    }
  })

  it('recusa emoji, arquivo morto e acervo sem categoria', async () => {
    const out = await allowedPrefixes(db, { fetch: fakeFetch() })
    for (const p of ['noto', 'mdi-legacy', 'estranho', 'minusculo']) expect(out, p).not.toContain(p)
  })

  /**
   * O caso que estragava a busca: "banco" trazia quinze bancos argentinos do
   * arcticons antes de qualquer desenho de banco de dados, e "loja" trazia a marca
   * Maloja. São pacotes de logo de APLICATIVO — na mesma categoria dos logos que
   * queremos, então a categoria sozinha não separa: os bons entram pelo nome.
   */
  it('dos logos, só os que são de tecnologia', async () => {
    const out = await allowedPrefixes(db, { fetch: fakeFetch() })
    expect(out).toContain('simple-icons')
    expect(out).toContain('logos')
    expect(out).not.toContain('arcticons')
    expect(out).not.toContain('selfhst')
  })

  it('o catálogo é buscado uma vez só', async () => {
    const fetch = fakeFetch()
    await allowedPrefixes(db, { fetch })
    await allowedPrefixes(db, { fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('o catálogo sobrevive ao reinício', async () => {
    const primeiro = fakeFetch()
    await allowedPrefixes(db, { fetch: primeiro })
    const segundo = fakeFetch()
    expect(await allowedPrefixes(openDb(':memory:'), { fetch: segundo })).toBeTruthy()
    // banco novo, catálogo novo — mas o MESMO banco não pergunta de novo
    const terceiro = fakeFetch()
    await allowedPrefixes(db, { fetch: terceiro })
    expect(terceiro).not.toHaveBeenCalled()
  })

  /** Sem catálogo, busca-se nos acervos de sempre em vez de não buscar em nada. */
  it('catálogo indisponível cai nos acervos de sempre', async () => {
    const out = await allowedPrefixes(db, {
      fetch: (async () => { throw new Error('sem rede') }) as unknown as typeof globalThis.fetch,
    })
    expect(out).toEqual(FALLBACK_SETS)
  })

  it('resposta sem sentido também cai no reserva', async () => {
    expect(await allowedPrefixes(db, { fetch: fakeFetch('não é json de catálogo') })).toEqual(FALLBACK_SETS)
  })
})

/**
 * "fila" achava `lightbulb-filament` — o termo é um caco no meio de outra palavra.
 * Um nome em que o termo é um pedaço INTEIRO vale mais que um em que ele só aparece
 * por acaso.
 */
describe('o termo é palavra ou é caco?', () => {
  it('reconhece o termo como pedaço inteiro do nome', () => {
    expect(isWholeWord('server', 'server')).toBe(true)
    expect(isWholeWord('server-cog', 'server')).toBe(true)
    expect(isWholeWord('cloud-server', 'server')).toBe(true)
    expect(isWholeWord('cloud-server-off', 'server')).toBe(true)
  })

  it('não confunde com o termo escondido no meio de outra palavra', () => {
    expect(isWholeWord('lightbulb-filament', 'fila')).toBe(false)
    expect(isWholeWord('mastercard', 'master')).toBe(false)
    expect(isWholeWord('backendless', 'backend')).toBe(false)
    expect(isWholeWord('sitemap', 'site')).toBe(false)
  })
})
