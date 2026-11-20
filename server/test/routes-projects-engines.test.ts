import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { getEngine } from '../src/engine/index.js'
import { enginesOf } from '../src/terminal-engines.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** As rotas que gravam a lista de motores do terminal. */

// Quais CLIs "estão instaladas" decide o padrão de um terminal novo; o teste não
// pode depender do que existe nesta máquina.
const instalado = vi.hoisted(() => ({ bin: null as null | ((bin: string) => boolean) }))
vi.mock('../src/engine/available.js', async (original) => {
  const real = await original<typeof import('../src/engine/available.js')>()
  return { ...real, binAvailableCached: (bin: string) => instalado.bin ? instalado.bin(bin) : real.binAvailableCached(bin) }
})
afterEach(() => { instalado.bin = null })

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
const pasta = () => mkdtempSync(join(tmpdir(), 'motores-r-'))

beforeEach(async () => {
  db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: { ...loadConfig({}), scratchDir: join(pasta(), 'scratch') }, db, manager })
})

const patch = (id: number, payload: unknown, cookies?: Record<string, string>) =>
  app.inject({ method: 'PATCH', url: `/api/projects/${id}/engines`, payload: payload as object, ...(cookies ? { cookies } : {}) })

describe('PATCH /api/projects/:id/engines', () => {
  it('PATCH grava a lista ordenada e devolve o projeto', async () => {
    const p = createProjectsService(db).create({ name: 'A', path: pasta() })
    const res = await patch(p.id, { engines: ['codex', 'claude'] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: p.id, engines: ['claude', 'codex'] })
    expect(enginesOf(db, p.id)).toEqual(['claude', 'codex'])
  })

  it('PATCH com lista vazia dá 400 engines_required', async () => {
    const p = createProjectsService(db).create({ name: 'A', path: pasta() })
    const res = await patch(p.id, { engines: [] })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('engines_required')
    expect((await patch(p.id, {})).statusCode).toBe(400)
    expect(enginesOf(db, p.id)).toEqual(['claude'])
  })

  it('PATCH só com id desconhecido dá 400', async () => {
    const p = createProjectsService(db).create({ name: 'A', path: pasta() })
    const res = await patch(p.id, { engines: ['futuro'] })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('engines_required')
  })

  it('PATCH preserva id desconhecido junto de um conhecido', async () => {
    const p = createProjectsService(db).create({ name: 'A', path: pasta() })
    const res = await patch(p.id, { engines: ['claude', 'futuro'] })
    expect(res.statusCode).toBe(200)
    expect(res.json().engines).toEqual(['claude', 'futuro'])
  })

  it('PATCH em terminal que não existe dá 404 project_not_found', async () => {
    const res = await patch(9999, { engines: ['claude'] })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('project_not_found')
  })
})

describe('acesso', () => {
  let auth: AuthService
  const cookieOf = (res: any): Record<string, string> => {
    const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
    return c ? { [COOKIE_NAME]: c.value } : {}
  }

  beforeEach(async () => {
    await app.close()
    db = openDb(':memory:')
    auth = createAuthService({ db })
    const manager = createSessionManager({ db, broadcast: () => {} })
    app = await buildApp({ config: loadConfig({}), db, manager, auth, usage: { getLimits: async () => [] } })
  })

  it('usuário sem acesso recebe 403 e a lista não muda', async () => {
    const projects = createProjectsService(db)
    const dela = projects.create({ name: 'Alfa', path: pasta() })
    const alheio = projects.create({ name: 'Beta', path: pasta() })
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [dela.id] })
    const ana = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))

    const negado = await patch(alheio.id, { engines: ['codex'] }, ana)
    expect(negado.statusCode).toBe(403)
    expect(enginesOf(db, alheio.id)).toEqual(['claude'])
    // Quem tem acesso ao terminal muda a lista, mesmo sem ser admin.
    const ok = await patch(dela.id, { engines: ['codex'] }, ana)
    expect(ok.statusCode).toBe(200)
    expect(enginesOf(db, dela.id)).toEqual(['codex'])
  })
})

describe('criação', () => {
  it('POST /api/projects sem engines usa o padrão', async () => {
    instalado.bin = () => true
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'A', path: pasta() } })
    expect(res.statusCode).toBe(201)
    expect(res.json().engines).toEqual(['claude'])
    // Sem o Claude instalado, entra o primeiro instalado na ordem canônica.
    instalado.bin = (bin) => bin !== getEngine('claude').bin()
    const semClaude = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'B', path: pasta() } })
    expect(semClaude.json().engines).toEqual(['codex'])
  })

  it('POST com engines grava a lista', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'A', path: pasta(), engines: ['kimi', 'claude'] } })
    expect(res.statusCode).toBe(201)
    expect(res.json().engines).toEqual(['claude', 'kimi'])
    expect(enginesOf(db, res.json().id)).toEqual(['claude', 'kimi'])
  })

  it('POST com engines inválido dá 400 e não cria nada', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'A', path: pasta(), engines: [] } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('engines_required')
    expect(createProjectsService(db).list()).toHaveLength(0)
  })

  it('POST /api/projects/scratch com engines [\'codex\'] nasce com o Codex', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/scratch', payload: { name: 'T', engines: ['codex'] } })
    expect(res.statusCode).toBe(201)
    expect(res.json().engines).toEqual(['codex'])
    expect((await app.inject({ method: 'POST', url: '/api/projects/scratch', payload: { engines: ['futuro'] } })).json().code).toBe('engines_required')
  })
})
