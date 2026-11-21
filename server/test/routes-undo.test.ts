import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager, type SessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { startAfterListen } from '../src/restart/boot.js'
import type { NextSend } from '../src/queue/next-send.js'
import type { Scheduler } from '../src/schedules/scheduler.js'
import { createSchedulesStore } from '../src/schedules/store.js'
import { runRetention } from '../src/undo/retention.js'
import type { Undo } from '../src/undo/index.js'
import { createUndoStore } from '../src/undo/store.js'
import { createTurnTracker } from '../src/undo/tracker.js'
import { createRepoResolver, type RepoInfo } from '../src/checkpoint/repo.js'
import { createSerialQueue } from '../src/checkpoint/serial.js'
import type { UndoCtx } from '../src/undo/types.js'
import type { AgentEvent } from '../src/engine/types.js'
import { makeRepo, makeTempDir } from './helpers/git-repo.js'
import '../src/engine/index.js'

// A retenção real, contada: a subida do conjunto a roda uma vez.
vi.mock('../src/undo/retention.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/undo/retention.js')>()
  return { ...mod, runRetention: vi.fn(mod.runRetention) }
})

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let db: Db
let auth: AuthService
let manager: SessionManager
let app: Awaited<ReturnType<typeof buildApp>>
let undo: Undo
let nextSend: NextSend | undefined
let scheduler: Scheduler | undefined
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>
const cleanups: Array<() => void> = []

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }): Record<string, string> => {
  const c = res.cookies.find(x => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

function repo(files: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n' }) {
  const r = makeRepo(files)
  cleanups.push(r.cleanup)
  return r
}

/** Terminal parado no banco (sem processo): o que a rota de turnos lê do manager. */
function session(projectId: number, localId: string, conversation: string | null = null, engine = 'claude'): UndoCtx {
  db.prepare(`INSERT INTO sessions (local_id, claude_session_id, project_id, status, engine) VALUES (?, ?, ?, 'stopped', ?)`)
    .run(localId, conversation, projectId, engine)
  return { localId, projectId, engine }
}

const info = (conversation: string | null = 'S1') => ({ compaction: () => false, engineSessionId: conversation, shuttingDown: false })
const result: AgentEvent = { kind: 'result', subtype: 'success', isError: false, resultText: '', costUsd: 0, raw: {} }

async function turn(ctx: UndoCtx, work: () => void = () => {}, conversation: string | null = 'S1'): Promise<number> {
  const t = undo.tracker
  t.onInput(ctx, 'trabalha', 'operator', () => t.onStatus(ctx, 'working', info(conversation)))
  const id = t.openSegment(ctx.localId)!
  await t.idle()
  work()
  t.onStatus(ctx, 'idle', info(conversation))
  t.onEvent(ctx, result)
  await t.idle()
  return id
}

const get = (url: string, cookies = adminCookie) => app.inject({ method: 'GET', url, cookies })
const post = (url: string, payload: object, cookies = adminCookie) => app.inject({ method: 'POST', url, cookies, payload })

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: fakeFactory })
  nextSend = undefined
  scheduler = undefined
  vi.mocked(runRetention).mockClear()
  app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    onUndoReady: (u) => { undo = u },
    onNextSendReady: (n) => { nextSend = n },
    onSchedulerReady: (s) => { scheduler = s },
  })
})

async function users(projectIds: number[]) {
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
}

afterEach(async () => {
  await undo?.idle()
  await manager.stopAll()
  await app.close()
  for (const c of cleanups.splice(0).reverse()) c()
})

describe('rotas do desfazer', () => {
  it('não-admin sem acesso ao projeto: 403 em todas as rotas', async () => {
    const r1 = repo()
    const r2 = repo()
    const projects = createProjectsService(db)
    const alfa = projects.create({ name: 'Alfa', path: r1.dir })
    const beta = projects.create({ name: 'Beta', path: r2.dir })
    await users([alfa.id])
    const B = session(beta.id, 'LB')
    const tb = await turn(B, () => r2.write('a.txt', 'mudou\n'))
    const preview = (await post('/api/undo/preview', { turnIds: [tb] })).json()
    const run = (await post('/api/undo/apply', { turnIds: [tb], token: preview.token, decisions: {} })).json()
    expect(run.kind).toBe('undo')
    const marks = db.prepare(`SELECT id FROM undo_marks ORDER BY n`).all() as Array<{ id: number }>

    for (const [method, url, payload] of [
      ['GET', `/api/undo/terminals/LB/turns`],
      ['GET', `/api/undo/turns/${tb}/files`],
      ['GET', `/api/undo/turns/${tb}/diff?path=a.txt`],
      ['GET', `/api/undo/intervals/${marks[0].id}/${marks[1].id}/files?localId=LB`],
      ['GET', `/api/undo/intervals/${marks[0].id}/${marks[1].id}/diff?localId=LB&path=a.txt`],
      ['POST', '/api/undo/preview', { turnIds: [tb] }],
      ['POST', '/api/undo/apply', { turnIds: [tb], token: preview.token, decisions: {} }],
      ['POST', `/api/undo/runs/${run.id}/redo/preview`, {}],
      ['POST', `/api/undo/runs/${run.id}/redo`, { token: 'x', decisions: {} }],
    ] as const) {
      const res = await app.inject({ method, url, cookies: anaCookie, ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    // Um id alheio junto de um inexistente: 403, como o alheio sozinho (o acesso vem antes do 404).
    for (const url of ['/api/undo/preview', '/api/undo/apply']) {
      const mixed = await post(url, { turnIds: [99999, tb], token: 'x', decisions: {} }, anaCookie)
      expect(mixed.statusCode, url).toBe(403)
    }
    // O admin vê.
    expect((await get(`/api/undo/turns/${tb}/files`)).statusCode).toBe(200)
  })

  it('não-admin com acesso: arquivos fora da pasta do projeto viram hiddenOutside', async () => {
    const r = repo({ 'sub/x.txt': 'x\n', 'fora.txt': 'f\n' })
    const projects = createProjectsService(db)
    const p = projects.create({ name: 'Sub', path: join(r.dir, 'sub') })
    await users([p.id])
    const S = session(p.id, 'LS')
    const t = await turn(S, () => {
      r.write('sub/x.txt', 'x mudou\n')
      r.write('fora.txt', 'f mudou\n')
    })

    const ana = (await get(`/api/undo/turns/${t}/files`, anaCookie)).json()
    expect(ana.files.map((f: { path: string }) => f.path)).toEqual(['sub/x.txt'])
    expect(ana.hiddenOutside).toBe(1)
    expect(ana.warnings).toEqual([])
    const admin = (await get(`/api/undo/turns/${t}/files`)).json()
    expect(admin.files.map((f: { path: string }) => f.path)).toEqual(['fora.txt', 'sub/x.txt'])
    expect(admin.hiddenOutside).toBe(0)

    const diff = await get(`/api/undo/turns/${t}/diff?path=fora.txt`, anaCookie)
    expect(diff.statusCode).toBe(403)
    expect(diff.json().code).toBe('forbidden_path')
    const mine = await get(`/api/undo/turns/${t}/diff?path=${encodeURIComponent('sub/x.txt')}`, anaCookie)
    expect(mine.statusCode).toBe(200)
    expect(mine.json().text).toContain('+x mudou')

    const preview = (await post('/api/undo/preview', { turnIds: [t] }, anaCookie)).json()
    expect(preview.files.map((f: { path: string }) => f.path)).toEqual(['sub/x.txt'])
    expect(preview.hiddenOutside).toBe(1)
  })

  it('apply com turnos de dois terminais: 400', async () => {
    const r = repo()
    const projects = createProjectsService(db)
    const a = projects.create({ name: 'A', path: r.dir })
    const b = projects.create({ name: 'B', path: r.dir })
    await users([a.id, b.id])
    const ta = await turn(session(a.id, 'LA'), () => r.write('a.txt', '1\n'))
    const tb = await turn(session(b.id, 'LB'), () => r.write('b.txt', '2\n'))
    for (const url of ['/api/undo/preview', '/api/undo/apply']) {
      const res = await post(url, { turnIds: [ta, tb], token: 'x', decisions: {} })
      expect(res.statusCode, url).toBe(400)
      expect(res.json().code).toBe('undo_mixed_terminals')
    }
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('1\n')
    // Corpo inválido e turno inexistente.
    expect((await post('/api/undo/preview', { turnIds: 'x' })).statusCode).toBe(400)
    expect((await post('/api/undo/preview', { turnIds: [999] })).statusCode).toBe(404)
  })

  it('apply com token velho: 409 com a prévia nova; com o novo desfaz, e o refazer volta', async () => {
    const r = repo()
    const projects = createProjectsService(db)
    const a = projects.create({ name: 'A', path: r.dir })
    await users([a.id])
    const A = session(a.id, 'LA')
    const t = await turn(A, () => r.write('a.txt', 'do turno\n'))
    const old = (await post('/api/undo/preview', { turnIds: [t] })).json()
    r.write('b.txt', 'nada a ver\n')
    r.write('a.txt', 'o editor salvou\n')

    const stale = await post('/api/undo/apply', { turnIds: [t], token: old.token, decisions: {} })
    expect(stale.statusCode).toBe(409)
    const body = stale.json()
    expect(body.code).toBe('undo_changed')
    expect(body.preview.token).not.toBe(old.token)
    expect(body.preview.files[0]).toMatchObject({ path: 'a.txt', verdict: 'conflict' })
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('o editor salvou\n')

    const done = await post('/api/undo/apply', { turnIds: [t], token: body.preview.token, decisions: { 'a.txt': 'force' } })
    expect(done.statusCode).toBe(200)
    expect(done.json().files).toEqual([{ path: 'a.txt', result: 'forced' }])
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a\n')

    const runId = done.json().id
    const redoPreview = (await post(`/api/undo/runs/${runId}/redo/preview`, {})).json()
    const redo = await post(`/api/undo/runs/${runId}/redo`, { token: redoPreview.token, decisions: {} })
    expect(redo.statusCode).toBe(200)
    expect(redo.json().kind).toBe('redo')
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('o editor salvou\n')
    const again = await post(`/api/undo/runs/${runId}/redo`, { token: redoPreview.token, decisions: {} })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('undo_already_redone')
    expect((await post('/api/undo/runs/9999/redo/preview', {})).statusCode).toBe(404)
  })

  it('turns separa conversa atual, fora da conversa e interativos', async () => {
    const r = repo()
    const projects = createProjectsService(db)
    const a = projects.create({ name: 'A', path: r.dir })
    await users([a.id])
    const A = session(a.id, 'LA', 'S2')
    const old = await turn(A, () => r.write('a.txt', '1\n'), 'S1')
    const cur = await turn(A, () => r.write('a.txt', '2\n'), 'S2')
    // Sem conversa registrada (o motor não deu id): conta como da conversa atual (R2).
    const nul = await turn(A, () => r.write('b.txt', 'sem conversa\n'), null)
    expect(undo.store.turn(nul)!.conversationId).toBeNull()
    const rewound = await turn(A, () => r.write('a.txt', '3\n'), 'S2')
    undo.store.markRewound([rewound])
    undo.tracker.onInteractive(A, 'open')
    await undo.tracker.idle()
    r.write('b.txt', 'no terminal\n')
    undo.tracker.onInteractive(A, 'close')
    await undo.tracker.idle()
    const inter = undo.store.terminalTurns(a.id, 'claude').find(x => x.origin === 'interactive')!.id
    // Fora de turno: muda entre dois turnos (vira intervalo), e um intervalo vazio não aparece.
    r.write('a.txt', 'fora de turno\n')
    const last = await turn(A, () => {}, 'S2')

    const res = await get('/api/undo/terminals/LA/turns', anaCookie)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.git).toBe(true)
    expect(body.turns.map((x: { id: number }) => x.id)).toEqual([cur, nul, last])
    expect(body.outside.map((x: { id: number }) => x.id)).toEqual([old, rewound])
    expect(body.interactive.map((x: { id: number }) => x.id)).toEqual([inter])
    expect(body.turns[0].summary).toMatchObject({ files: 1 })
    // Só o intervalo com mudança (o fim do interativo → o início do último turno).
    expect(body.intervals).toHaveLength(1)
    const iv = body.intervals[0]
    expect(iv.kind).toBe('between')
    expect(typeof iv.at).toBe('string')
    const files = (await get(`/api/undo/intervals/${iv.from}/${iv.to}/files?localId=LA`, anaCookie)).json()
    expect(files.files.map((f: { path: string }) => f.path)).toEqual(['a.txt'])
    expect(files.hiddenOutside).toBe(0)
    const diff = (await get(`/api/undo/intervals/${iv.from}/${iv.to}/diff?localId=LA&path=a.txt`, anaCookie)).json()
    expect(diff.text).toContain('+fora de turno')

    expect((await get('/api/undo/terminals/nao-existe/turns')).statusCode).toBe(404)
  })

  it('terminal sem git: git false e listas vazias', async () => {
    const projects = createProjectsService(db)
    const dir = makeTempDir('claudinei-sem-git-')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const a = projects.create({ name: 'A', path: dir })
    session(a.id, 'LA')
    const body = (await app.inject({ method: 'GET', url: '/api/undo/terminals/LA/turns' })).json()
    expect(body).toEqual({ git: false, turns: [], outside: [], interactive: [], intervals: [] })
  })
})

describe('ligação no servidor', () => {
  it('subida fecha turno aberto como uncertain antes de religar as sessões', async () => {
    const r = repo()
    const projects = createProjectsService(db)
    const a = projects.create({ name: 'A', path: r.dir })
    // O processo anterior abriu um turno e caiu.
    const store = createUndoStore(db)
    const before = createTurnTracker({
      store, resolver: createRepoResolver(), queue: createSerialQueue(),
      projectPath: id => projects.get(id)?.path ?? null, log: () => {},
    })
    const ctx: UndoCtx = { localId: 'LA', projectId: a.id, engine: 'claude' }
    before.onInput(ctx, 'trabalha', 'operator', () => before.onStatus(ctx, 'working', info()))
    const open = before.openSegment('LA')!
    await before.idle()

    let seen: string | null | undefined
    await startAfterListen({
      undo,
      restart: { boot: async () => { seen = store.turn(open)?.endKind } },
      scheduler: undefined,
    })
    expect(seen).toBe('uncertain')
    expect(store.turn(open)!.endMark).not.toBeNull()
  })

  it('a subida do conjunto roda a retenção uma vez (o turno de 31 dias some)', async () => {
    const r = repo()
    const projects = createProjectsService(db)
    const a = projects.create({ name: 'A', path: r.dir })
    const A = session(a.id, 'LA')
    const old = await turn(A, () => r.write('a.txt', 'velho\n'))
    const kept = await turn(A, () => r.write('a.txt', 'novo\n'))
    db.prepare(`UPDATE undo_turns SET ended_at = datetime('now', '-31 days') WHERE id = ?`).run(old)
    expect(runRetention).not.toHaveBeenCalled()

    await undo.boot()
    await undo.idle()
    expect(runRetention).toHaveBeenCalledTimes(1)
    expect(undo.store.turn(old)).toBeUndefined()
    expect(undo.store.turn(kept)).toBeDefined()
  })

  it('holds do árbitro verdadeiro durante a escrita; o fim cutuca o terminal do repositório', async () => {
    const r = repo()
    const projects = createProjectsService(db)
    const a = projects.create({ name: 'A', path: r.dir })
    // Sessão viva (CLI falso) no projeto: o ask_agent passa pelo `holds` do app.
    const created = await app.inject({ method: 'POST', url: `/api/projects/${a.id}/sessions`, payload: {} })
    expect(created.statusCode).toBe(201)
    const localId = created.json().localId as string
    const A: UndoCtx = { localId, projectId: a.id, engine: 'claude' }
    const t = await turn(A, () => r.write('a.txt', 'do turno\n'))
    const preview = (await app.inject({ method: 'POST', url: '/api/undo/preview', payload: { turnIds: [t] } })).json()

    // Segura a escrita logo antes do marco "antes do desfazer".
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    let reached!: () => void
    const atGate = new Promise<void>(res => { reached = res })
    const original = undo.tracker.takeMark
    undo.tracker.takeMark = async (repoInfo: RepoInfo, kind) => {
      if (kind === 'undo_pre') { reached(); await gate }
      return original(repoInfo, kind)
    }
    const poke = vi.spyOn(nextSend!, 'poke')

    const applying = app.inject({ method: 'POST', url: '/api/undo/apply', payload: { turnIds: [t], token: preview.token, decisions: {} } })
    await atGate
    expect(undo.holds(a.id, 'claude')).toBe(true)
    const ask = await app.inject({ method: 'POST', url: '/api/hermes/ask', payload: { toProjectName: 'A', question: 'oi?' } })
    expect(ask.statusCode).toBe(400)
    expect(ask.json().error).toContain('notice open')
    // O agendador também espera (R19): a execução é pulada sem contar falha, em vez
    // de bater no `undo_writing` do rastreador e virar erro.
    const schedDir = mkdtempSync(join(tmpdir(), 'claudinei-sched-'))
    cleanups.push(() => rmSync(schedDir, { recursive: true, force: true }))
    const sched = createSchedulesStore(db, { dir: schedDir })
      .create(a.id, { name: 'Tarefa', task: 'faz algo', cadence: { kind: 'daily', at: '12:00' } })
    await scheduler!.runNow(sched.id)
    const [schedRun] = createSchedulesStore(db, { dir: schedDir }).listRuns(sched.id, 1)
    expect(schedRun.status).toBe('skipped')
    expect(createSchedulesStore(db, { dir: schedDir }).get(sched.id)!.consecutiveFailures).toBe(0)
    expect(poke).not.toHaveBeenCalled()

    release()
    expect((await applying).statusCode).toBe(200)
    expect(undo.holds(a.id, 'claude')).toBe(false)
    await new Promise(res => setImmediate(res))
    expect(poke).toHaveBeenCalledWith(a.id, 'claude')
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('a\n')
  })
})
