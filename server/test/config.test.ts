import { describe, it, expect } from 'vitest'
import { loadConfig, migrateLegacyDataDir, parseCliArgs, resolveSelfUrl } from '../src/config.js'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

describe('loadConfig', () => {
  it('usa defaults quando env vazio', () => {
    const c = loadConfig({})
    expect(c.port).toBe(9105)
    expect(c.host).toBe('127.0.0.1')
    expect(c.claudeBin).toBe('claude')
    expect(c.claudeConfigDir).toBe(join(homedir(), '.claude'))
    expect(c.dbPath).toBe(join(homedir(), '.claudinei', 'claudinei.db'))
    expect(c.hermesScript.endsWith(join('hermes', 'hermes-mcp.mjs'))).toBe(true)
    expect(c.hermesCommand).toBe(process.execPath)
    expect(c.hermesArgs).toEqual([c.hermesScript])
    expect(c.selfUrl).toBe('http://127.0.0.1:9105')
    expect(c.uploadsDir).toBe(join(homedir(), '.claudinei', 'uploads'))
    expect(c.speechDir).toBe(join(homedir(), '.claudinei', 'speech'))
  })

  it('default port é 9105 e host 127.0.0.1', () => {
    const c = loadConfig({})
    expect(c.port).toBe(9105)
    expect(c.host).toBe('127.0.0.1')
  })

  it('CLAUDINEI_HOST/CLAUDINEI_PORT respeitados', () => {
    const c = loadConfig({ CLAUDINEI_HOST: '0.0.0.0', CLAUDINEI_PORT: '9200' })
    expect(c.host).toBe('0.0.0.0')
    expect(c.port).toBe(9200)
  })

  it('respeita overrides por env', () => {
    const c = loadConfig({
      CLAUDINEI_PORT: '5000',
      CLAUDINEI_DB: '/tmp/x.db',
      CLAUDINEI_CLAUDE_BIN: '/usr/local/bin/claude',
      CLAUDE_CONFIG_DIR: '/tmp/claude-cfg',
      CLAUDINEI_HERMES_SCRIPT: '/tmp/hermes-mcp.mjs',
      CLAUDINEI_API: 'http://127.0.0.1:9999',
      CLAUDINEI_UPLOADS: '/tmp/ups',
    })
    expect(c.port).toBe(5000)
    expect(c.dbPath).toBe('/tmp/x.db')
    expect(c.claudeBin).toBe('/usr/local/bin/claude')
    expect(c.claudeConfigDir).toBe('/tmp/claude-cfg')
    expect(c.hermesScript).toBe('/tmp/hermes-mcp.mjs')
    expect(c.hermesArgs).toEqual(['/tmp/hermes-mcp.mjs']) // default: [hermesScript]
    expect(c.selfUrl).toBe('http://127.0.0.1:9999')
    expect(c.uploadsDir).toBe('/tmp/ups')
  })

  it('CLAUDINEI_HERMES_COMMAND/CLAUDINEI_HERMES_ARGS sobrescrevem o padrão (usado pelo binário empacotado)', () => {
    const c = loadConfig({ CLAUDINEI_HERMES_COMMAND: '/opt/claudinei-linux-x64', CLAUDINEI_HERMES_ARGS: '["--hermes"]' })
    expect(c.hermesCommand).toBe('/opt/claudinei-linux-x64')
    expect(c.hermesArgs).toEqual(['--hermes'])
  })

  it('selfUrl usa a porta configurada quando não há override de CLAUDINEI_API', () => {
    const c = loadConfig({ CLAUDINEI_PORT: '6000' })
    expect(c.selfUrl).toBe('http://127.0.0.1:6000')
  })
})

describe('resolveSelfUrl (recalibração pós --port, ver index.ts)', () => {
  it('CLAUDINEI_API (env) sempre vence, mesmo com --port setado', () => {
    const config = loadConfig({ CLAUDINEI_PORT: '9105' })
    expect(resolveSelfUrl(config, { port: 9199 }, { CLAUDINEI_API: 'http://host:1234' })).toBe('http://host:1234')
  })

  it('--port sem CLAUDINEI_API recalibra a selfUrl para a porta da CLI (não a de config.selfUrl)', () => {
    const config = loadConfig({ CLAUDINEI_PORT: '9105' }) // config.selfUrl = http://127.0.0.1:9105
    expect(resolveSelfUrl(config, { port: 9199 }, {})).toBe('http://127.0.0.1:9199')
  })

  it('sem --port e sem CLAUDINEI_API → usa config.selfUrl (default calculado por loadConfig)', () => {
    const config = loadConfig({})
    expect(resolveSelfUrl(config, {}, {})).toBe(config.selfUrl)
  })
})

describe('migrateLegacyDataDir (~/.termaster → ~/.claudinei)', () => {
  it('renomeia a pasta legada e o banco (com -wal/-shm), preservando o conteúdo', () => {
    const base = mkdtempSync(join(tmpdir(), 'home-'))
    const old = join(base, '.termaster')
    mkdirSync(join(old, 'speech'), { recursive: true })
    writeFileSync(join(old, 'termaster.db'), 'dados-do-banco')
    writeFileSync(join(old, 'termaster.db-wal'), 'wal')
    writeFileSync(join(old, 'speech', 'modelo.onnx'), 'modelo')

    migrateLegacyDataDir(base)

    const novo = join(base, '.claudinei')
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(join(novo, 'claudinei.db'), 'utf8')).toBe('dados-do-banco')
    expect(existsSync(join(novo, 'claudinei.db-wal'))).toBe(true)
    expect(readFileSync(join(novo, 'speech', 'modelo.onnx'), 'utf8')).toBe('modelo')
  })

  it('é idempotente e não toca numa instalação nova (~/.claudinei já existe ou nada existe)', () => {
    const base = mkdtempSync(join(tmpdir(), 'home-'))
    migrateLegacyDataDir(base) // nada existe → no-op
    expect(existsSync(join(base, '.claudinei'))).toBe(false)

    mkdirSync(join(base, '.claudinei'))
    writeFileSync(join(base, '.claudinei', 'claudinei.db'), 'novo')
    mkdirSync(join(base, '.termaster')) // sobras legadas NÃO sobrescrevem o novo
    migrateLegacyDataDir(base)
    expect(readFileSync(join(base, '.claudinei', 'claudinei.db'), 'utf8')).toBe('novo')
    expect(existsSync(join(base, '.termaster'))).toBe(true) // deixado quieto
  })
})

describe('codexBin', () => {
  it('default codex', () => {
    expect(loadConfig({}).codexBin).toBe('codex')
  })
  it('respeita CLAUDINEI_CODEX_BIN', () => {
    expect(loadConfig({ CLAUDINEI_CODEX_BIN: '/opt/codex' } as never).codexBin).toBe('/opt/codex')
  })
})

describe('opencodeBin', () => {
  it('default opencode', () => {
    expect(loadConfig({}).opencodeBin).toBe('opencode')
  })
  it('respeita CLAUDINEI_OPENCODE_BIN', () => {
    expect(loadConfig({ CLAUDINEI_OPENCODE_BIN: '/opt/oc' } as never).opencodeBin).toBe('/opt/oc')
  })
})

describe('parseCliArgs', () => {
  it('reconhece --host/--port/--insecure (forma espaçada)', () => {
    expect(parseCliArgs(['--host', '0.0.0.0', '--port', '9200', '--insecure']))
      .toEqual({ host: '0.0.0.0', port: 9200, insecure: true })
  })
  it('reconhece a forma --x=v', () => {
    expect(parseCliArgs(['--host=1.2.3.4', '--port=8080'])).toEqual({ host: '1.2.3.4', port: 8080 })
  })
  it('ignora argumentos desconhecidos e vazio → {}', () => {
    expect(parseCliArgs(['run', '--foo', 'bar'])).toEqual({})
    expect(parseCliArgs([])).toEqual({})
  })
  it('--port não-numérico é ignorado', () => {
    expect(parseCliArgs(['--port', 'abc'])).toEqual({})
  })
})
