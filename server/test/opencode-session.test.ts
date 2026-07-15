import { describe, it, expect, afterEach } from 'vitest'
import { OpenCodeSession } from '../src/engine/opencode/opencode-session.js'
import type { AgentEvent } from '../src/engine/types.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-opencode.mjs')
const mk = () => new OpenCodeSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE] })
const waitFor = (c: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now(); const i = setInterval(() => { if (c()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) } }, 10)
})

describe('OpenCodeSession (turn-based)', () => {
  it('start() não spawna; idle', () => { const s = mk(); s.start(); expect(s.status).toBe('idle') })

  it('send() roda um turno: init(sessionId)+assistant+result; needs_attention', async () => {
    const s = mk(); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('hello'); expect(s.status).toBe('working')
    await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('ses_FAKE')
    expect(evs.some((e) => e.kind === 'init')).toBe(true)
    expect(evs.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('echo:hello'))).toBe(true)
    const result = evs.find((e) => e.kind === 'result') as any
    expect(result?.tokens?.total).toBe(5)
  })

  it('2º send usa -s <id> (resume) e mantém a sessão', async () => {
    const s = mk(); s.start()
    s.send('one'); await waitFor(() => s.status === 'needs_attention')
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('two'); await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('ses_FAKE')
  })

  it('stop() encerra e recusa novas mensagens', async () => {
    const s = mk(); s.start(); await s.stop()
    expect(s.status).toBe('stopped'); expect(() => s.send('x')).toThrow()
  })

  describe('interrupt() em turno travado', () => {
    afterEach(() => { delete process.env.OPENCODE_FAKE_HANG })

    it('cancela o turno sem matar a sessão: volta a idle, preserva sessionId, aceita novo send sem zumbi', async () => {
      const s = new OpenCodeSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE] })
      process.env.OPENCODE_FAKE_HANG = '1'
      s.start(); s.send('go'); await waitFor(() => s.status === 'working' && !!s.sessionId)

      await s.interrupt(); await waitFor(() => s.status === 'idle')
      expect(s.sessionId).toBe('ses_FAKE')

      // delete ANTES do send de recuperação: o novo processo não pode herdar o hang
      // (send() captura process.env no spawn) — senão fica zumbi.
      delete process.env.OPENCODE_FAKE_HANG
      expect(() => s.send('again')).not.toThrow()
      await waitFor(() => s.status === 'needs_attention')
      expect(s.sessionId).toBe('ses_FAKE')
    })

    it('não emite um evento result durante o interrupt', async () => {
      const s = new OpenCodeSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE] })
      process.env.OPENCODE_FAKE_HANG = '1'
      const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
      s.start(); s.send('go'); await waitFor(() => s.status === 'working' && !!s.sessionId)

      await s.interrupt(); await waitFor(() => s.status === 'idle')

      expect(evs.some((e) => e.kind === 'result')).toBe(false)
      delete process.env.OPENCODE_FAKE_HANG
    })
  })

  it('injeta o MCP hermes via OPENCODE_CONFIG_CONTENT quando a sessão recebe opts.hermes', async () => {
    const s = new OpenCodeSession({
      projectPath: '/tmp',
      binOverride: process.execPath,
      extraArgsOverride: [FAKE],
      hermes: { command: 'node', args: ['/h.mjs', '--hermes'], apiUrl: 'http://127.0.0.1:9105', projectId: 1, serviceToken: 'TK' },
    })
    s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('oi')
    await waitFor(() => s.status === 'needs_attention')
    // o fake ecoa 'hermes:on' só se OPENCODE_CONFIG_CONTENT com hermes chegou no env
    expect(evs.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('hermes:on'))).toBe(true)
  })

  it('sem opts.hermes NÃO injeta OPENCODE_CONFIG_CONTENT', async () => {
    const s = mk(); s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('oi')
    await waitFor(() => s.status === 'needs_attention')
    expect(evs.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('hermes:on'))).toBe(false)
  })

  describe('crash real (exit != 0 sem JSON de erro)', () => {
    afterEach(() => { delete process.env.OPENCODE_FAKE_CRASH })

    it('vira dead, não "turno vazio bem-sucedido"', async () => {
      const s = mk(); s.start()
      process.env.OPENCODE_FAKE_CRASH = '1'
      s.send('go')
      await waitFor(() => s.status === 'dead')
      expect(s.status).toBe('dead')
    })

    it('não emite result com isError:false (sucesso falso) — se emitir result, é isError:true', async () => {
      const s = mk(); s.start()
      const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
      process.env.OPENCODE_FAKE_CRASH = '1'
      s.send('go')
      await waitFor(() => s.status === 'dead')
      const results = evs.filter((e) => e.kind === 'result') as any[]
      expect(results.some((r) => r.isError === false)).toBe(false)
      for (const r of results) expect(r.isError).toBe(true)
    })
  })

  describe('erro explícito (linha type:error + exit != 0)', () => {
    afterEach(() => { delete process.env.OPENCODE_FAKE_ERROR })

    it('preserva a mensagem real do parser em vez da genérica; vira dead', async () => {
      const s = mk(); s.start()
      const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
      process.env.OPENCODE_FAKE_ERROR = '1'
      s.send('go')
      await waitFor(() => s.status === 'dead')
      const result = evs.find((e) => e.kind === 'result') as any
      expect(result?.isError).toBe(true)
      expect(result?.resultText).toContain('rate limit exceeded')
    })
  })
})

describe('binário ausente (engine não instalada)', () => {
  it('send com bin inexistente → dead; result de erro explica a causa', async () => {
    const s = new OpenCodeSession({ projectPath: '/tmp', binOverride: '/nao/existe/opencode' })
    s.start()
    const evs: AgentEvent[] = []; s.on('event', (e) => evs.push(e))
    s.send('oi')
    await waitFor(() => s.status === 'dead')
    expect(s.lastStderr).toContain('não encontrado no PATH')
    const result = evs.find((e) => e.kind === 'result') as any
    expect(result?.isError).toBe(true)
    expect(result?.resultText).toContain('não encontrado no PATH')
  })
})
