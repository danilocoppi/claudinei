import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { codexEngine } from '../src/engine/codex/codex-engine.js'
import { kimiEngine } from '../src/engine/kimi/kimi-engine.js'
import { openCodeEngine } from '../src/engine/opencode/opencode-engine.js'
import { kimiHomeFor } from '../src/engine/kimi/kimi-home.js'

// Nunca os diretórios reais do usuário: tudo aponta para temporários.
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CODE_HOME', 'CLAUDINEI_KIMI_HOMES'] as const
const backup: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    backup[k] = process.env[k]
    process.env[k] = mkdtempSync(join(tmpdir(), `branch-ref-${k.toLowerCase()}-`))
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (backup[k] === undefined) delete process.env[k]; else process.env[k] = backup[k]
  }
})

describe('transcriptRef por motor', () => {
  it('Claude devolve o caminho do .jsonl sob CLAUDE_CONFIG_DIR', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(claudeEngine.transcriptRef!('/home/x/proj', id))
      .toBe(join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-home-x-proj', `${id}.jsonl`))
  })

  it("OpenCode devolve 'opencode export ses_X'", () => {
    expect(openCodeEngine.transcriptRef!('/home/x/proj', 'ses_X')).toBe('opencode export ses_X')
  })

  it('Codex sem rollout devolve null', () => {
    expect(codexEngine.transcriptRef!('/home/x/proj', 'thread-inexistente')).toBeNull()
  })

  it('Codex com rollout devolve o caminho do arquivo', () => {
    const dayDir = join(process.env.CODEX_HOME!, 'sessions', '2026', '11', '20')
    mkdirSync(dayDir, { recursive: true })
    const file = join(dayDir, 'rollout-2026-11-20T10-00-00-thread-abc.jsonl')
    writeFileSync(file, '')
    expect(codexEngine.transcriptRef!('/home/x/proj', 'thread-abc')).toBe(file)
  })

  it('Kimi devolve o wire.jsonl do agente main, ou null sem a sessão', () => {
    const proj = '/home/x/proj-kimi'
    expect(kimiEngine.transcriptRef!(proj, 'sess-1')).toBeNull()
    const home = kimiHomeFor(proj)
    mkdirSync(home, { recursive: true })
    const sessionDir = join(home, 'sessions', 'sess-1')
    writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: 'sess-1', sessionDir, workDir: proj }) + '\n')
    expect(kimiEngine.transcriptRef!(proj, 'sess-1')).toBe(join(sessionDir, 'agents', 'main', 'wire.jsonl'))
  })

  it('capabilities().fork de cada motor', () => {
    expect(claudeEngine.capabilities().fork).toBe('native')
    expect(codexEngine.capabilities().fork).toBe('native')
    expect(kimiEngine.capabilities().fork).toBe('seed')
    expect(openCodeEngine.capabilities().fork).toBe('native')
  })
})
