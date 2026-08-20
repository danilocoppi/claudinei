import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

let db: Db
let app: FastifyInstance

const fetch = vi.fn(async (url: string | URL) => {
  const u = String(url)
  if (u.includes('/search?')) {
    const term = decodeURIComponent(/query=([^&]+)/.exec(u)![1])
    return new Response(JSON.stringify({ icons: term === 'terminal' ? ['lucide:terminal'] : [] }), { status: 200 })
  }
  const batch = /\/([a-z0-9-]+)\.json\?icons=([^&]+)/.exec(u)
  if (batch) {
    const icons = Object.fromEntries(batch[2].split(',').map((n) => [n, { body: `<path d="${n}"/>` }]))
    return new Response(JSON.stringify({ prefix: batch[1], icons, width: 24, height: 24 }), { status: 200 })
  }
  return new Response('{}', { status: 404 })
})

beforeEach(async () => {
  fetch.mockClear()
  db = openDb(':memory:')
  app = await buildApp({
    db,
    manager: createSessionManager({ db, broadcast: () => {} }),
    config: loadConfig({}),
    iconify: { fetch: fetch as unknown as typeof globalThis.fetch, base: 'http://fake' },
  })
})
afterEach(async () => { await app.close() })

const get = (url: string) => app.inject({ method: 'GET', url })

describe('GET /api/icons/search', () => {
  it('acha o que existe', async () => {
    const r = await get('/api/icons/search?q=terminal')
    expect(r.statusCode).toBe(200)
    expect(r.json().icons[0]).toMatchObject({ token: 'lucide:terminal', width: 24 })
    expect(r.json().icons[0].body).toContain('path')
  })

  it('sem termo, lista vazia — não é erro procurar nada', async () => {
    expect((await get('/api/icons/search')).json()).toEqual({ icons: [] })
  })
})

describe('GET /api/icons/bodies', () => {
  it('devolve o desenho dos tokens pedidos', async () => {
    const r = await get('/api/icons/bodies?tokens=lucide:terminal,mdi:server')
    expect(r.json().icons.map((i: { token: string }) => i.token)).toEqual(['lucide:terminal', 'mdi:server'])
  })

  it('lista vazia quando não se pede nada', async () => {
    expect((await get('/api/icons/bodies?tokens=')).json()).toEqual({ icons: [] })
    expect((await get('/api/icons/bodies')).json()).toEqual({ icons: [] })
  })

  /**
   * A lista vem da URL e vira um lote contra um serviço gratuito de terceiros:
   * sem teto, um pedido só poderia disparar milhares de buscas em nome deles.
   */
  it('um pedido gigante é cortado antes de virar lote', async () => {
    const tokens = Array.from({ length: 500 }, (_, i) => `mdi:i${i}`).join(',')
    const r = await get(`/api/icons/bodies?tokens=${tokens}`)
    expect(r.json().icons.length).toBeLessThanOrEqual(200)
  })

  /** O token compõe a URL do pedido: o que não tem a cara certa não vai. */
  it('token torto é descartado sem tocar na rede', async () => {
    const r = await get('/api/icons/bodies?tokens=' + encodeURIComponent('../../etc/passwd'))
    expect(r.json()).toEqual({ icons: [] })
    expect(fetch).not.toHaveBeenCalled()
  })
})
