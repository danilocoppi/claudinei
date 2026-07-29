import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureKimiHome, kimiHomeFor, userKimiHome } from '../src/engine/kimi/kimi-home.js'

const PROJ = '/tmp/projeto-kimi'
const hermes = {
  command: 'node', args: ['/x/hermes.mjs'], apiUrl: 'http://127.0.0.1:9105',
  projectId: 7, serviceTokenFile: '/data/service-token', engine: 'kimi',
}

let userHome: string
let homesRoot: string
const envBackup = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, CLAUDINEI_KIMI_HOMES: process.env.CLAUDINEI_KIMI_HOMES }

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), 'kimi-user-'))
  homesRoot = mkdtempSync(join(tmpdir(), 'kimi-homes-'))
  process.env.KIMI_CODE_HOME = userHome
  process.env.CLAUDINEI_KIMI_HOMES = homesRoot
})
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

describe('ensureKimiHome', () => {
  it('é determinístico por caminho de projeto (readHistory recalcula o mesmo dir)', () => {
    expect(kimiHomeFor(PROJ)).toBe(kimiHomeFor(PROJ))
    expect(kimiHomeFor(PROJ)).not.toBe(kimiHomeFor('/tmp/outro'))
    expect(kimiHomeFor(PROJ).startsWith(homesRoot)).toBe(true)
  })

  it('symlinka login/config do home real e escreve o mcp.json com o hermes', () => {
    mkdirSync(join(userHome, 'credentials'), { recursive: true })
    writeFileSync(join(userHome, 'config.toml'), 'default_model = "kimi-code/k3"')
    const dir = ensureKimiHome(PROJ, hermes as any)

    expect(lstatSync(join(dir, 'credentials')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(dir, 'config.toml')).isSymbolicLink()).toBe(true)
    // sessions NÃO é compartilhado: o isolamento por projeto depende disso
    expect(existsSync(join(dir, 'sessions'))).toBe(false)

    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    expect(mcp.mcpServers.hermes).toMatchObject({
      command: 'node',
      args: ['/x/hermes.mjs'],
      env: { CLAUDINEI_PROJECT_ID: '7', CLAUDINEI_SERVICE_TOKEN_FILE: '/data/service-token', CLAUDINEI_ENGINE: 'kimi' },
    })
    // o token nunca vai inline quando há arquivo (ver I3 da revisão)
    expect(mcp.mcpServers.hermes.env.CLAUDINEI_SERVICE_TOKEN).toBeUndefined()
  })

  it('preserva os MCP servers do usuário e não deixa .tmp para trás', () => {
    writeFileSync(join(userHome, 'mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' } } }))
    const dir = ensureKimiHome(PROJ, hermes as any)
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['hermes', 'playwright'])
    expect(readdirSync(dir).some((f) => f.includes('.tmp-'))).toBe(false)
  })

  it('idempotente: 2ª chamada não estoura nos symlinks e atualiza o token rotacionado', () => {
    mkdirSync(join(userHome, 'oauth'), { recursive: true })
    const dir = ensureKimiHome(PROJ, hermes as any)
    const again = ensureKimiHome(PROJ, { ...hermes, serviceTokenFile: '/data/service-token-novo' } as any)
    expect(again).toBe(dir)
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    expect(mcp.mcpServers.hermes.env.CLAUDINEI_SERVICE_TOKEN_FILE).toBe('/data/service-token-novo')
  })

  it('sem hermes (sessão sem MCP) escreve mcp.json só com o do usuário', () => {
    const dir = ensureKimiHome(PROJ)
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    expect(mcp.mcpServers.hermes).toBeUndefined()
  })

  it('userKimiHome respeita KIMI_CODE_HOME do ambiente', () => {
    expect(userKimiHome()).toBe(userHome)
  })
})
