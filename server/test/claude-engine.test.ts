import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { encodeCwd } from '../src/history.js'
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

  // A engine repassa o exclude: é o que impede um terminal de retomar a conversa
  // do outro terminal da MESMA pasta.
  it('latestConversationId descarta os ids excluídos', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'cfg-eng-'))
    const proj = '/tmp/proj-claude-engine'
    const dir = join(cfg, 'projects', encodeCwd(proj))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'minha.jsonl'), '{}')
    writeFileSync(join(dir, 'alheia.jsonl'), '{}')
    utimesSync(join(dir, 'minha.jsonl'), new Date(1000000), new Date(1000000))
    utimesSync(join(dir, 'alheia.jsonl'), new Date(2000000), new Date(2000000))
    const antes = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      expect(claudeEngine.latestConversationId(proj)).toBe('alheia')
      expect(claudeEngine.latestConversationId(proj, new Set(['alheia']))).toBe('minha')
    } finally {
      if (antes === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = antes
    }
  })
})
