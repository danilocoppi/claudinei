import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { getEngine, type EngineSessionOptions } from '../src/engine/index.js'
import type { CutPoint } from '../src/branch/cut.js'
import type { BranchService } from '../src/branch/service.js'
import type { Undo } from '../src/undo/index.js'
import { listSideThreads } from '../src/branch/side-threads.js'
import { SIDE_ACTIVE } from '../src/undo/store.js'
import { observerOf } from '../src/undo/index.js'
import { makeRepo } from './helpers/git-repo.js'

/**
 * Rotas da conversa lateral (`/side`, `/btw`) e a amarração do serviço no app:
 * a principal é o fake-claude pelo manager, a lateral é uma ClaudeSession de
 * verdade rodando o mesmo fake (nunca a CLI real), e o corte vem injetado.
 */
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')

const waitUntil = (cond: () => boolean, ms = 5000) => {
  // Criado aqui: a pilha do timeout aponta a espera que falhou.
  const timeout = new Error('timeout')
  return new Promise<void>((res, rej) => {
    const t0 = Date.now()
    const i = setInterval(() => {
      if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(timeout) }
    }, 10)
  })
}

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService
let manager: ReturnType<typeof createSessionManager>
let branch: BranchService | undefined
let undo: Undo | undefined
let broadcasts: any[]
let sideOpts: EngineSessionOptions[]
let cfg: string
let p1: Project, p2: Project
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const CUT: CutPoint = { cut: 'aaaaaaaa-0000-4000-8000-000000000001', at: '2026-11-20T12:00:00.000Z', previewBefore: 10 }

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  broadcasts = []
  sideOpts = []
  branch = undefined
  undo = undefined
  cfg = mkdtempSync(join(tmpdir(), 'br-cfg-'))
  // Como o index.ts: o fim da sessão principal chega ao serviço pela referência.
  manager = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: () => {},
    onSessionEnded: (projectId, engine) => branch?.onSessionEnded(projectId, engine),
    // Como o index.ts: o rastreador do desfazer vê os turnos da principal.
    turnObserver: observerOf(() => undo),
  })
  app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as never,
    onBranchReady: (b) => { branch = b },
    onUndoReady: (u) => { undo = u },
    branchTest: {
      makeSession: (engine, opts) => {
        sideOpts.push(opts)
        return getEngine(engine).createSession({ ...opts, bin: process.execPath, extraArgsOverride: [FAKE] })
      },
      cutFor: async () => CUT,
      cleanup: { claudeConfigDir: cfg },
    },
  })
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'br1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'br2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
})

afterEach(async () => {
  await branch?.dispose()
  await manager.stopAll()
  await app.close()
  rmSync(cfg, { recursive: true, force: true })
})

/** Sobe a sessão principal do terminal e espera o id da conversa (o init do fake). */
const startMain = async (project: Project) => {
  const info = manager.start(project)
  await waitUntil(() => !!manager.get(info.localId)?.engineSessionId)
  return info.localId
}

const openSide = (pid: number, payload: object, cookies = adminCookie) =>
  app.inject({ method: 'POST', url: `/api/projects/${pid}/side`, cookies, payload })
const message = (pid: number, payload: object, cookies = adminCookie) =>
  app.inject({ method: 'POST', url: `/api/projects/${pid}/side/message`, cookies, payload })
const interrupt = (pid: number, payload: object, cookies = adminCookie) =>
  app.inject({ method: 'POST', url: `/api/projects/${pid}/side/interrupt`, cookies, payload })
const getSide = (pid: number, engine = 'claude', cookies = adminCookie) =>
  app.inject({ method: 'GET', url: `/api/projects/${pid}/side?engine=${engine}`, cookies })
const closeSide = (pid: number, engine = 'claude', cookies = adminCookie) =>
  app.inject({ method: 'DELETE', url: `/api/projects/${pid}/side?engine=${engine}`, cookies })

const sideEvents = (pid: number) => broadcasts.filter((b) => b.type === 'side_event' && b.projectId === pid)
const sideStates = (pid: number) => broadcasts.filter((b) => b.type === 'side_state' && b.projectId === pid)
const textOf = (e: any): string => String(e?.message?.content?.[0]?.text ?? '')
const assistantTexts = (pid: number) => sideEvents(pid).filter((b) => b.event.kind === 'assistant').map((b) => textOf(b.event))

describe('rotas da lateral', () => {
  it('abre, conversa, interrompe e fecha pela API', async () => {
    await startMain(p1)
    const res = await openSide(p1.id, { engine: 'claude', text: 'qual o plano?' })
    expect(res.statusCode).toBe(201)
    const side = res.json()
    expect(side).toMatchObject({ projectId: p1.id, engine: 'claude', mode: 'native', cutAt: CUT.at, files: 'no_edit_tools', question: 'qual o plano?' })
    // A lateral nasce só leitura, efêmera, sem hermes e copiando a principal.
    expect(sideOpts[0]).toMatchObject({ projectPath: p1.path, readOnly: true, ephemeral: true, forkFrom: { sourceId: 'fake-session-0001' } })
    expect(sideOpts[0].hermes).toBeUndefined()
    await waitUntil(() => assistantTexts(p1.id).includes('eco: qual o plano?'))

    expect((await message(p1.id, { engine: 'claude', text: 'e depois?' })).statusCode).toBe(204)
    await waitUntil(() => assistantTexts(p1.id).includes('eco: e depois?'))

    // Um turno que só fecha com a interrupção.
    expect((await message(p1.id, { engine: 'claude', text: 'demorada' })).statusCode).toBe(204)
    await waitUntil(() => sideStates(p1.id).some((b) => b.side?.status === 'working'))
    expect((await interrupt(p1.id, { engine: 'claude' })).statusCode).toBe(204)
    // O turno fecha (o result póstumo da CLI pode ser descartado pela sessão).
    await waitUntil(() => sideStates(p1.id).at(-1)?.side?.status !== 'working')

    expect((await closeSide(p1.id)).statusCode).toBe(204)
    expect(sideStates(p1.id).at(-1)).toMatchObject({ engine: 'claude', side: null })
    expect((await getSide(p1.id)).json()).toEqual({ side: null, events: [] })
    // A anotação da lateral sai junto.
    expect(listSideThreads(db)).toEqual([])
    // Sem lateral: a mensagem não tem para onde ir.
    const semLateral = await message(p1.id, { engine: 'claude', text: 'oi' })
    expect(semLateral.statusCode).toBe(404)
    expect(semLateral.json().code).toBe('side_not_found')
    expect((await interrupt(p1.id, { engine: 'claude' })).statusCode).toBe(404)
    // Fechar de novo não é erro.
    expect((await closeSide(p1.id)).statusCode).toBe(204)
  })

  it('sem conversa principal: 409 no_conversation', async () => {
    const res = await openSide(p1.id, { engine: 'claude', text: 'oi' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('no_conversation')
    // Parada, a principal não conta: a lateral copia só a sessão de pé.
    const localId = await startMain(p1)
    await manager.stop(localId)
    expect(manager.list().find((s) => s.localId === localId)).toMatchObject({ status: 'stopped', engineSessionId: 'fake-session-0001' })
    const parada = await openSide(p1.id, { engine: 'claude', text: 'oi' })
    expect(parada.statusCode).toBe(409)
    expect(parada.json().code).toBe('no_conversation')
    expect(sideOpts).toEqual([])
  })

  it('volta da conversa em curso (o desfazer segura o terminal): 409 rewind_in_progress, sem lateral', async () => {
    await startMain(p1)
    vi.spyOn(undo!.rewind, 'holds').mockImplementation((p, e) => p === p1.id && e === 'claude')
    const res = await openSide(p1.id, { engine: 'claude', text: 'oi' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('rewind_in_progress')
    expect(sideOpts).toEqual([])
    expect(listSideThreads(db)).toEqual([])
  })

  it('volta da conversa pendente (id segurado até o primeiro result): 409 rewind_pending; depois do result, copia a conversa nova', async () => {
    const localId = await startMain(p1)
    const prev = process.env.FAKE_SESSION_ID
    process.env.FAKE_SESSION_ID = 'novo-0002'
    try {
      // "Editar a partir daqui": o id novo só vale no primeiro result.
      await manager.relaunch(localId, { resumeSessionId: 'fake-session-0001', extraArgs: ['--fork-session'], holdEngineId: true })
      await waitUntil(() => manager.liveSession(localId)?.sessionId === 'novo-0002')
      expect(manager.get(localId)?.engineSessionId).toBe('fake-session-0001')
      const res = await openSide(p1.id, { engine: 'claude', text: 'oi' })
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('rewind_pending')
      expect(sideOpts).toEqual([])
      expect(listSideThreads(db)).toEqual([])

      manager.send(localId, 'primeira')
      await waitUntil(() => manager.get(localId)?.engineSessionId === 'novo-0002')
      const ok = await openSide(p1.id, { engine: 'claude', text: 'oi' })
      expect(ok.statusCode, ok.body).toBe(201)
      expect(sideOpts[0].forkFrom).toEqual({ sourceId: 'novo-0002' })
    } finally {
      if (prev === undefined) delete process.env.FAKE_SESSION_ID
      else process.env.FAKE_SESSION_ID = prev
    }
  })

  it('corpo e motor inválidos: 400; projeto inexistente: 404', async () => {
    expect((await openSide(p1.id, { engine: 'nada' })).statusCode).toBe(400)
    expect((await openSide(p1.id, {})).statusCode).toBe(400)
    expect((await openSide(p1.id, { engine: 'claude', text: 5 })).statusCode).toBe(400)
    expect((await openSide(p1.id, { engine: 'claude', replace: 'sim' })).statusCode).toBe(400)
    expect((await message(p1.id, { engine: 'claude' })).statusCode).toBe(400)
    expect((await message(p1.id, { engine: 'claude', text: '   ' })).statusCode).toBe(400)
    expect((await getSide(p1.id, 'nada')).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p1.id}/side`, cookies: adminCookie })).statusCode).toBe(400)
    expect((await closeSide(p1.id, 'nada')).statusCode).toBe(400)
    expect((await interrupt(p1.id, {})).statusCode).toBe(400)
    expect((await getSide(9999)).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/projects/abc/side?engine=claude', cookies: adminCookie })).statusCode).toBe(400)
  })

  it('side_state e side_event chegam pelo broadcast com projectId', async () => {
    await startMain(p1)
    const side = (await openSide(p1.id, { engine: 'claude', text: 'oi lateral' })).json()
    await waitUntil(() => assistantTexts(p1.id).includes('eco: oi lateral'))
    const state = sideStates(p1.id)[0]
    expect(state).toMatchObject({ type: 'side_state', projectId: p1.id, engine: 'claude', side: { id: side.id } })
    const eco = sideEvents(p1.id).find((b) => b.event.kind === 'user')
    expect(eco).toMatchObject({ type: 'side_event', projectId: p1.id, engine: 'claude', sideId: side.id })
    expect(textOf(eco.event)).toBe('oi lateral')
    // Tudo da lateral sai com o projeto: o filtro por usuário do ws usa o `projectId`.
    const daLateral = broadcasts.filter((b) => b.type === 'side_state' || b.type === 'side_event')
    expect(daLateral.every((b) => b.projectId === p1.id)).toBe(true)
  })

  it('usuário sem acesso ao projeto: 403', async () => {
    await startMain(p2)
    const respostas = [
      await getSide(p2.id, 'claude', anaCookie),
      await openSide(p2.id, { engine: 'claude', text: 'oi' }, anaCookie),
      await message(p2.id, { engine: 'claude', text: 'oi' }, anaCookie),
      await interrupt(p2.id, { engine: 'claude' }, anaCookie),
      await closeSide(p2.id, 'claude', anaCookie),
    ]
    expect(respostas.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403])
    expect(sideOpts).toEqual([])
    // No projeto dela, a mesma usuária passa.
    expect((await getSide(p1.id, 'claude', anaCookie)).statusCode).toBe(200)
  })

  it('segundo POST sem replace: 409 side_exists; com replace: 201', async () => {
    await startMain(p1)
    const primeira = (await openSide(p1.id, { engine: 'claude', text: 'primeira' })).json()
    const segunda = await openSide(p1.id, { engine: 'claude', text: 'segunda' })
    expect(segunda.statusCode).toBe(409)
    expect(segunda.json().code).toBe('side_exists')
    const troca = await openSide(p1.id, { engine: 'claude', text: 'terceira', replace: true })
    expect(troca.statusCode).toBe(201)
    expect(troca.json().id).not.toBe(primeira.id)
    expect(troca.json().question).toBe('terceira')
    const atual = (await getSide(p1.id)).json()
    expect(atual.side.id).toBe(troca.json().id)
  })

  it('GET depois de recarregar devolve a lateral e os eventos', async () => {
    await startMain(p1)
    const side = (await openSide(p1.id, { engine: 'claude', text: 'resuma' })).json()
    await waitUntil(() => assistantTexts(p1.id).includes('eco: resuma'))
    const res = await getSide(p1.id)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.side).toMatchObject({ id: side.id, projectId: p1.id, engine: 'claude', question: 'resuma' })
    const user = body.events.find((e: any) => e.kind === 'user')
    expect(textOf(user)).toBe('resuma')
    expect(body.events.some((e: any) => e.kind === 'assistant' && textOf(e) === 'eco: resuma')).toBe(true)
    // Outro motor do mesmo terminal não tem lateral.
    expect((await getSide(p1.id, 'codex')).json()).toEqual({ side: null, events: [] })
  })

  it('lateral trabalhando: o desfazer bloqueia por ela e o marco do turno seguinte a conta', async () => {
    const r = makeRepo({ 'a.txt': 'a\n' })
    try {
      const p3 = createProjectsService(db).create({ name: 'Gama', path: r.dir })
      const localId = await startMain(p3)
      manager.send(localId, 'primeiro', { echo: true })
      await waitUntil(() => undo!.store.terminalTurns(p3.id, 'claude').some((t) => t.endedAt !== null))
      await undo!.idle()
      const [t1] = undo!.store.terminalTurns(p3.id, 'claude')
      expect((await undo!.service.preview([t1.id], { isAdmin: true, projectIds: 'all' })).blockedBy).toBeNull()

      expect((await openSide(p3.id, { engine: 'claude', text: 'oi' })).statusCode).toBe(201)
      await waitUntil(() => assistantTexts(p3.id).includes('eco: oi'))
      expect((await message(p3.id, { engine: 'claude', text: 'demorada' })).statusCode).toBe(204)
      await waitUntil(() => branch!.side.working().length === 1)
      expect((await undo!.service.preview([t1.id], { isAdmin: true, projectIds: 'all' })).blockedBy).toEqual({ kind: 'side', terminal: 'Gama' })

      // O turno seguinte da principal abre com a lateral no intervalo.
      manager.send(localId, 'segundo', { echo: true })
      await waitUntil(() => undo!.store.terminalTurns(p3.id, 'claude').length === 2)
      await undo!.idle()
      const t2 = undo!.store.terminalTurns(p3.id, 'claude')[1]
      expect(undo!.store.mark(undo!.store.turn(t2.id)!.startMark!)!.active).toContain(SIDE_ACTIVE)

      expect((await interrupt(p3.id, { engine: 'claude' })).statusCode).toBe(204)
      await waitUntil(() => branch!.side.working().length === 0)
      await waitUntil(() => undo!.store.terminalTurns(p3.id, 'claude').every((t) => t.endedAt !== null))
      await undo!.idle()
      expect((await undo!.service.preview([t1.id], { isAdmin: true, projectIds: 'all' })).blockedBy).toBeNull()
    } finally {
      await branch?.dispose()
      await manager.stopAll()
      r.cleanup()
    }
  })

  it('o desfazer segurando a pasta ou voltando a conversa: a mensagem da lateral recusa com o código dele (409)', async () => {
    await startMain(p1)
    expect((await openSide(p1.id, { engine: 'claude', text: 'oi' })).statusCode).toBe(201)
    await waitUntil(() => assistantTexts(p1.id).includes('eco: oi'))
    const escrita = vi.spyOn(undo!.service, 'holds').mockImplementation((p) => p === p1.id)
    const res = await message(p1.id, { engine: 'claude', text: 'e agora?' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('undo_writing')
    escrita.mockRestore()
    vi.spyOn(undo!.rewind, 'holds').mockImplementation((p, e) => p === p1.id && e === 'claude')
    const volta = await message(p1.id, { engine: 'claude', text: 'e agora?' })
    expect(volta.statusCode).toBe(409)
    expect(volta.json().code).toBe('rewind_in_progress')
    // Nada chegou à lateral.
    expect(sideEvents(p1.id).some((b) => textOf(b.event) === 'e agora?')).toBe(false)
    vi.restoreAllMocks()
    expect((await message(p1.id, { engine: 'claude', text: 'e agora?' })).statusCode).toBe(204)
  })

  it('parar a sessão principal pela rota de stop publica side: null', async () => {
    const localId = await startMain(p1)
    const side = (await openSide(p1.id, { engine: 'claude', text: 'oi' })).json()
    expect(side.id).toBeTruthy()
    const stop = await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop`, cookies: adminCookie })
    expect(stop.statusCode).toBe(204)
    await waitUntil(() => sideStates(p1.id).at(-1)?.side === null)
    expect((await getSide(p1.id)).json()).toEqual({ side: null, events: [] })
    await waitUntil(() => listSideThreads(db).length === 0)
  })
})
