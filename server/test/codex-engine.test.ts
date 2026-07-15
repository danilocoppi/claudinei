import { describe, it, expect } from 'vitest'
import { codexEngine } from '../src/engine/codex/codex-engine.js'
import { getEngine, hasEngine } from '../src/engine/index.js'
import { CodexSession } from '../src/engine/codex/codex-session.js'

describe('codexEngine', () => {
  it('registrado com id codex', () => {
    expect(hasEngine('codex')).toBe(true)
    expect(getEngine('codex')).toBe(codexEngine)
  })

  it('createSession → CodexSession sem spawnar', () => {
    const s = codexEngine.createSession({ projectPath: '/tmp' })
    expect(s).toBeInstanceOf(CodexSession)
    expect(s.status).toBe('starting')
  })

  it('terminalCommand → codex resume <id> --dangerously-bypass-approvals-and-sandbox', () => {
    expect(codexEngine.terminalCommand({ resumeSessionId: 'T1', projectPath: '/tmp', bin: 'codex' }))
      .toEqual({ file: 'codex', args: ['resume', 'T1', '--dangerously-bypass-approvals-and-sandbox'] })
  })

  it('terminalCommand SEM id → sessão nova (fresh), sem resume', () => {
    expect(codexEngine.terminalCommand({ projectPath: '/tmp', bin: 'codex' }))
      .toEqual({ file: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'] })
  })

  it('capabilities: efforts do codex, sem permissions, slash curated', () => {
    const c = codexEngine.capabilities()
    expect(c.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(c.permissions).toEqual([])
    expect(c.slashSource).toBe('curated')
    expect(c.models.length).toBeGreaterThan(0)
  })

  it('readHistory sem rollout → []', () => {
    expect(codexEngine.readHistory('/nao/existe', 'THREAD-NADA')).toEqual([])
  })
})
