import { describe, it, expect } from 'vitest'
import { ClaudeSession, buildClaudeArgs, type SessionStatus } from '../src/claude/session.js'
import type { ClaudeEvent } from '../src/claude/events.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

function makeSession() {
  return new ClaudeSession({ projectPath: __dirname, claudeBin: process.execPath, extraArgsOverride: [FAKE] })
}

function waitFor(s: ClaudeSession, status: SessionStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    if (s.status === status) return resolve()
    const timer = setTimeout(() => {
      s.off('status', onStatus)
      reject(new Error(`timeout aguardando status "${status}" (atual: "${s.status}")`))
    }, 5_000)
    const onStatus = (st: SessionStatus) => {
      if (st === status) {
        clearTimeout(timer)
        s.off('status', onStatus)
        resolve()
      }
    }
    s.on('status', onStatus)
  })
}

describe('buildClaudeArgs', () => {
  it('padrão: --dangerously-skip-permissions e sem --continue', () => {
    // Nota (Task 1 - hot-swap via control_request): o launch agora sempre usa
    // --dangerously-skip-permissions; --permission-mode não é mais passado
    // (o modo inicial é aplicado via control_request pós-init, se necessário).
    const args = buildClaudeArgs({})
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--continue')
  })

  it('continueLatest:true (sem resume) → inclui --continue', () => {
    const args = buildClaudeArgs({ continueLatest: true })
    expect(args).toContain('--continue')
  })

  it('resumeSessionId presente + continueLatest:true → --resume vence, sem --continue', () => {
    const args = buildClaudeArgs({ continueLatest: true, resumeSessionId: 'x' })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('x')
    expect(args).not.toContain('--continue')
  })

  it('inclui --include-partial-messages para habilitar streaming de deltas', () => {
    const args = buildClaudeArgs({})
    expect(args).toContain('--include-partial-messages')
  })

  it('sem hermes → não inclui --mcp-config', () => {
    const args = buildClaudeArgs({})
    expect(args).not.toContain('--mcp-config')
  })

  it('com hermes → inclui --mcp-config com command, args, projectId e apiUrl', () => {
    const args = buildClaudeArgs({ hermes: { command: 'node', args: ['/x/hermes.mjs'], apiUrl: 'http://h', projectId: 7 } })
    expect(args).toContain('--mcp-config')
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(cfg.mcpServers.hermes.command).toBe('node')
    expect(cfg.mcpServers.hermes.args).toEqual(['/x/hermes.mjs'])
    expect(cfg.mcpServers.hermes.env.CLAUDINEI_PROJECT_ID).toBe('7')
    expect(cfg.mcpServers.hermes.env.CLAUDINEI_API).toBe('http://h')
  })

  it('com hermes.command/args do binário empacotado → repassa direto (sem hardcode "node")', () => {
    const args = buildClaudeArgs({ hermes: { command: '/opt/claudinei-linux-x64', args: ['--hermes'], apiUrl: 'http://h', projectId: 1 } })
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(cfg.mcpServers.hermes.command).toBe('/opt/claudinei-linux-x64')
    expect(cfg.mcpServers.hermes.args).toEqual(['--hermes'])
  })

  it('model:"opus" → inclui --model opus', () => {
    const args = buildClaudeArgs({ model: 'opus' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
  })

  it('sem model → não inclui --model', () => {
    const args = buildClaudeArgs({})
    expect(args).not.toContain('--model')
  })

  it('model vazio → não inclui --model', () => {
    const args = buildClaudeArgs({ model: '' })
    expect(args).not.toContain('--model')
  })

  it('effort:"max" → inclui --effort max', () => {
    const args = buildClaudeArgs({ effort: 'max' })
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
  })

  it('sem effort → não inclui --effort', () => {
    expect(buildClaudeArgs({})).not.toContain('--effort')
  })
})

describe('ClaudeSession', () => {
  it('fluxo completo: init→idle, send→working, result→needs_attention, markRead→idle', async () => {
    const s = makeSession()
    const statuses: SessionStatus[] = []
    const events: ClaudeEvent[] = []
    s.on('status', (st) => statuses.push(st))
    s.on('event', (e) => events.push(e))
    s.start()
    await waitFor(s, 'idle')
    expect(s.sessionId).toBe('fake-session-0001')

    s.send('olá')
    expect(s.status).toBe('working')
    await waitFor(s, 'needs_attention')
    expect(events.some((e) => e.kind === 'assistant')).toBe(true)
    expect(events.some((e) => e.kind === 'result')).toBe(true)

    s.markRead()
    expect(s.status).toBe('idle')
    await s.stop()
    expect(s.status).toBe('stopped')
  })

  it('send durante working NÃO lança (adendo entra no turno atual) e mantém working', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('a')
    expect(s.status).toBe('working')
    expect(() => s.send('adendo no meio do turno')).not.toThrow()
    expect(s.status).toBe('working')
    await s.stop()
  })

  it('send após stop continua lançando', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    await s.stop()
    expect(() => s.send('x')).toThrow(/stopped/)
  })

  it('morte inesperada do processo → dead', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('crash')
    await waitFor(s, 'dead')
    expect(s.status).toBe('dead')
  })

  it('stop gracioso → stopped (não dead)', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    await s.stop()
    expect(s.status).toBe('stopped')
  })

  it('start duas vezes lança erro', async () => {
    const s = makeSession()
    s.start()
    expect(() => s.start()).toThrow(/já iniciada/)
    await waitFor(s, 'idle')
    await s.stop()
  })

  it('estado terminal não regride: eventos tardios após dead são ignorados no status', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('crash')
    await waitFor(s, 'dead')
    // simula linha tardia chegando depois do close
    ;(s as any).handleEvent({ kind: 'result', subtype: 'success', isError: false, resultText: 'x', costUsd: 0, raw: {} })
    expect(s.status).toBe('dead')
  })

  it('interrupt durante working aborta o turno: result de erro → needs_attention', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('tarefa demorada')
    expect(s.status).toBe('working')
    await s.interrupt()
    await waitFor(s, 'needs_attention')
    await s.stop()
  })

  it('spawna claude com PKG_EXECPATH=\'\' no env (regressão: evita que o pkg trate --mcp-config/args como caminho de arquivo — ver comentário em session.ts)', async () => {
    const s = makeSession()
    const events: ClaudeEvent[] = []
    s.on('event', (e) => events.push(e))
    s.start()
    await waitFor(s, 'idle')
    const init = events.find((e) => e.kind === 'init') as { raw: { pkgExecPath: unknown } } | undefined
    expect(init?.raw.pkgExecPath).toBe('')
    await s.stop()
  })

  it('interrupt fora de working é no-op silencioso', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    await expect(s.interrupt()).resolves.toBeUndefined()
    expect(s.status).toBe('idle')
    await s.stop()
  })

  it('setModel continua rejeitando durante working (allowWorking é só do interrupt)', async () => {
    const s = makeSession()
    s.start()
    await waitFor(s, 'idle')
    s.send('tarefa demorada')
    await expect(s.setModel('opus')).rejects.toThrow(/working/)
    await s.interrupt()
    await waitFor(s, 'needs_attention')
    await s.stop()
  })
})

describe('binário ausente (engine não instalada)', () => {
  it('start com claudeBin inexistente → dead com mensagem clara', async () => {
    const s = new ClaudeSession({ projectPath: __dirname, claudeBin: '/nao/existe/claude' })
    s.start()
    await new Promise<void>((res, rej) => {
      const t0 = Date.now()
      const i = setInterval(() => {
        if (s.status === 'dead') { clearInterval(i); res() }
        else if (Date.now() - t0 > 4000) { clearInterval(i); rej(new Error('timeout')) }
      }, 10)
    })
    expect(s.lastStderr).toContain('não encontrado no PATH')
    expect(s.lastStderr).toContain('@anthropic-ai/claude-code')
  })
})

describe('hermes com engine (marca quem despacha nas tasks)', () => {
  it('CLAUDINEI_ENGINE entra no env do mcp-config', () => {
    const args = buildClaudeArgs({ hermes: { command: 'node', args: ['/x/h.mjs'], apiUrl: 'http://h', projectId: 7, engine: 'claude' } })
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect(cfg.mcpServers.hermes.env.CLAUDINEI_ENGINE).toBe('claude')
  })
})
