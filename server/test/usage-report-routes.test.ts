import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { createUsageIndexStore } from '../src/usage-index/store.js'
import { createUsageIndexer, type IndexStatus } from '../src/usage-index/indexer.js'

// Históricos falsos escritos pelo teste num diretório temporário; o texto é fictício.

let dir: string
let db: Db
let auth: AuthService
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>
let projPath: string

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

const statusFalso = (s: Partial<IndexStatus> = {}) => ({
  status: (): IndexStatus => ({ running: true, filesDone: 3, filesTotal: 7, lastPassAt: null, ...s }),
})

async function montar(usageIndexer?: { status(): IndexStatus }) {
  const manager = createSessionManager({ db, broadcast: () => {} })
  const app = await buildApp({ config: loadConfig({}), db, manager, auth, usageIndexer })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
  return app
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-report-routes-'))
  projPath = join(dir, 'proj')
  mkdirSync(projPath)
  db = openDb(':memory:')
  auth = createAuthService({ db })
  const p = createProjectsService(db).create({ name: 'Alfa', path: projPath })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p.id] })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/usage/report', () => {
  it('admin recebe o relatório com index', async () => {
    const hour = new Date().toISOString().slice(0, 13)
    createUsageIndexStore(db).commitSlice(
      { path: '/f/a.jsonl', engine: 'claude', size: 1, mtimeMs: 1, offset: 1, parser: null },
      [{ row: { hour, engine: 'claude', model: 'claude-opus-5-5', cwd: projPath, input: 10, output: 5, cacheRead: 30, cacheWrite: 2, reasoning: 0 } }],
    )
    const app = await montar(statusFalso())
    const res = await app.inject({ method: 'GET', url: '/api/usage/report?period=7d&tz=180', cookies: adminCookie })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.index).toEqual({ running: true, filesDone: 3, filesTotal: 7, lastPassAt: null })
    expect(body.period).toBe('7d')
    expect(body.terminals.map((t: any) => t.names)).toEqual([['Alfa']])
    expect(body.models.map((m: any) => m.model)).toEqual(['claude-opus-5-5'])
    expect(body.totals.spent).toBe(17)
    expect(Array.isArray(body.series)).toBe(true)
    expect(body.series.length).toBeGreaterThanOrEqual(7)
    await app.close()
  })

  it('sem indexador a rota existe (sem deps.usage) e index vem parado', async () => {
    const app = await montar()
    const res = await app.inject({ method: 'GET', url: '/api/usage/report?period=24h', cookies: adminCookie })
    expect(res.statusCode).toBe(200)
    expect(res.json().index).toEqual({ running: false, filesDone: 0, filesTotal: 0, lastPassAt: null })
    expect(res.json().terminals).toEqual([])
    await app.close()
  })

  it('tz ausente ou fora de −840..840 vale 0', async () => {
    const app = await montar(statusFalso())
    const semTz = (await app.inject({ method: 'GET', url: '/api/usage/report?period=24h', cookies: adminCookie })).json()
    const zero = (await app.inject({ method: 'GET', url: '/api/usage/report?period=24h&tz=0', cookies: adminCookie })).json()
    const fora = (await app.inject({ method: 'GET', url: '/api/usage/report?period=24h&tz=900', cookies: adminCookie })).json()
    const lixo = (await app.inject({ method: 'GET', url: '/api/usage/report?period=24h&tz=abc', cookies: adminCookie })).json()
    const fuso = (await app.inject({ method: 'GET', url: '/api/usage/report?period=24h&tz=180', cookies: adminCookie })).json()
    const buckets = (r: any) => r.series.map((s: any) => s.bucket)
    expect(buckets(semTz)).toEqual(buckets(zero))
    expect(buckets(fora)).toEqual(buckets(zero))
    expect(buckets(lixo)).toEqual(buckets(zero))
    expect(buckets(fuso)).not.toEqual(buckets(zero))
    await app.close()
  })

  it('não admin recebe 403', async () => {
    const app = await montar(statusFalso())
    const res = await app.inject({ method: 'GET', url: '/api/usage/report?period=7d', cookies: anaCookie })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('período inválido dá 400', async () => {
    const app = await montar(statusFalso())
    for (const q of ['?period=1y', '?period=', '']) {
      const res = await app.inject({ method: 'GET', url: `/api/usage/report${q}`, cookies: adminCookie })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })

  it('a rota responde enquanto uma passada roda', async () => {
    // Arquivo grande do Claude: muitas fatias de 1 KB, cedendo o laço entre elas.
    const claudeDir = join(dir, 'claude', 'projects')
    const codexDir = join(dir, 'codex', 'sessions')
    const linhas: string[] = []
    for (let i = 0; i < 3000; i++) {
      linhas.push(JSON.stringify({
        cwd: projPath,
        message: { id: `msg_${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'texto fictício' }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        requestId: `req_${i}`,
        type: 'assistant',
        timestamp: new Date().toISOString(),
      }))
    }
    mkdirSync(join(claudeDir, 'proj'), { recursive: true })
    writeFileSync(join(claudeDir, 'proj', 's1.jsonl'), linhas.join('\n') + '\n')

    const indexer = createUsageIndexer({
      store: createUsageIndexStore(db), claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, sliceBytes: 1024, log: () => {},
    })
    const app = await montar(indexer)
    let terminou = false
    const passada = indexer.runPass().then(() => { terminou = true })
    const res = await app.inject({ method: 'GET', url: '/api/usage/report?period=24h', cookies: adminCookie })
    expect(terminou).toBe(false)
    expect(res.statusCode).toBe(200)
    expect(res.json().index.running).toBe(true)
    await passada
    expect(indexer.status().running).toBe(false)
    await app.close()
  })
})
