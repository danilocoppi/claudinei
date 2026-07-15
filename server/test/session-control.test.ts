import { describe, it, expect, afterEach } from 'vitest'
import { ClaudeSession, buildClaudeArgs } from '../src/claude/session.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const mk = (opts = {}) => new ClaudeSession({
  projectPath: mkdtempSync(join(tmpdir(), 'tm-')),
  claudeBin: process.execPath, extraArgsOverride: [FAKE], controlTimeoutMs: 400, ...opts,
})
const waitUntil = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)) }
}
let live: ClaudeSession[] = []
afterEach(async () => { for (const s of live) await s.stop(); live = [] })
const start = (opts = {}) => { const s = mk(opts); live.push(s); s.start(); return s }

describe('buildClaudeArgs', () => {
  it('sempre usa --dangerously-skip-permissions e nunca --permission-mode', () => {
    const args = buildClaudeArgs({})
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--permission-mode')
  })
})

describe('ClaudeSession control_request', () => {
  it('setModel resolve no control_response de sucesso', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setModel('haiku')).resolves.toBeUndefined()
  })

  it('setPermissionMode resolve no sucesso', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('plan')).resolves.toBeUndefined()
  })

  it('control com error rejeita com a mensagem', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('fail-test' as any)).rejects.toThrow(/inválido/)
  })

  it('sem resposta dentro do timeout, rejeita', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await expect(s.setPermissionMode('timeout-test' as any)).rejects.toThrow(/resposta/)
  })

  it('recusa control quando não está ativa (após stop)', async () => {
    const s = start()
    await waitUntil(() => s.status === 'idle')
    await s.stop()
    await expect(s.setModel('opus')).rejects.toThrow(/status/)
  })

  it('falha na auto-aplicação do modo no init é emitida no stderr (não silenciosa)', async () => {
    const errs: string[] = []
    const s = mk({ permissionMode: 'timeout-test' as any })
    live.push(s)
    s.on('stderr', (m: string) => errs.push(m))
    s.start()
    await waitUntil(() => s.status === 'idle')
    await waitUntil(() => errs.some((e) => e.includes('falha ao aplicar modo')), 3000)
    expect(errs.some((e) => e.includes('bypassPermissions'))).toBe(true)
  })
})
