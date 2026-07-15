import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { createUsageService } from '../src/usage.js'
import { registerUsageRoutes } from '../src/routes/usage.js'

/** Resposta real do endpoint (spike 2026-07-12), reduzida ao que importa. */
const API_RESPONSE = {
  limits: [
    { kind: 'session', group: 'session', percent: 10, severity: 'normal', resets_at: '2026-07-12T13:20:00Z', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 43, severity: 'normal', resets_at: '2026-07-14T00:00:00Z', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 48, severity: 'normal', resets_at: '2026-07-14T00:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
  ],
}

function makeCreds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'))
  const path = join(dir, 'credentials.json')
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-teste' } }))
  return path
}

const okFetch = () => vi.fn(async () => new Response(JSON.stringify(API_RESPONSE), { status: 200 })) as unknown as typeof fetch

describe('createUsageService', () => {
  it('normaliza os limits (label do scoped, resets_at → resetsAt)', async () => {
    const fetchFn = okFetch()
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    const limits = await svc.getLimits()
    expect(limits).toEqual([
      { kind: 'session', group: 'session', label: null, percent: 10, severity: 'normal', resetsAt: '2026-07-12T13:20:00Z' },
      { kind: 'weekly_all', group: 'weekly', label: null, percent: 43, severity: 'normal', resetsAt: '2026-07-14T00:00:00Z' },
      { kind: 'weekly_scoped', group: 'weekly', label: 'Fable', percent: 48, severity: 'normal', resetsAt: '2026-07-14T00:00:00Z' },
    ])
    // headers corretos
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).toBe('https://api.anthropic.com/api/oauth/usage')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-teste')
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe('oauth-2025-04-20')
  })

  it('cache: duas chamadas dentro do cacheMs fazem UM fetch', async () => {
    const fetchFn = okFetch()
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn, cacheMs: 60_000 })
    await svc.getLimits()
    await svc.getLimits()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('sem arquivo de credenciais → []', async () => {
    const svc = createUsageService({ credentialsPath: '/nao/existe.json', fetchFn: okFetch() })
    expect(await svc.getLimits()).toEqual([])
  })

  it('401 da API → []', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    expect(await svc.getLimits()).toEqual([])
  })

  it('shape inesperado → []', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ nada: true }), { status: 200 })) as unknown as typeof fetch
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    expect(await svc.getLimits()).toEqual([])
  })

  it('erro de rede → [] (e não lança)', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    expect(await svc.getLimits()).toEqual([])
  })
})

describe('GET /api/usage', () => {
  it('devolve { limits } do serviço', async () => {
    const app = Fastify()
    await registerUsageRoutes(app, { usage: { getLimits: async () => [{ kind: 'session', group: 'session', label: null, percent: 10, severity: 'normal', resetsAt: 'x' }] } })
    const res = await app.inject({ method: 'GET', url: '/api/usage' })
    expect(res.statusCode).toBe(200)
    expect(res.json().limits).toHaveLength(1)
    await app.close()
  })

  it('sem engineUsage nas deps (testes legados) → tokens: {}', async () => {
    const app = Fastify()
    await registerUsageRoutes(app, { usage: { getLimits: async () => [] } })
    const res = await app.inject({ method: 'GET', url: '/api/usage' })
    expect(res.json()).toEqual({ limits: [], tokens: {} })
    await app.close()
  })

  it('devolve { limits, tokens } — um record de codex aparece em tokens.codex.{total,today}', async () => {
    const app = Fastify()
    const codexTokens = { input: 10, cachedInput: 2, output: 5, reasoning: 1, total: 16 }
    const tokens = { codex: { total: codexTokens, today: codexTokens } }
    await registerUsageRoutes(app, { usage: { getLimits: async () => [] }, engineUsage: { all: () => tokens } })
    const res = await app.inject({ method: 'GET', url: '/api/usage' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ limits: [], tokens })
    await app.close()
  })
})
