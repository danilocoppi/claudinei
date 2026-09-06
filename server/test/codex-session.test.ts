import { describe, it, expect, afterEach } from 'vitest'
import { CodexSession } from '../src/engine/codex/codex-session.js'
import type { AgentEvent } from '../src/engine/types.js'
import { fileURLToPath } from 'node:url'

const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))
const sessions: CodexSession[] = []
const mk = (opts: any = {}, args: string[] = []) => {
  const s = new CodexSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE, ...args], ...opts })
  sessions.push(s); return s
}
const waitFor = (cond: () => boolean) => expect.poll(cond, { timeout: 5000, interval: 10 }).toBe(true)
afterEach(async () => { await Promise.all(sessions.splice(0).map((s) => s.stop())) })
const eventsOf = (s: CodexSession) => { const events: AgentEvent[] = []; s.on('event', (e) => events.push(e)); return events }

describe('CodexSession (App Server)', () => {
  it('fresh é lazy; vários turnos mantêm thread e uma única inicialização', async () => {
    const s = mk(); const events = eventsOf(s); s.start()
    expect(s.status).toBe('idle'); expect(s.sessionId).toBeUndefined()
    for (const text of ['one', 'two']) {
      s.send(text); expect(s.status).toBe('working')
      await waitFor(() => s.status === 'needs_attention')
    }
    expect(s.sessionId).toBe('THREAD-FAKE')
    expect(events.filter((e) => e.kind === 'init')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'result').map((e) => e.resultText)).toEqual(['echo:one', 'echo:two'])
    expect(events.filter((e) => e.kind === 'result').map((e) => e.tokens?.total)).toEqual([120000, 120000])
    expect(events.filter((e) => e.kind === 'context').map((e) => e.contextWindow)).toEqual([400000, 400000])
  })
  it('resume restaura contexto sem enviar mensagem e não contabiliza tokens antigos', async () => {
    const s = mk({ resumeSessionId: 'OLD' }); const events = eventsOf(s); s.start()
    await waitFor(() => s.status === 'idle')
    expect(s.sessionId).toBe('OLD')
    await waitFor(() => events.some((e) => e.kind === 'context'))
    expect(events.find((e) => e.kind === 'context')).toMatchObject({ contextTokens: 120000, contextWindow: 400000 })
    expect(events.some((e) => e.kind === 'result')).toBe(false)
    s.send('oi'); await waitFor(() => s.status === 'needs_attention')
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ tokens: { total: 120000 } })
  })
  it('compactar usa RPC, publica duração/fronteira e aceita nova mensagem', async () => {
    const s = mk(); const events = eventsOf(s); s.start(); s.send('oi')
    await waitFor(() => s.status === 'needs_attention')
    s.send('/compact')
    await waitFor(() => !!s.compactingSince)
    expect(s.status).toBe('working')
    expect(() => s.compact()).toThrow()
    await waitFor(() => s.status === 'needs_attention')
    expect(s.compactingSince).toBeUndefined()
    expect(events.filter((e) => e.kind === 'system')).toEqual([expect.objectContaining({ subtype: 'compact_boundary', raw: { compact_metadata: { pre_tokens: 120000 } } })])
    expect(events.filter((e) => e.kind === 'result').at(-1)).toMatchObject({ subtype: 'compact', resultText: '' })
    expect(events.filter((e) => e.kind === 'context').at(-1)).toMatchObject({ contextTokens: 30000 })
    s.send('depois'); await waitFor(() => s.status === 'needs_attention')
    expect(events.filter((e) => e.kind === 'result').at(-1)).toMatchObject({ resultText: 'echo:depois' })
  })
  it('interromper compactação limpa indicador e preserva a thread', async () => {
    const s = mk({ resumeSessionId: 'OLD' }, ['--hang-compact']); s.start()
    await waitFor(() => s.status === 'idle'); s.compact()
    await waitFor(() => !!s.compactingSince); await s.interrupt()
    await waitFor(() => s.status === 'idle')
    expect(s.compactingSince).toBeUndefined(); expect(s.sessionId).toBe('OLD')
    s.send('ok'); await waitFor(() => s.status === 'needs_attention')
  })
  it('interrupt cancela turno via protocolo e mantém a sessão utilizável', async () => {
    const s = mk(); s.start(); s.send('__hang__')
    await waitFor(() => !!s.sessionId)
    await s.interrupt(); await waitFor(() => s.status === 'idle')
    s.send('ok'); await waitFor(() => s.status === 'needs_attention')
  })
  it('interrupção durante o arranque não deixa turno órfão', async () => {
    const s = mk(); s.start(); s.send('__hang__'); await s.interrupt()
    await waitFor(() => s.status === 'idle')
    s.send('ok'); await waitFor(() => s.status === 'needs_attention')
  })
  it('model/effort são repassados e voltar ao padrão usa a configuração da CLI', async () => {
    const s = mk(); const events = eventsOf(s); s.start()
    await s.setModel('chosen'); await s.setEffort('high')
    s.send('__options__'); await waitFor(() => s.status === 'needs_attention')
    expect(events.filter((e) => e.kind === 'result').at(-1)?.resultText).toBe('{"model":"chosen","effort":"high"}')
    await s.setModel(''); await s.setEffort('')
    expect(events.filter((e) => e.kind === 'context').at(-1)).toMatchObject({ contextTokens: undefined, contextWindow: undefined })
    s.send('__options__'); await waitFor(() => s.status === 'needs_attention')
    expect(events.filter((e) => e.kind === 'result').at(-1)?.resultText).toBe('{"model":"default-model","effort":"medium"}')
  })
  it('falha de turno é exibida; próximo turno funciona', async () => {
    const s = mk(); const events = eventsOf(s); s.start(); s.send('__fail__')
    await waitFor(() => s.status === 'needs_attention')
    expect(events.filter((e) => e.kind === 'result').at(-1)).toMatchObject({ isError: true, resultText: 'test turn failed' })
    s.send('ok'); await waitFor(() => s.status === 'needs_attention')
  })
  it('queda do App Server encerra waiters com erro', async () => {
    const s = mk(); const events = eventsOf(s); s.start(); s.send('__crash__')
    await waitFor(() => s.status === 'dead')
    expect(events.some((e) => e.kind === 'result' && e.isError)).toBe(true)
  })
  it('stop encerra o processo e recusa novas mensagens', async () => {
    const s = mk(); s.start(); s.send('__hang__')
    await waitFor(() => !!s.sessionId); await s.stop()
    expect(s.status).toBe('stopped'); expect(() => s.send('x')).toThrow()
  })
  it('binário ausente produz erro claro', async () => {
    const s = mk({ binOverride: '/nao/existe/codex' }); s.start(); s.send('oi')
    await waitFor(() => s.status === 'dead')
    expect(s.lastStderr).toContain('não encontrado no PATH')
  })
})

describe('compactação: diferenças de ordem e falhas do protocolo', () => {
  it('preserva a nova medição quando chega antes de item/completed (CLI real)', async () => {
    const s = mk({ resumeSessionId: 'OLD' }, ['--usage-before-complete'])
    const events = eventsOf(s); s.start(); await waitFor(() => s.status === 'idle')
    s.compact(); await waitFor(() => s.status === 'needs_attention')
    expect(events.filter((e) => e.kind === 'context').at(-1)).toMatchObject({ contextTokens: 30000, contextWindow: 400000 })
  })
  it('rejeição da compactação chega como erro e não inutiliza a conversa', async () => {
    const s = mk({ resumeSessionId: 'OLD' }, ['--compact-error'])
    const events = eventsOf(s); s.start(); await waitFor(() => s.status === 'idle')
    s.compact(); await waitFor(() => s.status === 'needs_attention')
    expect(s.compactingSince).toBeUndefined()
    expect(events.filter((e) => e.kind === 'result').at(-1)).toMatchObject({ isError: true, resultText: 'compaction unavailable' })
    s.send('ok'); await waitFor(() => s.status === 'needs_attention')
  })
})

describe('mensagens enviadas durante o trabalho', () => {
  it('adendo durante o arranque entra no turno assim que ele existe', async () => {
    const s = mk(); const events = eventsOf(s); s.start()
    s.send('__wait_for_steer__')
    expect(() => s.send('correção')).not.toThrow()
    await waitFor(() => s.status === 'needs_attention')
    expect(events.filter((e) => e.kind === 'result').map((e) => e.resultText)).toEqual(['["correção"]'])
  })

  it('entrega vários adendos na ordem, sem iniciar outro turno nem duplicar ecos', async () => {
    const s = mk(); const events = eventsOf(s); s.start(); s.send('__wait_for_steer__')
    await waitFor(() => !!s.sessionId)
    s.send('first', { echoToClients: true }); s.send('last', { echoToClients: true })
    await waitFor(() => s.status === 'needs_attention')
    expect(events.filter((e) => e.kind === 'result').map((e) => e.resultText)).toEqual(['["first","last"]'])
    expect(events.filter((e) => e.kind === 'user')).toHaveLength(2)
  })

  it.each(['--reject-steer-race', '--reject-steer'])('rejeição explícita %s preserva o adendo para o próximo turno', async (flag) => {
    const s = mk({}, [flag]); const events = eventsOf(s); s.start(); s.send('__wait_for_steer__')
    s.send('depois')
    await waitFor(() => events.filter((e) => e.kind === 'result').length === 2)
    expect(events.filter((e) => e.kind === 'result').at(-1)?.resultText).toBe('echo:depois')
  })

  it('conclusão antes do ACK não reenvia mensagem já aceita', async () => {
    const s = mk({}, ['--delayed-steer-ack']); const events = eventsOf(s)
    s.start(); s.send('__wait_for_steer__'); s.send('aceita')
    await waitFor(() => s.status === 'needs_attention')
    // O envio seguinte espera o ACK anterior, mantendo a ordem mesmo entre turnos.
    s.send('seguinte')
    await waitFor(() => events.filter((e) => e.kind === 'result').length === 2)
    expect(events.filter((e) => e.kind === 'result').map((e) => e.resultText)).toEqual(['["aceita"]', 'echo:seguinte'])
  })

  it('durante compactação aguarda e inicia o turno seguinte com a mensagem', async () => {
    const s = mk({ resumeSessionId: 'OLD' }); const events = eventsOf(s); s.start()
    await waitFor(() => s.status === 'idle'); s.compact(); s.send('após compactar')
    await waitFor(() => events.filter((e) => e.kind === 'result').length === 2)
    expect(events.filter((e) => e.kind === 'result').at(-1)?.resultText).toBe('echo:após compactar')
  })

  it('queda com adendo pendente avisa explicitamente e não tenta reenviar', async () => {
    const s = mk({}, ['--crash-steer']); const events = eventsOf(s); s.start()
    s.send('__wait_for_steer__'); s.send('não pode sumir')
    await waitFor(() => s.status === 'dead')
    expect(events.some((e) => e.kind === 'system' && e.subtype === 'message_error' && JSON.stringify(e.raw).includes('não pode sumir'))).toBe(true)
  })

  it('interromper cancela a fila sem iniciar trabalho depois do stop', async () => {
    const s = mk({ resumeSessionId: 'OLD' }, ['--hang-compact']); const events = eventsOf(s); s.start()
    await waitFor(() => s.status === 'idle'); s.compact(); s.send('pendente')
    await waitFor(() => !!s.compactingSince); await s.interrupt()
    await waitFor(() => s.status === 'idle')
    expect(events.some((e) => e.kind === 'system' && e.subtype === 'message_error' && JSON.stringify(e.raw).includes('pendente'))).toBe(true)
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(1)
  })
})
