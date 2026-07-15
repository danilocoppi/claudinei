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
