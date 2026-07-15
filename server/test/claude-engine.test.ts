import { describe, it, expect } from 'vitest'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { getEngine, hasEngine } from '../src/engine/index.js'

describe('claudeEngine', () => {
  it('é registrado pelo bootstrap com id claude', () => {
    expect(hasEngine('claude')).toBe(true)
    expect(getEngine('claude')).toBe(claudeEngine)
  })

  it('createSession devolve um EngineSession (surface completa) sem spawnar', () => {
    const s = claudeEngine.createSession({ projectPath: '/tmp' })
    for (const m of ['start', 'send', 'markRead', 'interrupt', 'setModel', 'setPermissionMode', 'stop']) {
      expect(typeof (s as any)[m]).toBe('function')
    }
    expect(s.status).toBe('starting')
    expect(typeof s.lastStderr).toBe('string')
    expect(typeof (s as any).on).toBe('function') // EventEmitter
  })

  it('terminalCommand devolve claude --resume <id> --dangerously-skip-permissions', () => {
    expect(claudeEngine.terminalCommand({ resumeSessionId: 'abc', projectPath: '/tmp', bin: 'claude' }))
      .toEqual({ file: 'claude', args: ['--resume', 'abc', '--dangerously-skip-permissions'] })
  })

  it('terminalCommand SEM id → sessão nova (fresh), sem --resume', () => {
    expect(claudeEngine.terminalCommand({ projectPath: '/tmp', bin: 'claude' }))
      .toEqual({ file: 'claude', args: ['--dangerously-skip-permissions'] })
  })

  it('capabilities traz as listas do Claude', () => {
    const c = claudeEngine.capabilities()
    expect(c.models).toContain('fable')
    expect(c.efforts).toContain('ultracode')
    expect(c.permissions).toContain('bypassPermissions')
    expect(c.slashSource).toBe('protocol')
  })

  it('latestConversationId inexistente devolve null', () => {
    expect(claudeEngine.latestConversationId('/nao/existe/xyz')).toBeNull()
  })
})
