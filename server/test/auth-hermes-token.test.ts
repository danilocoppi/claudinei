import { describe, it, expect } from 'vitest'
import { buildClaudeArgs } from '../src/claude/session.js'

// buildClaudeArgs é o construtor puro de argv da sessão (exportado por session.ts,
// ver session.test.ts) — usado aqui pra inspecionar o --mcp-config.
describe('service token no mcp-config do hermes', () => {
  const hermes = { command: '/bin/claudinei', args: ['--hermes'], apiUrl: 'http://127.0.0.1:9105', projectId: 3, serviceToken: 'TOK123' }

  it('injeta CLAUDINEI_SERVICE_TOKEN no env do server MCP', () => {
    const args = buildClaudeArgs({ hermes })
    const mcpIdx = args.indexOf('--mcp-config')
    const cfg = JSON.parse(args[mcpIdx + 1])
    expect(cfg.mcpServers.hermes.env.CLAUDINEI_SERVICE_TOKEN).toBe('TOK123')
    expect(cfg.mcpServers.hermes.env.CLAUDINEI_API).toBe('http://127.0.0.1:9105')
  })

  it('sem serviceToken o env não ganha a chave', () => {
    const args = buildClaudeArgs({ hermes: { ...hermes, serviceToken: undefined } })
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect('CLAUDINEI_SERVICE_TOKEN' in cfg.mcpServers.hermes.env).toBe(false)
  })
})
