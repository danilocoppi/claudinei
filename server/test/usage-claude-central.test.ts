import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageService } from '../src/usage.js'

/**
 * O uso do Claude não some quando o endpoint falha, e o Claudinei quase não o
 * consulta: a fonte principal é o `rate_limit_event` que os terminais do Claude
 * já recebem a cada turno; o endpoint vem de vez em quando (e espera mais depois
 * de um 429); o último valor bom fica em disco.
 */
const MIN = 60_000
const T0 = Date.parse('2026-11-02T04:00:00Z')
const API_RESPONSE = {
  limits: [
    { kind: 'session', group: 'session', percent: 10, severity: 'normal', resets_at: '2026-11-02T06:00:00Z', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 43, severity: 'normal', resets_at: '2026-11-04T00:00:00Z', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 48, severity: 'normal', resets_at: '2026-11-04T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
  ],
}
const creds = () => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'))
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
  return join(dir, 'credentials.json')
}
const ok = () => new Response(JSON.stringify(API_RESPONSE), { status: 200 })
const limited = (retryAfter = '0') => new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers: { 'retry-after': retryAfter } })
const clock = () => { let t = T0; return { now: () => t, advance: (ms: number) => { t += ms } } }
const pct = (limits: { kind: string; label: string | null; percent: number }[]) =>
  Object.fromEntries(limits.map((l) => [l.label ? `${l.kind}:${l.label}` : l.kind, l.percent]))
/** O que o CLI 2.1.312 manda no stream-json (capturado em 2026-11-02). */
const event = (over: Record<string, unknown> = {}) => ({
  status: 'allowed_warning', resetsAt: Date.parse('2026-11-04T00:00:00Z') / 1000, rateLimitType: 'seven_day', utilization: 0.88,
  unifiedWindows: {
    seven_day: { utilization: 0.88, resetsAt: Date.parse('2026-11-04T00:00:00Z') / 1000, status: 'allowed_warning' },
    five_hour: { utilization: 0.31, resetsAt: Date.parse('2026-11-02T06:00:00Z') / 1000, status: 'allowed' },
  },
  ...over,
})

describe('uso do Claude centralizado', () => {
  it('uma falha depois de um sucesso devolve o último valor bom, com a hora em que veio', async () => {
    const c = clock()
    const fetchFn = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValue(limited())
    const svc = createUsageService({ credentialsPath: creds(), fetchFn: fetchFn as unknown as typeof fetch, now: c.now })
    expect(pct(await svc.getLimits())).toEqual({ session: 10, weekly_all: 43, 'weekly_scoped:Fable': 48 })
    c.advance(11 * MIN)
    const limits = await svc.getLimits()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(pct(limits)).toEqual({ session: 10, weekly_all: 43, 'weekly_scoped:Fable': 48 })
    expect(limits[0].updatedAt).toBe(new Date(T0).toISOString())
  })

  it('consulta o endpoint no máximo a cada 10 minutos', async () => {
    const c = clock()
    const fetchFn = vi.fn().mockImplementation(async () => ok())
    const svc = createUsageService({ credentialsPath: creds(), fetchFn: fetchFn as unknown as typeof fetch, now: c.now })
    await svc.getLimits()
    for (let i = 0; i < 9; i++) { c.advance(MIN); await svc.getLimits() }
    expect(fetchFn).toHaveBeenCalledTimes(1)
    c.advance(MIN)
    await svc.getLimits()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('depois de um 429 espera mais a cada vez (2, 4, 8… até 30 min) e respeita o retry-after maior', async () => {
    const c = clock()
    const fetchFn = vi.fn().mockImplementation(async () => limited())
    const svc = createUsageService({ credentialsPath: creds(), fetchFn: fetchFn as unknown as typeof fetch, now: c.now })
    await svc.getLimits() // 1º 429 → espera 2 min
    c.advance(2 * MIN - 1); await svc.getLimits()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    c.advance(1); await svc.getLimits() // 2º 429 → 4 min
    c.advance(4 * MIN - 1); await svc.getLimits()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    c.advance(1); await svc.getLimits() // 3º → 8 min
    for (const wait of [8, 16, 30, 30]) { c.advance(wait * MIN); await svc.getLimits() }
    expect(fetchFn).toHaveBeenCalledTimes(7)

    const c2 = clock()
    const slow = vi.fn().mockImplementation(async () => limited('900'))
    const svc2 = createUsageService({ credentialsPath: creds(), fetchFn: slow as unknown as typeof fetch, now: c2.now })
    await svc2.getLimits()
    c2.advance(14 * MIN); await svc2.getLimits()
    expect(slow).toHaveBeenCalledTimes(1)
    c2.advance(MIN); await svc2.getLimits()
    expect(slow).toHaveBeenCalledTimes(2)
  })

  it('o rate_limit_event dos terminais vira as barras de 5 h e semanal, sem consultar nada', async () => {
    const c = clock()
    const fetchFn = vi.fn().mockImplementation(async () => limited())
    const svc = createUsageService({ credentialsPath: creds(), fetchFn: fetchFn as unknown as typeof fetch, now: c.now })
    svc.observe(event())
    const limits = await svc.getLimits()
    expect(limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'session', group: 'session', label: null, percent: 31, resetsAt: '2026-11-02T06:00:00.000Z', updatedAt: new Date(T0).toISOString() }),
      expect.objectContaining({ kind: 'weekly_all', group: 'weekly', label: null, percent: 88, resetsAt: '2026-11-04T00:00:00.000Z' }),
    ]))
    expect(limits).toHaveLength(2)
  })

  it('evento sem unifiedWindows usa a janela do topo; rejeitado sem utilização vale 100%', async () => {
    const svc = createUsageService({ credentialsPath: '/nao/existe', now: clock().now })
    svc.observe({ status: 'rejected', resetsAt: Date.parse('2026-11-02T06:00:00Z') / 1000, rateLimitType: 'five_hour' })
    expect(pct(await svc.getLimits())).toEqual({ session: 100 })
    svc.observe('lixo'); svc.observe({ rateLimitType: 'outra_coisa', utilization: 0.5, resetsAt: 1 })
    expect(pct(await svc.getLimits())).toEqual({ session: 100 })
  })

  it('o dado mais novo vence janela por janela; as linhas por modelo vêm do endpoint', async () => {
    const c = clock()
    const fetchFn = vi.fn().mockImplementation(async () => ok())
    const svc = createUsageService({ credentialsPath: creds(), fetchFn: fetchFn as unknown as typeof fetch, now: c.now })
    await svc.getLimits()
    c.advance(MIN)
    svc.observe(event())
    expect(pct(await svc.getLimits())).toEqual({ session: 31, weekly_all: 88, 'weekly_scoped:Fable': 48 })
    c.advance(10 * MIN) // endpoint de novo, agora mais novo que o evento
    expect(pct(await svc.getLimits())).toEqual({ session: 10, weekly_all: 43, 'weekly_scoped:Fable': 48 })
  })

  it('janela que já virou some, em vez de mostrar o percentual antigo', async () => {
    const c = clock()
    const svc = createUsageService({ credentialsPath: '/nao/existe', now: c.now })
    svc.observe(event())
    c.advance(3 * 60 * MIN) // passou do reset das 06:00 da janela de 5 h
    expect(pct(await svc.getLimits())).toEqual({ weekly_all: 88 })
  })

  it('o último valor fica em disco e sobrevive a reiniciar o servidor', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'uso-')), 'claude-usage.json')
    const c = clock()
    const first = createUsageService({ credentialsPath: creds(), fetchFn: vi.fn(async () => ok()) as unknown as typeof fetch, now: c.now, statePath })
    await first.getLimits()
    first.observe(event())
    expect(existsSync(statePath)).toBe(true)
    c.advance(MIN)
    const failing = vi.fn(async () => limited())
    const again = createUsageService({ credentialsPath: creds(), fetchFn: failing as unknown as typeof fetch, now: c.now, statePath })
    expect(pct(await again.getLimits())).toEqual({ session: 31, weekly_all: 88, 'weekly_scoped:Fable': 48 })
    // e não sai consultando ao subir: a última consulta foi há 1 minuto
    expect(failing).not.toHaveBeenCalled()
  })

  it('arquivo de estado corrompido é ignorado', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'uso-')), 'claude-usage.json')
    writeFileSync(statePath, '{quebrado')
    const svc = createUsageService({ credentialsPath: creds(), fetchFn: vi.fn(async () => ok()) as unknown as typeof fetch, now: clock().now, statePath })
    expect(pct(await svc.getLimits())).toEqual({ session: 10, weekly_all: 43, 'weekly_scoped:Fable': 48 })
  })
})

describe('manager → onRateLimit', () => {
  it('o rate_limit_event de um terminal do Claude chega ao serviço; o de outra engine, não', async () => {
    const { EventEmitter } = await import('node:events')
    const { openDb } = await import('../src/db.js')
    const { createSessionManager } = await import('../src/claude/manager.js')
    const { createProjectsService } = await import('../src/projects.js')
    const { classifyLine } = await import('../src/claude/parser.js')
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: event(), uuid: 'u', session_id: 's' })
    class Fake extends EventEmitter {
      status = 'idle'; sessionId = 'fake-1'; lastStderr = ''
      start() { this.emit('event', classifyLine(line)) }
      send() {} markRead() {} async interrupt() {} async setModel() {} async setPermissionMode() {} async setEffort() {} async stop() {}
    }
    const db = openDb(':memory:')
    const projects = createProjectsService(db)
    const seen: unknown[] = []
    const manager = createSessionManager({
      db, broadcast: () => {},
      sessionFactory: () => new Fake() as never,
      onRateLimit: (info) => seen.push(info),
    })
    manager.start(projects.create({ name: 'C', path: mkdtempSync(join(tmpdir(), 'rl-c-')) }) as never, { engine: 'claude' })
    expect(seen).toEqual([event()])
    manager.start(projects.create({ name: 'X', path: mkdtempSync(join(tmpdir(), 'rl-x-')) }) as never, { engine: 'codex' })
    expect(seen).toHaveLength(1)
  })
})
