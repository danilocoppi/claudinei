import { describe, it, expect } from 'vitest'
import { buildRunArgs, buildResumeArgs, hermesConfigEnv } from '../src/engine/opencode/opencode-args.js'

describe('opencode args', () => {
  it('run: flags fixas + prompt posicional após --', () => {
    const a = buildRunArgs({ prompt: 'oi' })
    expect(a.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto'])
    expect(a[a.length - 2]).toBe('--')
    expect(a[a.length - 1]).toBe('oi')
    expect(a).not.toContain('-m')
    expect(a).not.toContain('--variant')
  })
  it('run: model, variant e title', () => {
    const a = buildRunArgs({ prompt: 'oi', model: 'opencode/claude-sonnet-5', effort: 'high', title: 'T' })
    expect(a).toContain('-m'); expect(a).toContain('opencode/claude-sonnet-5')
    expect(a).toContain('--variant'); expect(a).toContain('high')
    expect(a).toContain('--title'); expect(a).toContain('T')
  })
  it('effort inválido é ignorado', () => {
    expect(buildRunArgs({ prompt: 'x', effort: 'ultra' }).join(' ')).not.toContain('--variant')
  })
  it('resume: run -s <id> ... -- prompt (sem --title)', () => {
    const a = buildResumeArgs('ses_1', { prompt: 'de novo' })
    expect(a.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto'])
    expect(a).toContain('-s'); expect(a).toContain('ses_1')
    expect(a).not.toContain('--title')
    expect(a[a.length - 1]).toBe('de novo')
  })
})

describe('hermesConfigEnv (injeção do MCP hermes no OpenCode)', () => {
  it('sem hermes → env vazio', () => {
    expect(hermesConfigEnv(undefined)).toEqual({})
  })
  it('com hermes → OPENCODE_CONFIG_CONTENT só com o bloco mcp.hermes local', () => {
    const env = hermesConfigEnv({ command: 'node', args: ['/h.mjs', '--hermes'], apiUrl: 'http://127.0.0.1:9105', projectId: 7, serviceToken: 'TK' })
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(Object.keys(cfg)).toEqual(['mcp']) // não sobrescreve outras chaves da config do usuário
    expect(cfg.mcp.hermes.type).toBe('local')
    expect(cfg.mcp.hermes.enabled).toBe(true)
    expect(cfg.mcp.hermes.command).toEqual(['node', '/h.mjs', '--hermes'])
    expect(cfg.mcp.hermes.environment).toMatchObject({
      CLAUDINEI_API: 'http://127.0.0.1:9105',
      CLAUDINEI_PROJECT_ID: '7',
      CLAUDINEI_SERVICE_TOKEN: 'TK',
    })
  })
  it('sem serviceToken → sem a chave CLAUDINEI_SERVICE_TOKEN', () => {
    const cfg = JSON.parse(hermesConfigEnv({ command: 'node', args: [], apiUrl: 'u', projectId: 1 }).OPENCODE_CONFIG_CONTENT)
    expect('CLAUDINEI_SERVICE_TOKEN' in cfg.mcp.hermes.environment).toBe(false)
  })
})

describe('hermesConfigEnv com engine', () => {
  it('injeta CLAUDINEI_ENGINE no environment do MCP', () => {
    const env = hermesConfigEnv({ command: 'node', args: [], apiUrl: 'u', projectId: 1, engine: 'opencode' })
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(cfg.mcp.hermes.environment.CLAUDINEI_ENGINE).toBe('opencode')
  })
})
