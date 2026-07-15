import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openCodeEngine, parseExport } from '../src/engine/opencode/opencode-engine.js'
import { getEngine, hasEngine } from '../src/engine/index.js'
import { OpenCodeSession } from '../src/engine/opencode/opencode-session.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

describe('openCodeEngine', () => {
  it('registrado com id opencode', () => {
    expect(hasEngine('opencode')).toBe(true)
    expect(getEngine('opencode')).toBe(openCodeEngine)
  })
  it('createSession → OpenCodeSession sem spawnar', () => {
    const s = openCodeEngine.createSession({ projectPath: '/tmp' })
    expect(s).toBeInstanceOf(OpenCodeSession)
    expect(s.status).toBe('starting')
  })
  it('terminalCommand: com id → opencode --session <id> --auto; sem id → opencode --auto', () => {
    expect(openCodeEngine.terminalCommand({ resumeSessionId: 'ses_1', projectPath: '/tmp', bin: 'opencode' }))
      .toEqual({ file: 'opencode', args: ['--session', 'ses_1', '--auto'] })
    expect(openCodeEngine.terminalCommand({ projectPath: '/tmp', bin: 'opencode' }))
      .toEqual({ file: 'opencode', args: ['--auto'] })
  })
  it('capabilities: efforts=variants, sem permissions, slash curated, label/icon, models é array', () => {
    const c = openCodeEngine.capabilities()
    expect(c.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'max'])
    expect(c.permissions).toEqual([])
    expect(c.slashSource).toBe('curated')
    expect(c.label).toBe('OpenCode')
    expect(c.icon).toBeTruthy()
    expect(Array.isArray(c.models)).toBe(true)
  })
  it('readHistory sem sessão → []', () => {
    expect(openCodeEngine.readHistory('/nao/existe', 'ses_nada')).toEqual([])
  })
  it('latestConversationId: nunca lança e é idempotente (cache) para projeto inexistente', () => {
    expect(() => openCodeEngine.latestConversationId('/nao/existe')).not.toThrow()
    const first = openCodeEngine.latestConversationId('/nao/existe')
    expect(first).toBeNull()
    // 2ª chamada idêntica deve bater no cache e continuar devolvendo null rapidamente,
    // sem lançar mesmo se o db do opencode não existir no ambiente de teste.
    const start = Date.now()
    const second = openCodeEngine.latestConversationId('/nao/existe')
    expect(second).toBeNull()
    expect(Date.now() - start).toBeLessThan(1000)
  })

  describe('parseExport (histórico)', () => {
    it('tool call vira o par tool_use + tool_result (não fica "running" pra sempre)', () => {
      const fixture = readFileSync(join(__dirname, 'fixtures', 'opencode', 'export-with-tool.json'), 'utf8')
      const events = parseExport(fixture)

      const toolUse = events.find((e: any) => e.kind === 'assistant' && e.message?.content?.some((c: any) => c.type === 'tool_use')) as any
      expect(toolUse).toBeTruthy()
      const toolUseBlock = toolUse.message.content.find((c: any) => c.type === 'tool_use')
      expect(toolUseBlock.id).toBe('call_1')

      const toolResult = events.find((e: any) => e.kind === 'user' && e.message?.content?.some((c: any) => c.type === 'tool_result')) as any
      expect(toolResult).toBeTruthy()
      const toolResultBlock = toolResult.message.content.find((c: any) => c.type === 'tool_result')
      expect(toolResultBlock.tool_use_id).toBe('call_1')
      expect(toolResultBlock.is_error).toBe(false)
    })
  })

  describe('latestConversationId (sqlite, determinístico)', () => {
    afterEach(() => { delete process.env.XDG_DATA_HOME })

    function makeOpenCodeDb(rows: Array<{ id: string; directory: string; timeCreated: number }>): string {
      const dataHome = mkdtempSync(join(tmpdir(), 'oc-xdg-'))
      const dbDir = join(dataHome, 'opencode')
      mkdirSync(dbDir, { recursive: true })
      const db = new Database(join(dbDir, 'opencode.db'))
      db.exec('CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER)')
      const insert = db.prepare('INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)')
      for (const r of rows) insert.run(r.id, r.directory, r.timeCreated)
      db.close()
      return dataHome
    }

    it('devolve o id da sessão MAIS RECENTE do directory (não subprocesso)', () => {
      const dir = '/oc-test/most-recent-project'
      const dataHome = makeOpenCodeDb([
        { id: 'ses_old', directory: dir, timeCreated: 1000 },
        { id: 'ses_new', directory: dir, timeCreated: 2000 },
      ])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_new')
    })

    it('directory sem sessão no db devolve null', () => {
      const dirWithSession = '/oc-test/has-session'
      const dirWithout = '/oc-test/no-session-at-all'
      const dataHome = makeOpenCodeDb([{ id: 'ses_x', directory: dirWithSession, timeCreated: 1 }])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dirWithout)).toBeNull()
    })
  })
})
