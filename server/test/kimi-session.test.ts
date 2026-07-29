import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KimiSession } from '../src/engine/kimi/kimi-session.js'
import { kimiHomeFor } from '../src/engine/kimi/kimi-home.js'
import type { AgentEvent } from '../src/engine/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-kimi.mjs')
const PROJ = '/tmp'

const mk = () => new KimiSession({ projectPath: PROJ, binOverride: process.execPath, extraArgsOverride: [FAKE] })
const waitFor = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})
const textOf = (e: AgentEvent) => JSON.stringify((e as any).message ?? '')

const envBackup = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, CLAUDINEI_KIMI_HOMES: process.env.CLAUDINEI_KIMI_HOMES }
beforeEach(() => {
  process.env.KIMI_CODE_HOME = mkdtempSync(join(tmpdir(), 'kimi-user-'))
  process.env.CLAUDINEI_KIMI_HOMES = mkdtempSync(join(tmpdir(), 'kimi-homes-'))
})
afterEach(() => {
  for (const k of ['KIMI_FAKE_HANG', 'KIMI_FAKE_CRASH', 'KIMI_FAKE_TOOL', 'KIMI_FAKE_ECHO_HOME']) delete process.env[k]
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

describe('KimiSession (turn-based)', () => {
  it('start() não spawna; status idle', () => {
    const s = mk(); s.start()
    expect(s.status).toBe('idle')
  })

  it('send() roda um turno: assistant + init(sessionId no fim) + result; volta a needs_attention', async () => {
    const s = mk(); s.start()
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('hello')
    expect(s.status).toBe('working')
    await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('session_FAKE')
    expect(events.some((e) => e.kind === 'assistant' && textOf(e).includes('echo:hello'))).toBe(true)
    expect(events.some((e) => e.kind === 'init')).toBe(true)
    const result = events.find((e) => e.kind === 'result') as any
    expect(result).toBeTruthy()
    expect(result.isError).toBe(false)
    expect(result.resultText).toBe('echo:hello') // texto do último assistant
  })

  it('2º send retoma a conversa (-r) mantendo o mesmo id', async () => {
    const s = mk(); s.start()
    s.send('um'); await waitFor(() => s.status === 'needs_attention')
    s.markRead()
    s.send('dois'); await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('session_FAKE') // o fake ecoa o -r recebido
  })

  it('tool call vira tool_use + tool_result casados', async () => {
    process.env.KIMI_FAKE_TOOL = '1'
    const s = mk(); s.start()
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('liste'); await waitFor(() => s.status === 'needs_attention')
    const use = events.find((e) => textOf(e).includes('tool_use')) as any
    const res = events.find((e) => textOf(e).includes('tool_result')) as any
    expect(use.message.content[0]).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } })
    expect(res.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: use.message.content[0].id })
  })

  it('spawna com o KIMI_CODE_HOME do projeto (data root isolado)', async () => {
    process.env.KIMI_FAKE_ECHO_HOME = '1'
    const s = mk(); s.start()
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('x'); await waitFor(() => s.status === 'needs_attention')
    expect(events.some((e) => textOf(e).includes(`home:${kimiHomeFor(PROJ)}`))).toBe(true)
  })

  it('mensagem gigante é rejeitada com result de erro, sem matar a sessão', () => {
    const s = mk(); s.start()
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('a'.repeat(130_000))
    const result = events.find((e) => e.kind === 'result') as any
    expect(result.isError).toBe(true)
    expect(result.resultText).toMatch(/grande demais/)
    expect(s.status).toBe('idle') // continua viva (não foi para working)
  })

  it('crash da CLI (exit != 0 sem saída) → result de erro com stderr + dead', async () => {
    process.env.KIMI_FAKE_CRASH = '1'
    const s = mk(); s.start()
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('x'); await waitFor(() => s.status === 'dead')
    const result = events.find((e) => e.kind === 'result') as any
    expect(result.isError).toBe(true)
    expect(result.resultText).toContain('boom')
  })

  it('stop() encerra e recusa novas mensagens', async () => {
    const s = mk(); s.start(); await s.stop()
    expect(s.status).toBe('stopped')
    expect(() => s.send('x')).toThrow()
  })

  it('interrupt() em turno travado volta para idle', async () => {
    process.env.KIMI_FAKE_HANG = '1'
    const s = mk(); s.start()
    s.send('trava'); await waitFor(() => s.status === 'working')
    await s.interrupt()
    await waitFor(() => s.status === 'idle')
    expect(s.status).toBe('idle')
  })
})
