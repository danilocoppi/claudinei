import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { CodexSession } from '../src/engine/codex/codex-session.js'
import type { AgentEvent, EngineSession } from '../src/engine/types.js'

/**
 * Cópia nativa de ponta a ponta com os fakes (nunca as CLIs reais): o Claude
 * abre a cópia com o id escolhido pelo Claudinei; o Codex pede `thread/fork` e
 * publica o id da cópia na partida. Os fakes não tocam disco.
 */

const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))
const PROJECT = fileURLToPath(new URL('.', import.meta.url))

const sessions: EngineSession[] = []
afterEach(async () => { await Promise.all(sessions.splice(0).map((s) => s.stop())) })
const waitFor = (cond: () => boolean) => expect.poll(cond, { timeout: 5000, interval: 10 }).toBe(true)
const eventsOf = (s: EngineSession) => { const events: AgentEvent[] = []; s.on('event', (e: AgentEvent) => events.push(e)); return events }

describe('Claude: cópia nativa', () => {
  it('ClaudeSession com fake: o init vem com o id escolhido', async () => {
    const s = claudeEngine.createSession({
      projectPath: PROJECT, bin: process.execPath, extraArgsOverride: [FAKE_CLAUDE],
      forkFrom: { sourceId: 'origem', cut: '11111111-2222-4333-8444-555555555555' },
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', readOnly: true, ephemeral: true,
    })
    sessions.push(s)
    const events = eventsOf(s)
    s.start()
    await waitFor(() => events.some((e) => e.kind === 'init'))
    expect(events.find((e) => e.kind === 'init')).toMatchObject({ sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    expect(s.sessionId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })

  it('fake: msg_ no corte morre antes do init com código 1', () => {
    const r = spawnSync(process.execPath, [FAKE_CLAUDE, '--resume', 'origem', '--fork-session', '--resume-session-at', 'msg_01ABC'],
      { input: '', encoding: 'utf8', timeout: 5000 })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('No message found with message.uuid of: msg_01ABC')
    expect(r.stdout).not.toContain('"init"')
  })

  it('fake: uuid no corte segue normal', () => {
    const r = spawnSync(process.execPath, [FAKE_CLAUDE, '--resume-session-at', '11111111-2222-4333-8444-555555555555'],
      { input: '', encoding: 'utf8', timeout: 5000 })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"init"')
  })
})

describe('Codex: cópia nativa', () => {
  const mk = (opts: Record<string, unknown>, args: string[] = []) => {
    const s = new CodexSession({ projectPath: '/tmp', binOverride: process.execPath, extraArgsOverride: [FAKE_CODEX, ...args], ...opts })
    sessions.push(s); return s
  }

  it('CodexSession com forkFrom: o id FORK-… sai na partida, antes de qualquer mensagem, e __fork_params__ ecoa excludeTurns/ephemeral/sandbox', async () => {
    const s = mk({ forkFrom: { sourceId: 'SRC', cut: 'turn-7' }, readOnly: true, ephemeral: true })
    const events = eventsOf(s)
    s.start()
    await waitFor(() => events.some((e) => e.kind === 'init'))
    expect(events.find((e) => e.kind === 'init')).toMatchObject({ sessionId: 'FORK-SRC' })
    expect(s.sessionId).toBe('FORK-SRC')
    await waitFor(() => s.status === 'idle')
    expect(events.some((e) => e.kind === 'result')).toBe(false)

    s.send('__fork_params__')
    await waitFor(() => s.status === 'needs_attention')
    const result = events.find((e) => e.kind === 'result')
    const params = JSON.parse(result!.kind === 'result' ? result!.resultText : '{}')
    expect(params).toMatchObject({
      threadId: 'SRC', lastTurnId: 'turn-7', excludeTurns: true, ephemeral: true, sandbox: 'read-only',
      cwd: '/tmp', approvalPolicy: 'never',
    })
    // A lateral não recebe hermes: sem regra do terminal errado.
    expect(params).not.toHaveProperty('developerInstructions')
  })

  it('ramo do Codex: fork persistente com o sandbox de sempre', async () => {
    const s = mk({ forkFrom: { sourceId: 'SRC' } })
    const events = eventsOf(s)
    s.start()
    await waitFor(() => s.status === 'idle' && s.sessionId === 'FORK-SRC')
    s.send('__fork_params__')
    await waitFor(() => s.status === 'needs_attention')
    const result = events.find((e) => e.kind === 'result')
    const params = JSON.parse(result!.kind === 'result' ? result!.resultText : '{}')
    expect(params).toMatchObject({ threadId: 'SRC', excludeTurns: true, sandbox: 'danger-full-access' })
    expect(params).not.toHaveProperty('ephemeral')
    expect(params).not.toHaveProperty('lastTurnId')
  })

  it('lateral recriada em seed (sem forkFrom): o thread/start continua só leitura', async () => {
    const s = mk({ readOnly: true })
    const events = eventsOf(s)
    s.start()
    s.send('__start_params__')
    await waitFor(() => s.status === 'needs_attention')
    const result = events.find((e) => e.kind === 'result')
    const params = JSON.parse(result!.kind === 'result' ? result!.resultText : '{}')
    expect(params).toMatchObject({ sandbox: 'read-only', cwd: '/tmp', approvalPolicy: 'never' })
  })

  it('sessão comum (sem readOnly): o thread/start mantém o sandbox de sempre', async () => {
    const s = mk({})
    const events = eventsOf(s)
    s.start()
    s.send('__start_params__')
    await waitFor(() => s.status === 'needs_attention')
    const result = events.find((e) => e.kind === 'result')
    const params = JSON.parse(result!.kind === 'result' ? result!.resultText : '{}')
    expect(params).toMatchObject({ sandbox: 'danger-full-access' })
  })

  it('fake: fork efêmero sem excludeTurns é recusado como na CLI real', () => {
    const line = JSON.stringify({ id: 1, method: 'thread/fork', params: { threadId: 'SRC', ephemeral: true } }) + '\n'
    const r = spawnSync(process.execPath, [FAKE_CODEX], { input: line, encoding: 'utf8', timeout: 5000 })
    const reply = JSON.parse(r.stdout.trim().split('\n')[0])
    expect(reply.error).toMatchObject({ code: -32600, message: 'ephemeral paginated thread/fork requires `excludeTurns: true`' })
  })

  it('fork recusado: a sessão morre com o erro da CLI', async () => {
    const s = mk({ forkFrom: { sourceId: 'SRC' } }, ['--fork-refuse'])
    s.start()
    await waitFor(() => s.status === 'dead')
    expect(s.lastStderr).toMatch(/fork/)
  })
})
