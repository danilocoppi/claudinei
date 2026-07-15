import { describe, it, expect } from 'vitest'
import { buildExecArgs, buildResumeArgs } from '../src/engine/codex/codex-args.js'

describe('codex args', () => {
  it('exec: flags fixas + stdin, sem model/effort', () => {
    const a = buildExecArgs({})
    expect(a[0]).toBe('exec')
    expect(a).toContain('--json')
    expect(a).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(a).toContain('--skip-git-repo-check')
    expect(a[a.length - 1]).toBe('-')
    expect(a).not.toContain('-m')
    expect(a.join(' ')).not.toContain('model_reasoning_effort')
  })

  it('exec: model e effort viram flags', () => {
    const a = buildExecArgs({ model: 'gpt-5.6-sol', effort: 'high' })
    expect(a).toContain('-m'); expect(a).toContain('gpt-5.6-sol')
    expect(a.join(' ')).toContain('model_reasoning_effort="high"')
  })

  it('effort inválido é ignorado', () => {
    expect(buildExecArgs({ effort: 'ultracode' }).join(' ')).not.toContain('model_reasoning_effort')
  })

  it('resume: exec resume <threadId> + stdin', () => {
    const a = buildResumeArgs('THREAD123', {})
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', 'THREAD123'])
    expect(a).toContain('--json')
    expect(a[a.length - 1]).toBe('-')
  })

  it('hermes: valores viram -c mcp_servers.hermes.* entre aspas TOML', () => {
    const a = buildExecArgs({
      hermes: { command: 'node', args: ['/x/hermes.mjs'], apiUrl: 'http://h', projectId: 7 },
    })
    const s = a.join(' ')
    expect(s).toContain('mcp_servers.hermes.command="node"')
    expect(s).toContain('mcp_servers.hermes.args=["/x/hermes.mjs"]')
    expect(s).toContain('mcp_servers.hermes.env.CLAUDINEI_API="http://h"')
    expect(s).toContain('mcp_servers.hermes.env.CLAUDINEI_PROJECT_ID="7"')
  })

  it('hermes: aspas e barras invertidas no valor são escapadas (não quebram o TOML)', () => {
    const a = buildExecArgs({
      hermes: {
        command: 'C:\\bin\\node.exe',
        args: ['--flag="x"'],
        apiUrl: 'http://h/"inject"',
        projectId: 1,
        serviceToken: 'tok"en\\with\\slashes',
      },
    })
    const s = a.join(' ')
    expect(s).toContain('mcp_servers.hermes.command="C:\\\\bin\\\\node.exe"')
    expect(s).toContain('mcp_servers.hermes.args=["--flag=\\"x\\""]')
    expect(s).toContain('mcp_servers.hermes.env.CLAUDINEI_API="http://h/\\"inject\\""')
    expect(s).toContain('mcp_servers.hermes.env.CLAUDINEI_SERVICE_TOKEN="tok\\"en\\\\with\\\\slashes"')
  })
})

describe('hermes com engine', () => {
  it('injeta CLAUDINEI_ENGINE no env do MCP quando hermes.engine presente', async () => {
    const { buildExecArgs } = await import('../src/engine/codex/codex-args.js')
    const args = buildExecArgs({ hermes: { command: 'node', args: ['/h.mjs'], apiUrl: 'http://h', projectId: 1, engine: 'codex' } })
    expect(args.join(' ')).toContain('mcp_servers.hermes.env.CLAUDINEI_ENGINE="codex"')
  })
})
