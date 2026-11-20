import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrchestratorHooks } from '../src/routes/orchestrator.js'
import type { NextSend } from '../src/queue/next-send.js'
import type { OperatorQueueService } from '../src/queue/operator-queue.js'
import { createTasksService } from '../src/tasks.js'
import { createTerminalStateStore } from '../src/restart/terminal-state.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let fromId: number
let toId: number
let broadcasts: object[]
let manager: ReturnType<typeof createSessionManager>
let orchestrator: OrchestratorHooks | undefined
let mgrBroadcasts: any[]

beforeEach(async () => {
  db = openDb(':memory:')
  broadcasts = []
  mgrBroadcasts = []
  // Mesma amarração de index.ts: o manager nasce antes do orchestrator, da fila
  // e do árbitro existirem, então os ganchos leem referências mutáveis que os
  // on…Ready preenchem assim que buildApp registra as rotas.
  orchestrator = undefined
  let nextSend: NextSend | undefined
  let queue: OperatorQueueService | undefined
  manager = createSessionManager({
    db, sessionFactory: fakeFactory, broadcast: (m) => mgrBroadcasts.push(m),
    onSessionAvailable: (projectId, ctx) => {
      if (ctx && nextSend) nextSend.onSessionAvailable({ projectId, ...ctx })
      else orchestrator?.drain(projectId)
    },
    onTurnResult: (projectId, engine, info) => queue?.onTurnResult(projectId, engine, info),
    onSessionDied: (projectId, engine) => queue?.onSessionDied(projectId, engine),
  })
  app = await buildApp({
    config: loadConfig({}), db, manager,
    wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as any,
    onOrchestratorReady: (o) => { orchestrator = o },
    onNextSendReady: (n) => { nextSend = n },
    onQueueReady: (q) => { queue = q },
  })

  const from = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'Origem', path: mkdtempSync(join(tmpdir(), 'tm-')) },
  })
  fromId = from.json().id

  const to = await app.inject({
    method: 'POST', url: '/api/projects',
    payload: { name: 'Destino', path: mkdtempSync(join(tmpdir(), 'tm-')) },
  })
  toId = to.json().id
})

describe('rotas orchestrator', () => {
  it('POST /api/orchestrator/dispatch happy path: cria tarefa e, após resposta do alvo, ela fica completed', async () => {
    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })

    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'faça algo' },
    })
    expect(res.statusCode).toBe(200)
    const { id } = res.json()
    expect(typeof id).toBe('number')

    // logo após o dispatch a tarefa está in_progress
    const rowNow = db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any
    expect(rowNow.status).toBe('in_progress')
    expect(broadcasts.some((b: any) => b.type === 'task_update' && b.task.id === id && b.task.status === 'in_progress')).toBe(true)

    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any
      return row?.status === 'completed'
    })
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as any
    expect(row.result).toMatch(/eco: \[Task from Origem\]: faça algo/)
    expect(broadcasts.some((b: any) => b.type === 'task_update' && b.task.id === id && b.task.status === 'completed')).toBe(true)

    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('POST /api/orchestrator/dispatch com projeto alvo desconhecido retorna 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Não Existe', description: 'faça algo' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBeTruthy()
  })

  it('POST /api/orchestrator/dispatch sem sessão ativa no alvo: cria a tarefa como queued (não falha)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'faça algo' },
    })
    expect(res.statusCode).toBe(200)
    const { id } = res.json()
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as any
    expect(row.status).toBe('queued')
    expect(row.result).toBeNull()
    expect(broadcasts.some((b: any) => b.type === 'task_update' && b.task.id === id && b.task.status === 'queued')).toBe(true)
  })

  it('POST /api/orchestrator/dispatch com alvo ocupado (working): cria a tarefa como queued', async () => {
    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status === 'idle')

    // ocupa o alvo com um turno "demorada" (nunca emite result sozinho, só via interrupt)
    manager.send(localId, 'tarefa demorada')
    await waitUntil(() => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status === 'working')

    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'faça algo' },
    })
    expect(res.statusCode).toBe(200)
    const { id } = res.json()
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as any
    expect(row.status).toBe('queued')

    await manager.interrupt(localId)
    await manager.stop(localId)
  })

  it('fila: alvo ocupado libera (interrupt) → a queued é entregue automaticamente e conclui', async () => {
    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status === 'idle')

    manager.send(localId, 'tarefa demorada')
    await waitUntil(() => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status === 'working')

    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'faça algo' },
    })
    const { id } = res.json()
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any).status).toBe('queued')

    await manager.interrupt(localId)

    // o fake responde em eco quase instantaneamente: a transição queued→in_progress→completed
    // pode acontecer inteira entre dois polls do waitUntil, então em vez de tentar flagrar o
    // estado transiente in_progress via polling, esperamos o estado final e conferimos pelo
    // histórico de broadcasts (que registra as transições na ordem em que aconteceram) que
    // a entrega passou por in_progress antes de completar.
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any)?.status === 'completed')
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as any
    expect(row.result).toMatch(/eco: \[Task from Origem\]: faça algo/)
    expect(broadcasts.some((b: any) => b.type === 'task_update' && b.task.id === id && b.task.status === 'in_progress')).toBe(true)
    expect(broadcasts.some((b: any) => b.type === 'task_update' && b.task.id === id && b.task.status === 'completed')).toBe(true)

    await manager.stop(localId)
  })

  it('fila: duas tarefas para o mesmo alvo drenam em sequência (FIFO), a 2ª só entrega após a 1ª concluir', async () => {
    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status === 'idle')

    manager.send(localId, 'tarefa demorada')
    await waitUntil(() => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status === 'working')

    // a 1ª usa "devagar" (fake responde só depois de 300ms) — abre uma janela
    // observável em que ela está in_progress e a 2ª ainda precisa estar queued,
    // provando que o dreno não entrega as duas de uma vez.
    const res1 = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'devagar primeira' },
    })
    const res2 = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'segunda' },
    })
    const id1 = res1.json().id
    const id2 = res2.json().id
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(id1) as any).status).toBe('queued')
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(id2) as any).status).toBe('queued')

    await manager.interrupt(localId)

    // a 1ª é entregue (in_progress) enquanto ainda está "devagar"; a 2ª segue queued
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id1) as any)?.status === 'in_progress')
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(id2) as any).status).toBe('queued')

    // a 1ª conclui
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id1) as any)?.status === 'completed')

    // agora a 2ª é entregue sozinha (encadeado pelo status do alvo) e completa
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id2) as any)?.status === 'completed')
    const row2 = db.prepare('SELECT * FROM tasks WHERE id=?').get(id2) as any
    expect(row2.result).toMatch(/eco: \[Task from Origem\]: segunda/)

    await manager.stop(localId)
  })

  it('GET /api/orchestrator/tasks lista tarefas, mais novas primeiro', async () => {
    await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'primeira' },
    })
    await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: toId, toProjectName: 'Origem', description: 'segunda' },
    })
    const res = await app.inject({ method: 'GET', url: '/api/orchestrator/tasks' })
    expect(res.statusCode).toBe(200)
    const list = res.json()
    expect(list).toHaveLength(2)
    expect(list[0].description).toBe('segunda')
    expect(list[0].fromProjectName).toBe('Destino')
    expect(list[0].toProjectName).toBe('Origem')
  })
})

describe('engine de quem despachou → quem executou', () => {
  it('dispatch com fromEngine válido grava; a entrega grava a engine da sessão que recebeu', async () => {
    const sessionRes = await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })

    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'quem executa?', fromEngine: 'codex' },
    })
    const { id } = res.json()
    // fromEngine persistido; toEngine = engine da sessão entregue (fakeFactory nasce como claude)
    const row = db.prepare('SELECT from_engine, to_engine FROM tasks WHERE id=?').get(id) as any
    expect(row.from_engine).toBe('codex')
    expect(row.to_engine).toBe('claude')
    // e o GET expõe no shape camelCase
    const list = (await app.inject({ method: 'GET', url: '/api/orchestrator/tasks' })).json() as any[]
    const task = list.find((t) => t.id === id)
    expect(task).toMatchObject({ fromEngine: 'codex', toEngine: 'claude' })

    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any)?.status === 'completed')
    await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
  })

  it('fromEngine desconhecido (não registrado) é descartado → null', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'x', fromEngine: 'engine-fake' },
    })
    const { id } = res.json()
    const row = db.prepare('SELECT from_engine FROM tasks WHERE id=?').get(id) as any
    expect(row.from_engine).toBeNull()
  })

  it('task ainda na fila (sem sessão ativa) não tem toEngine até ser entregue', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'espera', fromEngine: 'claude' },
    })
    const { id } = res.json()
    const row = db.prepare('SELECT status, from_engine, to_engine FROM tasks WHERE id=?').get(id) as any
    expect(row).toMatchObject({ status: 'queued', from_engine: 'claude', to_engine: null })
  })
})

describe('drain e o árbitro do próximo envio', () => {
  /** Textos que entraram no chat do alvo, na ordem (eco do usuário). */
  const userTexts = (localId: string) => mgrBroadcasts
    .filter((b) => b.type === 'session_event' && b.localId === localId && b.event?.kind === 'user')
    .map((b) => String(b.event.message?.content?.[0]?.text ?? ''))
    .filter((t) => t)
  const statusOf = (localId: string) => manager.get(localId)?.status

  const startIdle = async () => {
    const { localId } = (await app.inject({ method: 'POST', url: `/api/projects/${toId}/sessions` })).json()
    await waitUntil(() => statusOf(localId) === 'idle')
    // O "livre" do arranque já passou pelo árbitro.
    await new Promise((r) => setTimeout(r, 20))
    return localId as string
  }

  it('drain devolve true quando entrega e false quando não há nada', async () => {
    expect(orchestrator).toBeDefined()
    // Sem sessão.
    expect(orchestrator!.drain(toId)).toBe(false)
    const localId = await startIdle()
    // Sessão livre, nada na fila.
    expect(orchestrator!.drain(toId)).toBe(false)
    const tasks = createTasksService(db)
    const { id } = tasks.create(fromId, toId, 'direto', 'queued', null)
    expect(orchestrator!.drain(toId)).toBe(true)
    expect(tasks.get(id)?.status).toBe('in_progress')
    // A sessão está ocupada com a tarefa: a próxima espera.
    const { id: id2 } = tasks.create(fromId, toId, 'depois', 'queued', null)
    expect(orchestrator!.drain(toId)).toBe(false)
    expect(tasks.get(id2)?.status).not.toBe('failed')
    // Com o local id de outra sessão (ou de nenhuma), não entrega.
    await waitUntil(() => tasks.get(id2)?.status === 'completed')
    expect(orchestrator!.drain(toId, 'nao-existe')).toBe(false)
    await manager.stop(localId)
  })

  it('tarefa de outro agente espera a fila do operador (lugar 3 antes do 5)', async () => {
    const localId = await startIdle()
    manager.send(localId, 'devagar primeiro')
    expect(statusOf(localId)).toBe('working')
    // Um item na fila do operador e uma tarefa de outro agente, os dois esperando.
    const q = await app.inject({ method: 'POST', url: `/api/projects/${toId}/terminals/claude/queue`, payload: { text: 'da fila' } })
    expect(q.statusCode).toBe(201)
    const { id } = (await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'tarefa' },
    })).json()
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any).status).toBe('queued')

    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any)?.status === 'completed')
    const texts = userTexts(localId)
    expect(texts.indexOf('da fila')).toBeGreaterThan(-1)
    expect(texts.indexOf('da fila')).toBeLessThan(texts.indexOf('[Task from Origem]: tarefa'))
    await manager.stop(localId)
  })

  it('com o aviso do limite de uso aberto, a tarefa de outro agente espera (drain pula a sessão livre)', async () => {
    const localId = await startIdle()
    createTerminalStateStore(db).recordUsageLimit(toId, 'claude', { resetsAt: Math.floor(Date.now() / 1000) + 3600, origin: 'operator' })
    const { id } = (await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'tarefa' },
    })).json()
    await new Promise((r) => setTimeout(r, 50))
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any).status).toBe('queued')
    expect(statusOf(localId)).toBe('idle')
    expect(userTexts(localId)).toEqual([])
    await manager.stop(localId)
  })

  it('com o aviso aberto, a tarefa de outro agente espera; fechar o aviso entrega', async () => {
    const localId = await startIdle()
    createTerminalStateStore(db).markInterrupted(toId, 'claude', localId, null)
    const { id } = (await app.inject({
      method: 'POST', url: '/api/orchestrator/dispatch',
      payload: { fromProjectId: fromId, toProjectName: 'Destino', description: 'tarefa' },
    })).json()
    await new Promise((r) => setTimeout(r, 50))
    expect((db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any).status).toBe('queued')
    expect(statusOf(localId)).toBe('idle')

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${toId}/terminals/claude/interruption` })
    expect(res.statusCode).toBe(200)
    await waitUntil(() => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as any)?.status === 'completed')
    await manager.stop(localId)
  })
})
