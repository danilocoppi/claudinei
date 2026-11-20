import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { WebSocket } from 'ws'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createWsHub } from '../src/routes/ws.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { createTriageStore } from '../src/triage/store.js'
import { registerTriageRoutes } from '../src/routes/triage.js'

const daqui = (ms: number) => new Date(Date.now() + ms).toISOString()
const HORA = 3600_000

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService | undefined
let hub: ReturnType<typeof createWsHub>
let baseUrl: string
let p1: number, p2: number

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}
const login = async (username: string) =>
  cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))
const header = (cookie: Record<string, string>) => `${COOKIE_NAME}=${cookie[COOKIE_NAME]}`

const subir = async (comAuth: boolean) => {
  db = openDb(':memory:')
  auth = comAuth ? createAuthService({ db }) : undefined
  hub = createWsHub()
  const manager = createSessionManager({ db, broadcast: (m) => hub.broadcast(m) })
  app = await buildApp({ config: loadConfig({}), db, manager, auth, wsHub: hub })
  await app.listen({ port: 0, host: '127.0.0.1' })
  baseUrl = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
  if (auth) {
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1] })
    auth.users.create({ username: 'bruno', password: 'abcd1234', projectIds: [p1] })
  }
}

// Fila por socket, anexada na criação (ver auth-ws.test.ts: o 1º frame chega
// antes de qualquer `await`).
const queues = new WeakMap<WebSocket, any[]>()
const openWs = async (cookie?: Record<string, string>) => {
  const ws = new WebSocket(`${baseUrl}/ws`, cookie ? { headers: { cookie: header(cookie) } } : {})
  const queue: any[] = []
  queues.set(ws, queue)
  ws.on('message', (d) => queue.push(JSON.parse(d.toString())))
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  return ws
}
/** Próxima mensagem `triage` do socket, ou erro de timeout. */
const nextTriage = async (ws: WebSocket, ms = 2000): Promise<any> => {
  const queue = queues.get(ws)!
  const start = Date.now()
  for (;;) {
    const i = queue.findIndex((m) => m.type === 'triage')
    if (i >= 0) return queue.splice(i, 1)[0]
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

afterEach(async () => { await app.close(); db.close() })

describe('rotas da triagem (com auth)', () => {
  beforeEach(async () => { await subir(true) })

  it('PATCH grava e o GET devolve', async () => {
    const ana = await login('ana')
    const ate = daqui(HORA)
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, cookies: ana, payload: { pinned: true, snoozedUntil: ate } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: ate, pinOrder: 0 })
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: ana })).json())
      .toEqual([{ projectId: p1, pinned: true, settled: false, snoozedUntil: ate, pinOrder: 0 }])
    // É de ana: bruno, com acesso ao mesmo projeto, não vê nada aplicado.
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: await login('bruno') })).json()).toEqual([])
  })

  it('400 sem campos', async () => {
    const ana = await login('ana')
    const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, cookies: ana, payload: payload as object })
    expect((await patch({})).statusCode).toBe(400)
    expect((await patch({ outro: 1 })).statusCode).toBe(400)
    // Tipo errado também é 400.
    expect((await patch({ pinned: 'sim' })).statusCode).toBe(400)
    expect((await patch({ settled: 1 })).statusCode).toBe(400)
    expect((await patch({ snoozedUntil: 123 })).statusCode).toBe(400)
    expect((await patch({ pinned: true, settled: 'x' })).statusCode).toBe(400)
    expect(createTriageStore(db).list(auth!.users.getByUsername('ana')!.id)).toEqual([])
  })

  it('400 com snoozedUntil no passado', async () => {
    const ana = await login('ana')
    const patch = (snoozedUntil: unknown) =>
      app.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, cookies: ana, payload: { snoozedUntil } })
    expect((await patch(daqui(-1000))).statusCode).toBe(400)
    expect((await patch('amanhã')).statusCode).toBe(400)
    expect((await patch('2099-13-40T99:00:00Z')).statusCode).toBe(400)
    // null desfaz o adiamento e é aceito.
    expect((await patch(null)).statusCode).toBe(200)
  })

  it('403 sem acesso e o GET não lista o projeto', async () => {
    const ana = await login('ana')
    const anaId = auth!.users.getByUsername('ana')!.id
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${p2}/triage`, cookies: ana, payload: { pinned: true } })
    expect(res.statusCode).toBe(403)
    // Linha de um projeto que ela já não acessa (perdeu o acesso depois de fixar).
    createTriageStore(db).update(anaId, p2, { pinned: true })
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: ana })).json()).toEqual([])
  })

  it('404 para projeto inexistente', async () => {
    const root = await login('root')
    expect((await app.inject({ method: 'PATCH', url: '/api/projects/99999/triage', cookies: root, payload: { pinned: true } })).statusCode).toBe(404)
  })

  it('token de serviço recebe 403', async () => {
    const h = { authorization: `Bearer ${auth!.tokens.signService()}` }
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, headers: h, payload: { pinned: true } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/triage', headers: h })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${p1}/favorite`, headers: h, payload: { favorite: true } })).statusCode).toBe(403)

    // A própria rota recusa, mesmo que o escopo do token um dia deixe passar.
    const nua = Fastify()
    nua.addHook('onRequest', async (req) => { (req as any).authUser = { kind: 'service' } })
    registerTriageRoutes(nua, { store: createTriageStore(db), db })
    const res = await nua.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, payload: { pinned: true } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('token de serviço não tem triagem')
    expect((await nua.inject({ method: 'GET', url: '/api/triage' })).json()).toEqual([])
    await nua.close()
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_triage').get() as { n: number }).n).toBe(0)
  })

  it('WS triage chega só ao próprio usuário (nem ao admin)', async () => {
    const ana = await login('ana')
    const anaWs = await openWs(ana)
    const brunoWs = await openWs(await login('bruno'))
    const rootWs = await openWs(await login('root'))
    await app.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, cookies: ana, payload: { settled: true } })
    const anaId = auth!.users.getByUsername('ana')!.id
    await expect(nextTriage(anaWs)).resolves.toEqual({
      type: 'triage', userId: anaId, item: { projectId: p1, pinned: false, settled: true, snoozedUntil: null, pinOrder: null },
    })
    await expect(nextTriage(brunoWs, 300)).rejects.toThrow('timeout')
    await expect(nextTriage(rootWs, 300)).rejects.toThrow('timeout')
    anaWs.close(); brunoWs.close(); rootWs.close()
  })

  it('WS triage de um projeto que o usuário não acessa mais não chega a ele', async () => {
    // ana tinha triagem em Beta (o despertar alcança toda linha do projeto) e perdeu o acesso.
    const anaId = auth!.users.getByUsername('ana')!.id
    const anaWs = await openWs(await login('ana'))
    hub.broadcast({ type: 'triage', userId: anaId, item: { projectId: p2, pinned: false, settled: false, snoozedUntil: null, pinOrder: null } })
    hub.broadcast({ type: 'triage', userId: anaId, item: { projectId: p1, pinned: false, settled: false, snoozedUntil: null, pinOrder: null } })
    await expect(nextTriage(anaWs)).resolves.toMatchObject({ item: { projectId: p1 } })
    await expect(nextTriage(anaWs, 300)).rejects.toThrow('timeout')
    anaWs.close()
  })

  it('rota da ⭐ fixa para quem clicou e não para os outros', async () => {
    const ana = await login('ana')
    const bruno = await login('bruno')
    const anaId = auth!.users.getByUsername('ana')!.id
    const anaWs = await openWs(ana)
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${p1}/favorite`, cookies: ana, payload: { favorite: true } })
    expect(res.statusCode).toBe(200)
    // Resposta no formato antigo (Project), com a ⭐ de quem clicou.
    expect(res.json()).toMatchObject({ id: p1, name: 'Alfa', favorite: true })
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: ana })).json())
      .toEqual([{ projectId: p1, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 }])
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: bruno })).json()).toEqual([])
    // Os outros aparelhos de ana ficam sabendo.
    await expect(nextTriage(anaWs)).resolves.toMatchObject({ type: 'triage', userId: anaId, item: { projectId: p1, pinned: true } })
    // A coluna global não é mais escrita.
    expect(createProjectsService(db).get(p1)?.favorite).toBe(false)
    anaWs.close()
  })
})

describe('ordem dos fixados (PUT /api/triage/pin-order)', () => {
  let p3: number
  beforeEach(async () => {
    await subir(true)
    p3 = createProjectsService(db).create({ name: 'Gama', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
    // ana acessa Alfa e Gama; bruno, só Alfa.
    auth!.users.update(auth!.users.getByUsername('ana')!.id, { projectIds: [p1, p3] })
  })
  const put = (cookies: Record<string, string>, payload: unknown) =>
    app.inject({ method: 'PUT', url: '/api/triage/pin-order', cookies, payload: payload as object })
  const pin = (cookies: Record<string, string>, id: number) =>
    app.inject({ method: 'PATCH', url: `/api/projects/${id}/triage`, cookies, payload: { pinned: true } })

  it('grava a ordem de quem pediu, devolve a triagem e avisa só os aparelhos dele', async () => {
    const ana = await login('ana')
    const bruno = await login('bruno')
    const anaId = auth!.users.getByUsername('ana')!.id
    await pin(ana, p1); await pin(ana, p3); await pin(bruno, p1)
    const anaWs = await openWs(ana)
    const brunoWs = await openWs(bruno)

    const res = await put(ana, { projectIds: [p3, p1] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { projectId: p1, pinned: true, settled: false, snoozedUntil: null, pinOrder: 1 },
      { projectId: p3, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 },
    ])
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: ana })).json()).toEqual(res.json())
    // Um aviso por fixado que mudou de posição, só para ana.
    const msgs = [await nextTriage(anaWs), await nextTriage(anaWs)]
    expect(msgs.map((m) => [m.userId, m.item.projectId, m.item.pinOrder]).sort()).toEqual([[anaId, p1, 1], [anaId, p3, 0]].sort())
    await expect(nextTriage(brunoWs, 300)).rejects.toThrow('timeout')
    // bruno não foi mexido.
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: bruno })).json())
      .toEqual([{ projectId: p1, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 }])
    anaWs.close(); brunoWs.close()
  })

  it('400 com corpo inválido, repetido ou terminal não fixado', async () => {
    const ana = await login('ana')
    await pin(ana, p1)
    for (const body of [{}, { projectIds: 'x' }, { projectIds: [p1, 'x'] }, { projectIds: [1.5] }, { projectIds: [-1] }, { projectIds: [p1, p1] }]) {
      expect((await put(ana, body)).statusCode).toBe(400)
    }
    // Gama não está fixado para ana.
    expect((await put(ana, { projectIds: [p3, p1] })).statusCode).toBe(400)
    expect(createTriageStore(db).get(auth!.users.getByUsername('ana')!.id, p1).pinOrder).toBe(0)
  })

  it('403 com projeto sem acesso e para o token de serviço', async () => {
    const ana = await login('ana')
    const anaId = auth!.users.getByUsername('ana')!.id
    await pin(ana, p1)
    // Fixado de quando tinha acesso a Beta: ainda assim não pode ordená-lo.
    createTriageStore(db).update(anaId, p2, { pinned: true })
    expect((await put(ana, { projectIds: [p2, p1] })).statusCode).toBe(403)
    const h = { authorization: `Bearer ${auth!.tokens.signService()}` }
    expect((await app.inject({ method: 'PUT', url: '/api/triage/pin-order', headers: h, payload: { projectIds: [p1] } })).statusCode).toBe(403)
  })
})

describe('rotas da triagem (sem auth)', () => {
  beforeEach(async () => { await subir(false) })

  it('a instalação sem auth usa o usuário 0 e recebe só as mensagens dele', async () => {
    const ws = await openWs()
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, payload: { pinned: true } })
    expect(res.statusCode).toBe(200)
    expect(createTriageStore(db).get(0, p1).pinned).toBe(true)
    await expect(nextTriage(ws)).resolves.toMatchObject({ type: 'triage', userId: 0, item: { projectId: p1, pinned: true } })
    hub.broadcast({ type: 'triage', userId: 7, item: { projectId: p1, pinned: false, settled: true, snoozedUntil: null, pinOrder: null } })
    await expect(nextTriage(ws, 300)).rejects.toThrow('timeout')
    ws.close()
  })

  it('a ordem dos fixados também vale para o usuário 0', async () => {
    await app.inject({ method: 'PATCH', url: `/api/projects/${p1}/triage`, payload: { pinned: true } })
    await app.inject({ method: 'PATCH', url: `/api/projects/${p2}/triage`, payload: { pinned: true } })
    const res = await app.inject({ method: 'PUT', url: '/api/triage/pin-order', payload: { projectIds: [p2, p1] } })
    expect(res.statusCode).toBe(200)
    expect(createTriageStore(db).get(0, p2).pinOrder).toBe(0)
    expect(createTriageStore(db).get(0, p1).pinOrder).toBe(1)
  })
})
