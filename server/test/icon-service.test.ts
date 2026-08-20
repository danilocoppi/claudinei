import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createIconService } from '../src/icons/service.js'

let db: Db
beforeEach(() => { db = openDb(':memory:') })

/** Uma Iconify de mentira: responde busca e lote, e CONTA quantas vezes foi chamada. */
function fakeIconify(catalog: Record<string, string[]> = {}) {
  const calls: string[] = []
  const fetch = vi.fn(async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    const search = /\/search\?query=([^&]+)/.exec(u)
    if (search) {
      const term = decodeURIComponent(search[1])
      const icons = catalog[term] ?? []
      return new Response(JSON.stringify({ icons, total: icons.length }), { status: 200 })
    }
    const batch = /\/([a-z0-9-]+)\.json\?icons=([^&]+)/.exec(u)
    if (batch) {
      const [, prefix, names] = batch
      const icons: Record<string, { body: string }> = {}
      for (const n of names.split(',')) icons[n] = { body: `<path d="${prefix}/${n}"/>` }
      return new Response(JSON.stringify({ prefix, icons, width: 24, height: 24 }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
  return {
    deps: { fetch: fetch as unknown as typeof globalThis.fetch, base: 'http://fake' },
    calls,
    searches: () => calls.filter((c) => c.includes('/search?')),
    batches: () => calls.filter((c) => c.includes('.json?icons=')),
  }
}

describe('desenhos sob demanda', () => {
  it('busca o desenho no Iconify e devolve o miolo do SVG', async () => {
    const fake = fakeIconify()
    const icons = createIconService(db, fake.deps)
    const [icon] = await icons.bodies(['mdi:server'])
    expect(icon.token).toBe('mdi:server')
    expect(icon.body).toContain('mdi/server')
    expect(icon.width).toBe(24)
  })

  /**
   * O ponto do cache: a sidebar mostra um ícone por terminal a cada carregamento
   * de página. Sem isto, seriam dezenas de idas à API deles por refresh — e a
   * cortesia mínima com um serviço gratuito é pedir cada desenho UMA vez.
   */
  it('o segundo pedido não toca na rede', async () => {
    const fake = fakeIconify()
    const icons = createIconService(db, fake.deps)
    await icons.bodies(['mdi:server', 'lucide:box'])
    expect(fake.batches()).toHaveLength(2) // um pedido por acervo
    await icons.bodies(['mdi:server', 'lucide:box'])
    expect(fake.batches()).toHaveLength(2) // nada novo
  })

  it('o cache sobrevive ao reinício (mora no banco, não na memória)', async () => {
    const fake = fakeIconify()
    await createIconService(db, fake.deps).bodies(['mdi:server'])
    const outro = createIconService(db, fake.deps)
    const [icon] = await outro.bodies(['mdi:server'])
    expect(icon.body).toContain('mdi/server')
    expect(fake.batches()).toHaveLength(1)
  })

  /** Pedido misto: só o que falta vai para a rede. */
  it('pede à rede só o que ainda não tem', async () => {
    const fake = fakeIconify()
    const icons = createIconService(db, fake.deps)
    await icons.bodies(['mdi:server'])
    fake.calls.length = 0
    await icons.bodies(['mdi:server', 'mdi:database'])
    expect(fake.batches()).toHaveLength(1)
    expect(fake.batches()[0]).toContain('icons=database')
    expect(fake.batches()[0]).not.toContain('server')
  })

  it('token malformado não vira requisição', async () => {
    const fake = fakeIconify()
    const icons = createIconService(db, fake.deps)
    expect(await icons.bodies(['sem-dois-pontos', '../etc/passwd', ':vazio'])).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  /** Iconify fora do ar não pode virar tela branca — só ícone que não aparece. */
  it('rede caída devolve vazio em vez de explodir', async () => {
    const icons = createIconService(db, {
      fetch: (async () => { throw new Error('sem rede') }) as unknown as typeof globalThis.fetch,
      base: 'http://fake',
    })
    expect(await icons.bodies(['mdi:server'])).toEqual([])
  })
})

describe('busca', () => {
  it('a palavra digitada é procurada tal como veio', async () => {
    const fake = fakeIconify({ terminal: ['lucide:terminal'] })
    const icons = createIconService(db, fake.deps)
    const out = await icons.search('terminal')
    expect(out.map((i) => i.token)).toContain('lucide:terminal')
  })

  /**
   * O caso que motivou tudo: "financeiro" não existe como nome de ícone em lugar
   * nenhum do mundo, mas quem digita isso quer uma carteira.
   */
  it('palavra em português acha desenho pelo dicionário', async () => {
    const fake = fakeIconify({ financeiro: [], wallet: ['lucide:wallet', 'mdi:wallet'] })
    const icons = createIconService(db, fake.deps)
    const out = await icons.search('financeiro')
    expect(out.map((i) => i.token)).toContain('lucide:wallet')
  })

  it('o que a pessoa digitou vem antes do que o dicionário sugeriu', async () => {
    const fake = fakeIconify({ admin: ['mdi:admin'], shield: ['mdi:shield'] })
    const icons = createIconService(db, fake.deps)
    const out = await icons.search('admin')
    expect(out[0].token).toBe('mdi:admin')
  })

  /** Um acervo de linha coerente na frente; o resto existe, mas depois. */
  it('acervo preferido aparece antes do desconhecido', async () => {
    const fake = fakeIconify({ caixa: [], box: ['zzz-obscuro:box', 'lucide:box'] })
    const icons = createIconService(db, fake.deps)
    const out = await icons.search('box')
    expect(out[0].token).toBe('lucide:box')
  })

  it('o mesmo ícone achado por dois caminhos aparece uma vez só', async () => {
    const fake = fakeIconify({ backend: ['mdi:server'], server: ['mdi:server'], database: ['mdi:server'] })
    const icons = createIconService(db, fake.deps)
    const out = await icons.search('backend')
    expect(out.filter((i) => i.token === 'mdi:server')).toHaveLength(1)
  })

  it('busca vazia não vai à rede', async () => {
    const fake = fakeIconify()
    expect(await createIconService(db, fake.deps).search('   ')).toEqual([])
    expect(fake.calls).toHaveLength(0)
  })

  /** A busca já traz o desenho: sem isso a grade abriria vazia e preencheria depois. */
  it('o resultado já vem com o desenho pronto para pintar', async () => {
    const fake = fakeIconify({ terminal: ['lucide:terminal'] })
    const out = await createIconService(db, fake.deps).search('terminal')
    expect(out[0].body).toContain('lucide/terminal')
  })

  it('a mesma busca duas vezes não repete o leque de consultas', async () => {
    const fake = fakeIconify({ deploy: ['mdi:deploy'], rocket: ['mdi:rocket'] })
    const icons = createIconService(db, fake.deps)
    await icons.search('deploy')
    const n = fake.searches().length
    await icons.search('deploy')
    expect(fake.searches()).toHaveLength(n)
  })
})

/**
 * O cache é permanente: um desenho envenenado que entrasse ali ficaria servindo
 * para sempre, sem nova ida à rede que pudesse corrigi-lo. Por isso o portão fica
 * ANTES do cache, não na renderização.
 */
describe('o que vem de fora não entra sem passar pelo portão', () => {
  it('desenho com executável é descartado e não fica gravado', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      prefix: 'mdi', width: 24, height: 24,
      icons: { mau: { body: '<path d="M0 0" onload="alert(1)"/>' }, bom: { body: '<path d="M1 1"/>' } },
    }), { status: 200 }))
    const icons = createIconService(db, { fetch: fetch as unknown as typeof globalThis.fetch, base: 'http://fake' })
    const out = await icons.bodies(['mdi:mau', 'mdi:bom'])
    expect(out.map((i) => i.token)).toEqual(['mdi:bom'])
    expect(db.prepare('SELECT count(*) n FROM icon_cache').get()).toEqual({ n: 1 })
  })
})
