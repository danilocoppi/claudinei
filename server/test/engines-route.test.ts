import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import '../src/engine/index.js'

let app: Awaited<ReturnType<typeof buildApp>>
beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
})

describe('GET /api/engines', () => {
  it('lista claude e codex com metadados + capabilities', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/engines' })
    expect(res.statusCode).toBe(200)
    const engines = res.json() as any[]
    const byId = Object.fromEntries(engines.map((e) => [e.id, e]))
    expect(byId.claude.label).toBeTruthy()
    expect(byId.claude.icon).toBeTruthy()
    expect(byId.claude.models).toContain('fable')
    expect(byId.claude.slashSource).toBe('protocol')
    expect(byId.codex.label).toBeTruthy()
    expect(byId.codex.efforts).toContain('xhigh')
    expect(byId.codex.permissions).toEqual([])
    expect(byId.codex.slashSource).toBe('curated')
    expect(byId.codex.slashCommands.length).toBeGreaterThan(0)
  })
})

describe('GET /api/engines — ordem de exibição', () => {
  it('ordem canônica (claude, codex, kimi, opencode) com as NÃO instaladas por último', async () => {
    const prev = { codex: process.env.CLAUDINEI_CODEX_BIN, kimi: process.env.CLAUDINEI_KIMI_BIN }
    // codex e kimi ausentes → devem cair para o fim, preservando a ordem entre si
    process.env.CLAUDINEI_CODEX_BIN = `/nao/existe/codex-${Date.now()}`
    process.env.CLAUDINEI_KIMI_BIN = `/nao/existe/kimi-${Date.now()}`
    try {
      const engines = (await app.inject({ method: 'GET', url: '/api/engines' })).json() as any[]
      const instaladas = engines.filter((e) => e.available !== false).map((e) => e.id)
      const ausentes = engines.filter((e) => e.available === false).map((e) => e.id)
      // as ausentes ficam DEPOIS de todas as instaladas
      expect(engines.map((e) => e.id)).toEqual([...instaladas, ...ausentes])
      // e a ordem canônica se mantém dentro de cada grupo (sort estável)
      expect(ausentes.filter((id) => id === 'codex' || id === 'kimi')).toEqual(['codex', 'kimi'])
    } finally {
      for (const [k, v] of [['CLAUDINEI_CODEX_BIN', prev.codex], ['CLAUDINEI_KIMI_BIN', prev.kimi]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    }
  })

  it('sem nenhuma ausente, vale a ordem do registry', async () => {
    const engines = (await app.inject({ method: 'GET', url: '/api/engines' })).json() as any[]
    const ids = engines.map((e) => e.id)
    const canonica = ['claude', 'codex', 'kimi', 'opencode']
    // compara só as que estão no mesmo grupo de disponibilidade do claude
    const instaladas = engines.filter((e) => e.available !== false).map((e) => e.id)
    expect(instaladas).toEqual(canonica.filter((id) => instaladas.includes(id)))
    expect(ids.length).toBe(canonica.length)
  })
})

describe('GET /api/engines — disponibilidade da CLI', () => {
  it('engine com binário inexistente vem com available:false; instalada vem true', async () => {
    const prev = process.env.CLAUDINEI_OPENCODE_BIN
    process.env.CLAUDINEI_OPENCODE_BIN = `/nao/existe/opencode-${Date.now()}` // chave única fura o cache
    try {
      const res = await app.inject({ method: 'GET', url: '/api/engines' })
      const byId = Object.fromEntries((res.json() as any[]).map((e) => [e.id, e]))
      expect(byId.opencode.available).toBe(false)
      expect(byId.opencode.installHint).toContain('opencode')
      expect(typeof byId.claude.available).toBe('boolean')
    } finally {
      if (prev === undefined) delete process.env.CLAUDINEI_OPENCODE_BIN
      else process.env.CLAUDINEI_OPENCODE_BIN = prev
    }
  })
})
