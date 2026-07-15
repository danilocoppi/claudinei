import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CodexSession } from '../src/engine/codex/codex-session.js'
import type { AgentEvent } from '../src/engine/types.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-codex.mjs')

const mk = () => new CodexSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE] })
const waitFor = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now(); const i = setInterval(() => { if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) } }, 10)
})

describe('CodexSession (turn-based)', () => {
  it('start() não spawna; status idle', () => {
    const s = mk(); s.start()
    expect(s.status).toBe('idle')
  })

  it('send() roda um turno: init(sessionId) + assistant + result; volta a needs_attention', async () => {
    const s = mk(); s.start()
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('hello')
    expect(s.status).toBe('working')
    await waitFor(() => s.status === 'needs_attention')
    expect(s.sessionId).toBe('THREAD-FAKE')
    expect(events.some((e) => e.kind === 'init')).toBe(true)
    expect(events.some((e) => e.kind === 'assistant' && JSON.stringify((e as any).message).includes('echo:hello'))).toBe(true)
    expect(events.some((e) => e.kind === 'result')).toBe(true)
  })

  it('2º send usa resume (não re-emite init) e mantém o thread', async () => {
    const s = mk(); s.start()
    s.send('one'); await waitFor(() => s.status === 'needs_attention')
    const events: AgentEvent[] = []
    s.on('event', (e) => events.push(e))
    s.send('two'); await waitFor(() => s.status === 'needs_attention')
    expect(events.some((e) => e.kind === 'init')).toBe(false) // resume não re-inicia
    expect(s.sessionId).toBe('THREAD-FAKE')
  })

  it('stop() encerra e recusa novas mensagens', async () => {
    const s = mk(); s.start(); await s.stop()
    expect(s.status).toBe('stopped')
    expect(() => s.send('x')).toThrow()
  })

  it('setEffort afeta o argv do próximo turno', async () => {
    const s = mk(); s.start()
    await s.setEffort('high')
    // não há como inspecionar argv sem spawnar; valida via ausência de erro + próximo send funciona
    s.send('x'); await waitFor(() => s.status === 'needs_attention')
    // (a checagem real do -c model_reasoning_effort fica no smoke; aqui só garante que setEffort não quebra o fluxo)
    expect(s.status).toBe('needs_attention')
  })

  describe('interrupt() em turno travado', () => {
    afterEach(() => { delete process.env.CODEX_FAKE_HANG })

    it('cancela o turno sem matar a sessão: volta a idle, preserva sessionId, aceita novo send', async () => {
      process.env.CODEX_FAKE_HANG = '1'
      const s = mk(); s.start()
      s.send('go')
      expect(s.status).toBe('working')
      await waitFor(() => s.status === 'working' && !!s.sessionId)
      expect(s.sessionId).toBe('THREAD-FAKE')

      await s.interrupt()
      await waitFor(() => s.status !== 'working')
      expect(s.status).toBe('idle')
      expect(s.status).not.toBe('dead')
      expect(s.sessionId).toBe('THREAD-FAKE')

      // não deixa processo zumbi: um novo turno (sem hang) deve completar normalmente
      delete process.env.CODEX_FAKE_HANG
      expect(() => s.send('two')).not.toThrow()
      await waitFor(() => s.status === 'needs_attention')
      expect(s.sessionId).toBe('THREAD-FAKE')
    })
  })
})

describe('binário ausente (engine não instalada)', () => {
  it('send com bin inexistente → dead com mensagem clara (não o genérico)', async () => {
    const s = new CodexSession({ projectPath: '/tmp', binOverride: '/nao/existe/codex' })
    s.start(); s.send('oi')
    await waitFor(() => s.status === 'dead')
    expect(s.lastStderr).toContain('não encontrado no PATH')
    expect(s.lastStderr).toContain('@openai/codex')
  })
})
