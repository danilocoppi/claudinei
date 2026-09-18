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
  it('readHistory sem sessão → []', async () => {
    await expect(openCodeEngine.readHistory('/nao/existe', 'ses_nada')).resolves.toEqual([])
  })
  it('latestConversationId: nunca lança e é rápida para projeto inexistente', () => {
    expect(() => openCodeEngine.latestConversationId('/nao/existe')).not.toThrow()
    const first = openCodeEngine.latestConversationId('/nao/existe')
    expect(first).toBeNull()
    // Null NÃO é cacheado (de propósito: sessão de terminal pode nascer logo em
    // seguida), mas repetir a consulta sem db continua rápido e sem lançar.
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

    type Row = { id: string; directory: string; timeCreated: number; timeUpdated?: number; parentId?: string | null }

    function makeOpenCodeDb(rows: Row[] = []): { dataHome: string; dbPath: string; add: (more: Row[]) => void } {
      const dataHome = mkdtempSync(join(tmpdir(), 'oc-xdg-'))
      const dbDir = join(dataHome, 'opencode')
      mkdirSync(dbDir, { recursive: true })
      const dbPath = join(dbDir, 'opencode.db')
      const db = new Database(dbPath)
      db.exec('CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT)')
      db.close()
      const add = (more: Row[]) => {
        const d = new Database(dbPath)
        const insert = d.prepare('INSERT INTO session (id, directory, time_created, time_updated, parent_id) VALUES (?, ?, ?, ?, ?)')
        for (const r of more) insert.run(r.id, r.directory, r.timeCreated, r.timeUpdated ?? r.timeCreated, r.parentId ?? null)
        d.close()
      }
      add(rows)
      return { dataHome, dbPath, add }
    }

    it('devolve o id da sessão MAIS RECENTE do directory (não subprocesso)', () => {
      const dir = '/oc-test/most-recent-project'
      const { dataHome } = makeOpenCodeDb([
        { id: 'ses_old', directory: dir, timeCreated: 1000 },
        { id: 'ses_new', directory: dir, timeCreated: 2000 },
      ])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_new')
    })

    it('pula as sessões excluídas (conversa do terminal vizinho)', () => {
      const dir = '/oc-test/exclude-basico'
      const { dataHome } = makeOpenCodeDb([
        { id: 'ses_meu', directory: dir, timeCreated: 1000 },
        { id: 'ses_alheio', directory: dir, timeCreated: 2000 },
      ])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_alheio')
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_alheio']))).toBe('ses_meu')
      // O LIMIT 1 tem que valer para o que SOBROU: excluir tudo é conversa nova.
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_meu', 'ses_alheio']))).toBeNull()
    })

    // Sem o exclude na chave, a primeira resposta cacheada valeria para a
    // pergunta seguinte — que é outra pergunta.
    it('o exclude entra na chave do cache: duas perguntas não se atropelam', () => {
      const dir = '/oc-test/exclude-cache'
      const { dataHome } = makeOpenCodeDb([
        { id: 'ses_a', directory: dir, timeCreated: 2000 },
        { id: 'ses_b', directory: dir, timeCreated: 1000 },
      ])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_a')
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_a']))).toBe('ses_b')
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_a')
    })

    it('invalidar a pasta limpa também as respostas com exclude', () => {
      const dir = '/oc-test/exclude-invalidacao'
      const { dataHome, add } = makeOpenCodeDb([
        { id: 'ses_a', directory: dir, timeCreated: 2000 },
        { id: 'ses_b', directory: dir, timeCreated: 1000 },
      ])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_a']))).toBe('ses_b')
      add([{ id: 'ses_c', directory: dir, timeCreated: 3000 }])
      openCodeEngine.invalidateLatestConversation?.(dir)
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_a']))).toBe('ses_c')
    })

    it('directory sem sessão no db devolve null', () => {
      const dirWithSession = '/oc-test/has-session'
      const dirWithout = '/oc-test/no-session-at-all'
      const { dataHome } = makeOpenCodeDb([{ id: 'ses_x', directory: dirWithSession, timeCreated: 1 }])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dirWithout)).toBeNull()
    })

    it('ignora sessões FILHAS de subagentes (parent_id) — devolve a conversa principal', () => {
      // Reproduz o bug relatado: o TUI cria subagentes no MESMO directory com
      // time_created mais novo; o chat trazia o transcript do subagente.
      const dir = '/oc-test/subagent-children'
      const { dataHome } = makeOpenCodeDb([
        { id: 'ses_main', directory: dir, timeCreated: 1000, timeUpdated: 5000 },
        { id: 'ses_child_1', directory: dir, timeCreated: 2000, timeUpdated: 6000, parentId: 'ses_main' },
        { id: 'ses_child_2', directory: dir, timeCreated: 3000, timeUpdated: 7000, parentId: 'ses_main' },
      ])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_main')
    })

    it('sessão RETOMADA no TUI vence por time_updated (não pela criação mais nova)', () => {
      // Retomar uma conversa antiga no terminal não muda o time_created dela;
      // ordenar por criação devolveria uma sessão mais nova que ficou parada.
      const dir = '/oc-test/resumed-wins'
      const { dataHome } = makeOpenCodeDb([
        { id: 'ses_resumed', directory: dir, timeCreated: 1000, timeUpdated: 9000 },
        { id: 'ses_newer_idle', directory: dir, timeCreated: 2000, timeUpdated: 3000 },
      ])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_resumed')
    })

    it('null NÃO é cacheado: sessão criada logo depois aparece sem esperar o TTL', () => {
      // Terminal aberto antes da 1ª mensagem (TUI só cria a sessão ao conversar):
      // cachear o null deixaria o histórico vazio por até 30 s depois de existir.
      const dir = '/oc-test/null-not-cached'
      const { dataHome, add } = makeOpenCodeDb()
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBeNull()
      add([{ id: 'ses_from_tui', directory: dir, timeCreated: 1000 }])
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_from_tui')
    })

    it('invalidateLatestConversation descarta o id positivo em cache (saída do terminal)', () => {
      const dir = '/oc-test/invalidate-cache'
      const { dataHome, add } = makeOpenCodeDb([{ id: 'ses_before', directory: dir, timeCreated: 1000 }])
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_before')
      add([{ id: 'ses_after_tui', directory: dir, timeCreated: 2000 }])
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_before') // ainda em cache (TTL)
      openCodeEngine.invalidateLatestConversation?.(dir)
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_after_tui')
    })

    it('schema antigo (sem parent_id/time_updated) degrada para a consulta original', () => {
      const dir = '/oc-test/old-schema'
      const dataHome = mkdtempSync(join(tmpdir(), 'oc-xdg-'))
      mkdirSync(join(dataHome, 'opencode'), { recursive: true })
      const db = new Database(join(dataHome, 'opencode', 'opencode.db'))
      db.exec('CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER)')
      db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_legacy', dir, 1)
      db.close()
      process.env.XDG_DATA_HOME = dataHome
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_legacy')
    })
  })
})
