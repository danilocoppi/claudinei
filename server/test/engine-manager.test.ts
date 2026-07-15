import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { registerEngine, __resetRegistry } from '../src/engine/registry.js'
import { claudeEngine } from '../src/engine/claude-engine.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createProjectsService } from '../src/projects.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

// Engine fake: createSession devolve um ClaudeSession apontando para o fake-claude,
// para exercitar a trava por (projeto, engine) com DUAS engines distintas.
const fakeEngine = (id: string) => ({
  id,
  bin: () => process.execPath,
  createSession: (opts: any) => new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] } as SessionOptions),
  readHistory: () => [],
  latestConversationId: () => null,
  terminalCommand: () => ({ file: 'x', args: [] }),
  capabilities: () => ({ models: [], efforts: [], permissions: [], slashSource: 'none' as const, label: id, icon: '?', slashCommands: [] }),
})

let db: Db
let project: { id: number; name: string; path: string }

beforeEach(() => {
  __resetRegistry()
  registerEngine(claudeEngine)   // 'claude'
  registerEngine(fakeEngine('engA'))
  registerEngine(fakeEngine('engB'))
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  project = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'eng-')) })
})

describe('manager + engine', () => {
  it('SessionInfo carrega engine (default claude); start persiste a engine', () => {
    const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: (o) => new ClaudeSession({ ...o, claudeBin: process.execPath, extraArgsOverride: [FAKE] } as SessionOptions) })
    const info = manager.start(project as any)
    expect(info.engine).toBe('claude')
    const row = db.prepare('SELECT engine FROM sessions WHERE local_id=?').get(info.localId) as any
    expect(row.engine).toBe('claude')
  })

  it('trava por (projeto, engine): permite engA + engB no mesmo projeto, rejeita 2ª da MESMA engine', () => {
    // sem sessionFactory → o manager resolve via registry (getEngine(engine).createSession)
    const manager = createSessionManager({ db, broadcast: () => {} })
    const a = manager.start(project as any, { engine: 'engA' })
    expect(a.engine).toBe('engA')
    // outra engine no MESMO projeto: permitido
    const b = manager.start(project as any, { engine: 'engB' })
    expect(b.engine).toBe('engB')
    // 2ª da MESMA engine: rejeitada
    expect(() => manager.start(project as any, { engine: 'engA' })).toThrow(/já possui sessão ativa/)
  })
})
