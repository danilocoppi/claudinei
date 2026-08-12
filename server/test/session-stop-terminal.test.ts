import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerSessionRoutes } from '../src/routes/sessions.js'
import { openDb, type Db } from '../src/db.js'

let app: FastifyInstance
let db: Db
let stopped: string[]
let closed: string[]
let status: string

const makeApp = async () => {
  stopped = []; closed = []
  const manager = {
    get: (localId: string) => ({ localId, projectId: 1, engine: 'codex', status, engineSessionId: null, updatedAt: '', model: null, permissionMode: 'bypassPermissions', effort: null }),
    stop: async (localId: string) => { stopped.push(localId) },
  } as never
  const terminalManager = { closeAndWait: async (localId: string) => { closed.push(localId) } }
  app = Fastify()
  registerSessionRoutes(app, { db, manager, config: {} as never, terminalManager } as never)
  await app.ready()
}

beforeEach(() => { db = openDb(':memory:'); status = 'idle' })
afterEach(async () => { await app?.close() })

/**
 * Ao abrir no terminal, a sessão SAI do mapa `live` do manager (quem manda
 * passa a ser o PTY). Como manager.stop() só olha o `live`, o optional chaining
 * engolia a chamada: clicar no ⏻ com a sessão no terminal não fazia nada, em
 * silêncio — nem erro, nem processo encerrado.
 */
describe('POST /api/sessions/:localId/stop com a sessão no terminal', () => {
  it('encerra o PTY quando a sessão está in_terminal', async () => {
    status = 'in_terminal'
    await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/sessions/abc/stop' })
    expect(res.statusCode).toBe(204)
    expect(closed).toEqual(['abc'])
  })

  it('sessão comum não mexe no terminal', async () => {
    status = 'idle'
    await makeApp()
    await app.inject({ method: 'POST', url: '/api/sessions/abc/stop' })
    expect(closed).toEqual([])
    expect(stopped).toEqual(['abc'])
  })

  it('sem terminalManager configurado, não quebra', async () => {
    status = 'in_terminal'
    stopped = []; closed = []
    const manager = {
      get: () => ({ localId: 'abc', projectId: 1, status: 'in_terminal' }),
      stop: async (localId: string) => { stopped.push(localId) },
    } as never
    app = Fastify()
    registerSessionRoutes(app, { db, manager, config: {} as never } as never)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/api/sessions/abc/stop' })
    expect(res.statusCode).toBe(204)
  })
})
