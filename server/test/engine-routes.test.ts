import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createProjectsService } from '../src/projects.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) => new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let project: { id: number }

beforeEach(async () => {
  db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: fakeFactory })
  app = await buildApp({ config: loadConfig({}), db, manager })
  project = createProjectsService(db).create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'r-')) })
})

describe('engine na rota de sessão', () => {
  it('start sem engine → default claude; resposta traz engine', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: {} })
    expect(res.statusCode).toBe(201)
    expect(res.json().engine).toBe('claude')
  })

  it('start com engine=claude → 201', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: { engine: 'claude' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().engine).toBe('claude')
  })

  it('start com engine=codex → 201 (codex registrado pelo SP-B; sessionFactory fake evita spawn real)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: { engine: 'codex' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().engine).toBe('codex')
  })

  it('start com engine desconhecida → 400 unknown_engine', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sessions`, payload: { engine: 'foobar' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unknown_engine')
  })
})
