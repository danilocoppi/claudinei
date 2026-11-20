import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
import { createProjectsService, type Project } from '../src/projects.js'
import { createTerminalStateStore, type TerminalStateStore } from '../src/restart/terminal-state.js'
import { captureShutdown } from '../src/restart/capture.js'
import { RESUME_PREFIX, type RestartService } from '../src/restart/boot.js'
import type { UsageLimitService } from '../src/limit/usage-limit.js'
import type { OrchestratorHooks } from '../src/routes/orchestrator.js'
import type { NextSend } from '../src/queue/next-send.js'
import type { OperatorQueueService } from '../src/queue/operator-queue.js'

/**
 * Rotas da fila do operador, com o manager real e o CLI falso, amarradas como em
 * index.ts: o árbitro do próximo envio entrega um item por turno, o aviso aberto
 * segura, e o encerramento do serviço não pausa a fila.
 */
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
/**
 * `initTardio`: o CLI só emite o init junto da 1ª mensagem, como a CLI real
 * retomando uma conversa: a sessão revivida fica em `starting` até alguém falar.
 */
let initTardio = false
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: initTardio ? [FAKE, '--init-tardio'] : [FAKE] })

const waitUntil = (cond: () => boolean, ms = 5000) => new Promise<void>((res, rej) => {
  const t0 = Date.now()
  const i = setInterval(() => {
    if (cond()) { clearInterval(i); res() } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')) }
  }, 10)
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

let db: Db
let auth: AuthService
let store: TerminalStateStore
let p1: Project, p2: Project
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

/** Um "processo" do serviço: manager, app e as referências que index.ts amarra. */
interface Instance {
  app: Awaited<ReturnType<typeof buildApp>>
  manager: SessionManager
  mgrBroadcasts: any[]
  broadcasts: any[]
  restart?: RestartService
}
let inst: Instance
const instances: Instance[] = []

async function boot(): Promise<Instance> {
  const mgrBroadcasts: any[] = []
  const broadcasts: any[] = []
  let drain: OrchestratorHooks['drain'] | undefined
  let nextSend: NextSend | undefined
  let queue: OperatorQueueService | undefined
  let restart: RestartService | undefined
  let limit: UsageLimitService | undefined
  const both = (...calls: Array<() => void>) => { for (const c of calls) { try { c() } catch (err) { console.error(err) } } }
  const manager = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m),
    onSessionAvailable: (projectId, ctx) => {
      if (ctx && nextSend) nextSend.onSessionAvailable({ projectId, ...ctx })
      else drain?.(projectId)
    },
    onTurnResult: (projectId, engine, info) => both(
      () => restart?.onTurnResult(projectId, engine),
      () => limit?.onTurnResult(projectId, engine, info),
      () => queue?.onTurnResult(projectId, engine, info)),
    onOperatorMessage: (projectId, engine) => both(
      () => restart?.onOperatorMessage(projectId, engine),
      () => limit?.onOperatorMessage(projectId, engine)),
    onUsageLimit: (projectId, engine, p) => limit?.onUsageLimit(projectId, engine, p),
    onSessionDied: (projectId, engine) => queue?.onSessionDied(projectId, engine),
  })
  const app = await buildApp({
    config: loadConfig({}), db, manager, auth,
    wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as never,
    onOrchestratorReady: (o) => { drain = o.drain },
    onNextSendReady: (n) => { nextSend = n },
    onQueueReady: (q) => { queue = q },
    onRestartReady: (r) => { restart = r },
    onLimitReady: (l) => { limit = l },
  })
  const i: Instance = { app, manager, mgrBroadcasts, broadcasts, restart }
  instances.push(i)
  return i
}

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  store = createTerminalStateStore(db)
  initTardio = false
  instances.length = 0
  inst = await boot()
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'oqr1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'oqr2-')) })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1.id] })
  adminCookie = cookieOf(await inst.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
  anaCookie = cookieOf(await inst.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
})

afterEach(async () => {
  for (const i of instances) {
    await i.manager.stopAll()
    await i.app.close()
  }
})

const url = (pid: number, rest = '', engine = 'claude') => `/api/projects/${pid}/terminals/${engine}/queue${rest}`
const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: object, cookies = adminCookie) =>
  inst.app.inject({ method, url: path, cookies, ...(payload ? { payload } : {}) })
const add = (pid: number, text: string, cookies = adminCookie) => req('POST', url(pid), { text }, cookies)

/** Textos que entraram no chat da sessão, na ordem (eco do usuário). */
const userTexts = (i: Instance, localId?: string) => i.mgrBroadcasts
  .filter((b) => b.type === 'session_event' && (!localId || b.localId === localId) && b.event?.kind === 'user')
  .map((b) => String(b.event.message?.content?.[0]?.text ?? ''))
  .filter((t) => t)

async function startIdle(i: Instance, project: Project): Promise<string> {
  const { localId } = i.manager.start(project)
  await waitUntil(() => i.manager.get(localId)?.status === 'idle')
  // O "livre" do arranque já passou pelo árbitro.
  await sleep(20)
  return localId
}

describe('rotas da fila do operador', () => {
  it('CRUD da fila com acesso por projeto (403 para quem não tem)', async () => {
    expect((await req('GET', url(p1.id))).json()).toEqual({ projectId: p1.id, engine: 'claude', items: [], paused: false, pauseReason: null })

    const r1 = await add(p1.id, 'primeira')
    expect(r1.statusCode).toBe(201)
    expect(r1.json().items.map((i: any) => i.text)).toEqual(['primeira'])
    const r2 = await add(p1.id, 'segunda', anaCookie)
    expect(r2.statusCode).toBe(201)
    const [a, b] = r2.json().items as Array<{ id: number }>

    const edited = await req('PATCH', url(p1.id, `/${a.id}`), { text: 'primeira editada' })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().items[0]).toMatchObject({ id: a.id, text: 'primeira editada' })

    const reordered = await req('PUT', url(p1.id, '/order'), { ids: [b.id, a.id] })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().items.map((i: any) => i.id)).toEqual([b.id, a.id])

    const removed = await req('DELETE', url(p1.id, `/${b.id}`))
    expect(removed.statusCode).toBe(200)
    expect(removed.json().items.map((i: any) => i.id)).toEqual([a.id])

    const paused = await req('POST', url(p1.id, '/pause'))
    expect(paused.json()).toMatchObject({ paused: true, pauseReason: 'manual' })
    const resumed = await req('POST', url(p1.id, '/resume'))
    expect(resumed.json()).toMatchObject({ paused: false, pauseReason: null })

    // Cada mudança vai às telas.
    expect(inst.broadcasts.filter((m) => m.type === 'operator_queue' && m.projectId === p1.id).length).toBeGreaterThanOrEqual(6)

    // Erros de tela: 400 com código.
    const empty = await add(p1.id, '   ')
    expect(empty.statusCode).toBe(400)
    expect(empty.json().code).toBe('queue_item_empty')
    const mismatch = await req('PUT', url(p1.id, '/order'), { ids: [999] })
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.json().code).toBe('queue_order_mismatch')
    // Sem sessão viva, o "enviar agora" é recusado.
    const now = await req('POST', url(p1.id, `/${a.id}/send-now`))
    expect(now.statusCode).toBe(400)
    expect(now.json().code).toBe('session_not_active')

    // Motor desconhecido, projeto que não existe, id malformado.
    const unknown = await req('GET', url(p1.id, '', 'nope'))
    expect(unknown.statusCode).toBe(400)
    // O mesmo formato dos outros erros: texto, código e parâmetros.
    expect(unknown.json()).toEqual({ error: 'motor desconhecido: nope', code: 'unknown_engine', params: { engine: 'nope' } })
    expect((await req('GET', url(9999))).statusCode).toBe(404)
    expect((await req('PATCH', url(p1.id, '/abc'), { text: 'x' })).statusCode).toBe(400)

    // Quem não tem acesso ao projeto: 403 em todas, e nada muda.
    await add(p2.id, 'de Beta')
    const before = (await req('GET', url(p2.id))).json()
    const itemB = before.items[0].id
    for (const res of [
      await req('GET', url(p2.id), undefined, anaCookie),
      await add(p2.id, 'intrusa', anaCookie),
      await req('PATCH', url(p2.id, `/${itemB}`), { text: 'x' }, anaCookie),
      await req('PUT', url(p2.id, '/order'), { ids: [itemB] }, anaCookie),
      await req('DELETE', url(p2.id, `/${itemB}`), undefined, anaCookie),
      await req('POST', url(p2.id, `/${itemB}/send-now`), undefined, anaCookie),
      await req('POST', url(p2.id, '/pause'), undefined, anaCookie),
      await req('POST', url(p2.id, '/resume'), undefined, anaCookie),
    ]) expect(res.statusCode).toBe(403)
    expect((await req('GET', url(p2.id))).json()).toEqual(before)
  })

  it('item de outro terminal na URL dá 404', async () => {
    const { items: [item] } = (await add(p1.id, 'de Alfa/claude')).json()
    const other = [
      url(p1.id, `/${item.id}`, 'codex'),
      url(p2.id, `/${item.id}`),
    ]
    for (const path of other) {
      for (const res of [
        await req('PATCH', path, { text: 'x' }),
        await req('DELETE', path),
        await req('POST', `${path}/send-now`),
      ]) {
        expect(res.statusCode).toBe(404)
        expect(res.json().code).toBe('queue_item_not_found')
      }
    }
    // Item que não existe também.
    const gone = await req('DELETE', url(p1.id, '/99999'))
    expect(gone.statusCode).toBe(404)
    expect(gone.json().code).toBe('queue_item_not_found')
    // Nada mudou no terminal dono do item.
    expect((await req('GET', url(p1.id))).json().items).toEqual([item])
  })

  it('turno longo + item na fila: entrega quando o turno acaba e ecoa no chat', async () => {
    const localId = await startIdle(inst, p1)
    inst.manager.send(localId, 'devagar longo')
    const res = await add(p1.id, 'na fila')
    expect(res.statusCode).toBe(201)
    // A sessão está trabalhando: o item fica.
    expect(res.json().items.map((i: any) => i.text)).toEqual(['na fila'])

    await waitUntil(() => userTexts(inst, localId).includes('na fila'))
    // Saiu da fila, depois do result do turno longo, e o turno dele também roda.
    expect((await req('GET', url(p1.id))).json().items).toEqual([])
    const events = inst.mgrBroadcasts.filter((b) => b.type === 'session_event' && b.localId === localId)
    const firstResult = events.findIndex((b) => b.event?.kind === 'result')
    const echo = events.findIndex((b) => b.event?.kind === 'user' && b.event.message?.content?.[0]?.text === 'na fila')
    expect(firstResult).toBeGreaterThan(-1)
    expect(echo).toBeGreaterThan(firstResult)
    await waitUntil(() => events.length > 0 && inst.mgrBroadcasts.some((b) =>
      b.type === 'session_event' && b.event?.kind === 'result' && String(b.event.resultText ?? '').includes('eco: na fila')))
  })

  it('com o terminal interrompido (aviso aberto) nada é entregue; × no aviso entrega', async () => {
    const localId = await startIdle(inst, p1)
    inst.manager.send(localId, 'oi')
    await waitUntil(() => inst.manager.get(localId)?.status === 'needs_attention')
    store.markInterrupted(p1.id, 'claude', localId, null)
    await add(p1.id, 'espera o aviso')
    // Um "livre" com o aviso aberto (o operador leu a conversa) também não entrega.
    inst.manager.markRead(localId)
    await sleep(80)
    expect((await req('GET', url(p1.id))).json().items.map((i: any) => i.text)).toEqual(['espera o aviso'])
    expect(userTexts(inst, localId)).not.toContain('espera o aviso')

    const res = await inst.app.inject({ method: 'DELETE', url: `/api/projects/${p1.id}/terminals/claude/interruption`, cookies: adminCookie })
    expect(res.statusCode).toBe(200)
    await waitUntil(() => userTexts(inst, localId).includes('espera o aviso'))
    expect((await req('GET', url(p1.id))).json()).toMatchObject({ items: [], paused: false })
  })

  it('sessão revivida na subida, parada em starting: × entrega o item da fila e a tarefa de outro agente', async () => {
    // "Iniciar" ligado e "retomar" desligado: a subida revive a sessão e abre o aviso.
    initTardio = true
    const prev = randomUUID()
    db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status) VALUES (?, ?, 'claude', 'stopped')`).run(prev, p1.id)
    store.setPrefs(p1.id, 'claude', { autostart: true, autoResume: false })
    store.markInterrupted(p1.id, 'claude', prev, null)
    await inst.restart!.boot()
    expect(store.get(p1.id, 'claude').holdReason).toBe('off')
    const localId = inst.manager.list().find((s) => s.projectId === p1.id && s.engine === 'claude')!.localId
    expect(inst.manager.get(localId)?.status).toBe('starting')

    await add(p1.id, 'guardado na subida')
    const { id: taskId } = (await inst.app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch', cookies: adminCookie,
      payload: { fromProjectId: p2.id, toProjectName: 'Alfa', description: 'tarefa guardada' },
    })).json()
    await sleep(50)
    expect(userTexts(inst, localId)).toEqual([])
    expect(inst.manager.get(localId)?.status).toBe('starting')

    const res = await inst.app.inject({ method: 'DELETE', url: `/api/projects/${p1.id}/terminals/claude/interruption`, cookies: adminCookie })
    expect(res.statusCode).toBe(200)
    // Lugar 3 primeiro; a tarefa (lugar 5) vai no "livre" seguinte.
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as any)?.status === 'completed')
    const texts = userTexts(inst, localId)
    expect(texts.indexOf('guardado na subida')).toBe(0)
    expect(texts.indexOf('[Task from Beta]: tarefa guardada')).toBeGreaterThan(0)
  })

  it('aviso do limite em none com a reabertura já passada segura até o operador fechar', async () => {
    const localId = await startIdle(inst, p1)
    // Limite que já reabriu, sem retomada armada: o aviso continua na tela.
    store.recordUsageLimit(p1.id, 'claude', { resetsAt: Math.floor(Date.now() / 1000) - 60, origin: 'operator' })
    expect(store.get(p1.id, 'claude').limitAction).toBe('none')
    // Sessão livre: o add tenta entregar na hora, e o aviso segura.
    await add(p1.id, 'depois do aviso do limite')
    // Outro terminal_state publicado (o ⚙ do terminal) cutuca o árbitro: segura de novo.
    const patch = await inst.app.inject({
      method: 'PATCH', url: `/api/projects/${p1.id}/terminals/claude/restart`, cookies: adminCookie, payload: { autostart: true },
    })
    expect(patch.statusCode).toBe(200)
    await sleep(80)
    expect(userTexts(inst, localId)).not.toContain('depois do aviso do limite')
    expect(store.get(p1.id, 'claude').limitHitAt).not.toBeNull()

    const res = await inst.app.inject({
      method: 'POST', url: `/api/projects/${p1.id}/terminals/claude/limit`, cookies: adminCookie, payload: { action: 'cancel' },
    })
    expect(res.statusCode).toBe(200)
    await waitUntil(() => userTexts(inst, localId).includes('depois do aviso do limite'))
  })

  it('retomada do Claudinei (Continuar) vai antes da fila, que segue depois do turno dela', async () => {
    const localId = await startIdle(inst, p1)
    store.markInterrupted(p1.id, 'claude', localId, null)
    await add(p1.id, 'depois da retomada')
    const res = await inst.app.inject({ method: 'POST', url: `/api/projects/${p1.id}/terminals/claude/continue`, cookies: adminCookie })
    expect(res.statusCode).toBe(200)
    await waitUntil(() => userTexts(inst, localId).includes('depois da retomada'))
    const texts = userTexts(inst, localId)
    const resume = texts.findIndex((t) => t.startsWith(RESUME_PREFIX))
    expect(resume).toBeGreaterThan(-1)
    expect(resume).toBeLessThan(texts.indexOf('depois da retomada'))
    // O item só saiu depois do result do turno da retomada.
    const events = inst.mgrBroadcasts.filter((b) => b.type === 'session_event' && b.localId === localId)
    const resumeResult = events.findIndex((b) => b.event?.kind === 'result' && String(b.event.resultText ?? '').includes(RESUME_PREFIX))
    const echo = events.findIndex((b) => b.event?.kind === 'user' && b.event.message?.content?.[0]?.text === 'depois da retomada')
    expect(resumeResult).toBeGreaterThan(-1)
    expect(echo).toBeGreaterThan(resumeResult)
  })

  it('stopAll do encerramento não pausa a fila', async () => {
    store.setPrefs(p1.id, 'claude', { autoResume: true })
    const localId = await startIdle(inst, p1)
    inst.manager.send(localId, 'demorada até o reinício')
    await waitUntil(() => inst.manager.get(localId)?.status === 'working')
    await add(p1.id, 'sobrevive ao reinício')

    // O encerramento do serviço, como no SIGTERM de index.ts.
    expect(captureShutdown(inst.manager, store)).toBe(1)
    await inst.manager.stopAll()
    expect((await req('GET', url(p1.id))).json()).toMatchObject({
      items: [expect.objectContaining({ text: 'sobrevive ao reinício' })], paused: false, pauseReason: null,
    })
    await inst.app.close()
    instances.splice(instances.indexOf(inst), 1)

    // Depois da subida: a retomada do Claudinei primeiro, e a fila segue depois do turno dela.
    inst = await boot()
    await inst.restart!.boot()
    await waitUntil(() => userTexts(inst).includes('sobrevive ao reinício'))
    const texts = userTexts(inst)
    expect(texts.findIndex((t) => t.startsWith(RESUME_PREFIX))).toBeGreaterThan(-1)
    expect(texts.findIndex((t) => t.startsWith(RESUME_PREFIX))).toBeLessThan(texts.indexOf('sobrevive ao reinício'))
    expect((await req('GET', url(p1.id))).json()).toMatchObject({ items: [], paused: false })
  })
})
