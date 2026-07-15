import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createProjectsService } from '../src/projects.js'
import '../src/engine/index.js' // registra claude + codex + opencode
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { CodexSession } from '../src/engine/codex/codex-session.js'
import { OpenCodeSession } from '../src/engine/opencode/opencode-session.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_CLAUDE = join(__dirname, 'fake-claude.mjs')
const FAKE_CODEX = join(__dirname, 'fake-codex.mjs')
const FAKE_OPENCODE = join(__dirname, 'fake-opencode.mjs')

// Factory que escolhe o fake conforme a engine desejada — simula os três adapters.
const factory = (opts: any) =>
  opts.__engine === 'codex'
    ? new CodexSession({ ...opts, binOverride: process.execPath, extraArgsOverride: [FAKE_CODEX] })
    : opts.__engine === 'opencode'
    ? new OpenCodeSession({ ...opts, binOverride: process.execPath, extraArgsOverride: [FAKE_OPENCODE] })
    : new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE_CLAUDE] } as SessionOptions)

let db: Db, project: { id: number; name: string; path: string }
beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'ei-')) })
})

describe('1 Claude + 1 Codex no mesmo terminal', () => {
  it('start claude e codex coexistem; SessionInfo.engine correto', () => {
    // sessionFactory recebe as opts SEM saber a engine; para o teste, marcamos via closure
    let nextEngine = 'claude'
    const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: (o) => factory({ ...o, __engine: nextEngine }) })
    nextEngine = 'claude'; const c = manager.start(project as any, { engine: 'claude' })
    nextEngine = 'codex'; const x = manager.start(project as any, { engine: 'codex' })
    expect(c.engine).toBe('claude'); expect(x.engine).toBe('codex')
    const list = manager.list()
    expect(list.filter((s) => s.projectId === project.id).map((s) => s.engine).sort()).toEqual(['claude', 'codex'])
    // 2ª claude no mesmo projeto rejeitada
    nextEngine = 'claude'
    expect(() => manager.start(project as any, { engine: 'claude' })).toThrow(/já possui sessão ativa/)
  })
})

describe('1 Claude + 1 Codex + 1 OpenCode no mesmo terminal', () => {
  it('as três engines coexistem no mesmo projeto; SessionInfo.engine correto', () => {
    // sessionFactory recebe as opts SEM saber a engine; para o teste, marcamos via closure
    let nextEngine = 'claude'
    const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: (o) => factory({ ...o, __engine: nextEngine }) })
    nextEngine = 'claude'; const c = manager.start(project as any, { engine: 'claude' })
    nextEngine = 'codex'; const x = manager.start(project as any, { engine: 'codex' })
    nextEngine = 'opencode'; const o = manager.start(project as any, { engine: 'opencode' })
    expect(c.engine).toBe('claude'); expect(x.engine).toBe('codex'); expect(o.engine).toBe('opencode')
    const list = manager.list()
    expect(list.filter((s) => s.projectId === project.id).map((s) => s.engine).sort()).toEqual(['claude', 'codex', 'opencode'])
    // 2ª opencode no mesmo projeto rejeitada
    nextEngine = 'opencode'
    expect(() => manager.start(project as any, { engine: 'opencode' })).toThrow(/já possui sessão ativa/)
  })
})
