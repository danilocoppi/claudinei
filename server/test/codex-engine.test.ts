import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
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

  describe('terminalCommand', () => {
    const CLI = fileURLToPath(new URL('./fake-codex-cli.mjs', import.meta.url))
    afterEach(() => { delete process.env.FAKE_CODEX_CLI_ANTIGA })

    // O daemon da CLI segura a conversa por 60 s depois que o terminal fecha, e
    // o chat que volta a retomá-la leva "already has an active writer".
    it('retoma sem o daemon compartilhado quando a CLI aceita', () => {
      expect(codexEngine.terminalCommand({ resumeSessionId: 'T1', projectPath: '/tmp', bin: CLI }))
        .toEqual({ file: CLI, args: ['resume', 'T1', '--dangerously-bypass-approvals-and-sandbox', '--no-daemon'] })
    })

    it('sessão nova (sem id) também sai sem o daemon, e sem resume', () => {
      expect(codexEngine.terminalCommand({ projectPath: '/tmp', bin: CLI }))
        .toEqual({ file: CLI, args: ['--dangerously-bypass-approvals-and-sandbox', '--no-daemon'] })
    })

    it('CLI anterior à opção recebe o comando de antes — opção desconhecida impediria o terminal de abrir', () => {
      process.env.FAKE_CODEX_CLI_ANTIGA = '1'
      expect(codexEngine.terminalCommand({ resumeSessionId: 'T1', projectPath: '/tmp', bin: CLI }))
        .toEqual({ file: CLI, args: ['resume', 'T1', '--dangerously-bypass-approvals-and-sandbox'] })
      expect(codexEngine.terminalCommand({ projectPath: '/tmp', bin: CLI }))
        .toEqual({ file: CLI, args: ['--dangerously-bypass-approvals-and-sandbox'] })
    })

    it('CLI que não responde à ajuda também recebe o comando de antes', () => {
      const ausente = `/nao/existe/codex-${Date.now()}`
      expect(codexEngine.terminalCommand({ resumeSessionId: 'T1', projectPath: '/tmp', bin: ausente }))
        .toEqual({ file: ausente, args: ['resume', 'T1', '--dangerously-bypass-approvals-and-sandbox'] })
    })
  })

  it('capabilities: efforts do codex, sem permissions, slash curated', () => {
    const c = codexEngine.capabilities()
    expect(c.efforts).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(c.permissions).toEqual([])
    expect(c.slashSource).toBe('curated')
    expect(c.models.length).toBeGreaterThan(0)
  })

  it('readHistory sem rollout → []', async () => {
    await expect(codexEngine.readHistory('/nao/existe', 'THREAD-NADA')).resolves.toEqual([])
  })
})
