import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb, type Db } from '../src/db.js'
import { createEngineUsageService } from '../src/engine-usage.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createProjectsService } from '../src/projects.js'
import type { EngineSession, EngineSessionOptions } from '../src/engine/types.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db

beforeEach(() => {
  db = openDb(':memory:')
})

describe('createEngineUsageService', () => {
  it('record acumula (soma) por engine — total e today iguais dentro do mesmo dia', () => {
    const svc = createEngineUsageService(db)
    svc.record('codex', { input: 10, cachedInput: 2, output: 5, reasoning: 1, total: 16 })
    svc.record('codex', { input: 4, cachedInput: 0, output: 3, reasoning: 0, total: 7 })
    const expected = { input: 14, cachedInput: 2, output: 8, reasoning: 1, total: 23 }
    expect(svc.all().codex).toEqual({ total: expected, today: expected })
  })

  it('all() devolve o mapa por engine, engines diferentes não se misturam', () => {
    const svc = createEngineUsageService(db)
    svc.record('codex', { input: 1, cachedInput: 0, output: 1, reasoning: 0, total: 2 })
    svc.record('outra-engine', { input: 5, cachedInput: 0, output: 5, reasoning: 0, total: 10 })
    const all = svc.all()
    expect(Object.keys(all).sort()).toEqual(['codex', 'outra-engine'])
    expect(all.codex.total.total).toBe(2)
    expect(all['outra-engine'].total.total).toBe(10)
  })

  it('sem nenhum record → all() devolve {}', () => {
    const svc = createEngineUsageService(db)
    expect(svc.all()).toEqual({})
  })

  it('persiste no mesmo db: um segundo service sobre a mesma conexão enxerga os dados acumulados', () => {
    const svc1 = createEngineUsageService(db)
    svc1.record('codex', { input: 10, cachedInput: 0, output: 0, reasoning: 0, total: 10 })
    const svc2 = createEngineUsageService(db)
    expect(svc2.all().codex.total.total).toBe(10)
  })

  it('bucket por dia: today reflete só o dia corrente (clock injetável), total soma todos os dias', () => {
    let clock = new Date('2026-07-10T12:00:00Z')
    const svc = createEngineUsageService(db, () => clock)
    svc.record('codex', { input: 10, cachedInput: 0, output: 0, reasoning: 0, total: 10 })

    clock = new Date('2026-07-11T00:30:00Z')
    svc.record('codex', { input: 3, cachedInput: 0, output: 0, reasoning: 0, total: 3 })

    const all = svc.all()
    // total = soma dos dois dias
    expect(all.codex.total).toEqual({ input: 13, cachedInput: 0, output: 0, reasoning: 0, total: 13 })
    // today = só o dia corrente (o último registrado, 2026-07-11)
    expect(all.codex.today).toEqual({ input: 3, cachedInput: 0, output: 0, reasoning: 0, total: 3 })
  })

  it('engine com histórico mas nenhum record hoje → today zerado, total preservado', () => {
    let clock = new Date('2026-07-10T12:00:00Z')
    const svc = createEngineUsageService(db, () => clock)
    svc.record('codex', { input: 10, cachedInput: 0, output: 0, reasoning: 0, total: 10 })

    clock = new Date('2026-07-12T00:00:00Z') // dia seguinte, sem novo record
    const all = svc.all()
    expect(all.codex.total).toEqual({ input: 10, cachedInput: 0, output: 0, reasoning: 0, total: 10 })
    expect(all.codex.today).toEqual({ input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 })
  })
})

/** Sessão fake mínima: no start(), emite um 'event' de result com tokens — exercita o wire() do manager de ponta a ponta. */
class FakeUsageSession extends EventEmitter implements EngineSession {
  status: 'idle' = 'idle'
  sessionId = 'fake-usage-1'
  lastStderr = ''
  start(): void {
    this.emit('event', {
      kind: 'result',
      subtype: 'success',
      isError: false,
      resultText: '',
      costUsd: 0,
      raw: {},
      tokens: { input: 10, cachedInput: 2, output: 5, reasoning: 1, total: 16 },
    })
  }
  send(): void {}
  markRead(): void {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe('manager → onEngineUsage (integração leve)', () => {
  it('um turno do manager que emite result.tokens aciona onEngineUsage, que acumula no serviço', () => {
    const projects = createProjectsService(db)
    const project = projects.create({ name: 'P-usage', path: mkdtempSync(join(tmpdir(), 'eng-usage-')) })
    const engineUsage = createEngineUsageService(db)

    const manager = createSessionManager({
      db,
      broadcast: () => {},
      sessionFactory: (_opts: EngineSessionOptions) => new FakeUsageSession() as unknown as EngineSession,
      onEngineUsage: (engine, tokens) => engineUsage.record(engine, tokens),
    })

    manager.start(project as any, { engine: 'codex' })

    const expected = { input: 10, cachedInput: 2, output: 5, reasoning: 1, total: 16 }
    expect(engineUsage.all().codex).toEqual({ total: expected, today: expected })
  })
})
