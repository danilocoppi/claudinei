import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kimiEngine, listModels, __resetModelsCache } from '../src/engine/kimi/kimi-engine.js'
import { kimiHomeFor } from '../src/engine/kimi/kimi-home.js'
import { getEngine, hasEngine } from '../src/engine/index.js'

const PROJ = '/tmp/proj-kimi-engine'
const envBackup = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, CLAUDINEI_KIMI_HOMES: process.env.CLAUDINEI_KIMI_HOMES, CLAUDINEI_KIMI_BIN: process.env.CLAUDINEI_KIMI_BIN }
let userHome: string

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), 'kimi-user-'))
  process.env.KIMI_CODE_HOME = userHome
  process.env.CLAUDINEI_KIMI_HOMES = mkdtempSync(join(tmpdir(), 'kimi-homes-'))
  __resetModelsCache()
})
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  __resetModelsCache()
})

describe('kimiEngine', () => {
  it('está registrada no registry', () => {
    expect(hasEngine('kimi')).toBe(true)
    expect(getEngine('kimi').id).toBe('kimi')
  })

  it('bin() respeita CLAUDINEI_KIMI_BIN', () => {
    expect(kimiEngine.bin()).toBe('kimi')
    process.env.CLAUDINEI_KIMI_BIN = '/opt/kimi'
    expect(kimiEngine.bin()).toBe('/opt/kimi')
  })

  it('models saem do config.toml do usuário, com "" (default) na frente', () => {
    writeFileSync(join(userHome, 'config.toml'), [
      'default_model = "kimi-code/k3"',
      '[models."kimi-code/k3"]',
      'provider = "managed:kimi-code"',
      '[models."kimi-code/k3-256k"]',
    ].join('\n'))
    expect(listModels()).toEqual(['', 'kimi-code/k3', 'kimi-code/k3-256k'])
  })

  it('sem config.toml → só o modelo padrão (não quebra a rota /api/engines)', () => {
    expect(listModels()).toEqual([''])
  })

  it('capabilities: sem seletor de permissão/effort (headless roda sem aprovação)', () => {
    const c = kimiEngine.capabilities()
    expect(c.label).toBe('Kimi Code')
    expect(c.permissions).toEqual([])
    expect(c.efforts).toEqual([])
    expect(c.installHint).toContain('@moonshot-ai/kimi-code')
  })

  it('terminalCommand retoma a conversa e injeta o data root do projeto', () => {
    const cmd = kimiEngine.terminalCommand({ resumeSessionId: 'session_7', projectPath: PROJ })
    expect(cmd.args).toEqual(['-r', 'session_7', '--auto'])
    expect(cmd.env).toEqual({ KIMI_CODE_HOME: kimiHomeFor(PROJ) })
    // o data root é preparado na hora de abrir o terminal
    expect(existsSync(join(kimiHomeFor(PROJ), 'mcp.json'))).toBe(true)
  })

  it('terminalCommand sem conversa → sessão nova', () => {
    expect(kimiEngine.terminalCommand({ projectPath: PROJ }).args).toEqual(['--auto'])
  })

  it('latestConversationId sem sessões → null; readHistory sem sessão → []', async () => {
    expect(kimiEngine.latestConversationId(PROJ)).toBeNull()
    await expect(kimiEngine.readHistory(PROJ, 'session_nada')).resolves.toEqual([])
  })
})
