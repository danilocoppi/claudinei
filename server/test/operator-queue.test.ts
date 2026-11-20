import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { UserError } from '../src/user-error.js'
import {
  createOperatorQueueStore, createOperatorQueueService,
  QUEUE_MAX, QUEUE_ITEM_MAX_BYTES,
  type OperatorQueueStore, type OperatorQueueService,
} from '../src/queue/operator-queue.js'

let db: Db
let project: Project
let store: OperatorQueueStore

beforeEach(() => {
  db = openDb(':memory:')
  project = createProjectsService(db).create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'opq-')) })
  store = createOperatorQueueStore(db)
})

const codeOf = (fn: () => unknown): string | undefined => {
  try { fn() } catch (err) { return err instanceof UserError ? err.code : `não-UserError: ${String(err)}` }
  return undefined
}

describe('repositório da fila do operador', () => {
  it('add respeita 20 itens e 120 000 bytes', () => {
    expect(QUEUE_MAX).toBe(20)
    expect(QUEUE_ITEM_MAX_BYTES).toBe(120_000)
    // Limite em bytes, não em caracteres: "é" ocupa 2 bytes em UTF-8.
    expect(codeOf(() => store.add(project.id, 'claude', 'é'.repeat(60_001)))).toBe('queue_item_too_large')
    expect(store.add(project.id, 'claude', 'é'.repeat(60_000)).text).toHaveLength(60_000)
    expect(codeOf(() => store.add(project.id, 'claude', '   '))).toBe('queue_item_empty')
    for (let i = 1; i < QUEUE_MAX; i++) store.add(project.id, 'claude', `m${i}`)
    expect(store.list(project.id, 'claude')).toHaveLength(20)
    expect(codeOf(() => store.add(project.id, 'claude', 'a mais'))).toBe('queue_full')
    // A fila é por terminal: o outro motor do mesmo projeto não herda o limite.
    expect(store.add(project.id, 'kimi', 'outro motor').text).toBe('outro motor')
    // Editar também obedece ao tamanho, e item que não existe é recusado.
    const first = store.list(project.id, 'claude')[0]
    expect(codeOf(() => store.update(first.id, 'x'.repeat(120_001)))).toBe('queue_item_too_large')
    expect(codeOf(() => store.update(first.id, ''))).toBe('queue_item_empty')
    expect(store.update(first.id, 'editado')).toMatchObject({ id: first.id, text: 'editado' })
    expect(codeOf(() => store.update(9999, 'nada'))).toBe('queue_item_not_found')
  })

  it('reorder exige a permutação exata', () => {
    const a = store.add(project.id, 'claude', 'a')
    const b = store.add(project.id, 'claude', 'b')
    const c = store.add(project.id, 'claude', 'c')
    const other = store.add(project.id, 'codex', 'de outro terminal')
    expect(codeOf(() => store.reorder(project.id, 'claude', [c.id, a.id]))).toBe('queue_order_mismatch')
    expect(codeOf(() => store.reorder(project.id, 'claude', [c.id, a.id, a.id]))).toBe('queue_order_mismatch')
    expect(codeOf(() => store.reorder(project.id, 'claude', [c.id, a.id, b.id, other.id]))).toBe('queue_order_mismatch')
    expect(codeOf(() => store.reorder(project.id, 'claude', [c.id, a.id, other.id]))).toBe('queue_order_mismatch')
    expect(store.list(project.id, 'claude').map((i) => i.text)).toEqual(['a', 'b', 'c'])
    store.reorder(project.id, 'claude', [c.id, a.id, b.id])
    expect(store.list(project.id, 'claude').map((i) => i.text)).toEqual(['c', 'a', 'b'])
    // Item novo entra no fim da ordem nova.
    store.add(project.id, 'claude', 'd')
    expect(store.list(project.id, 'claude').map((i) => i.text)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('takeFirst e putFirst preservam a ordem', () => {
    store.add(project.id, 'claude', 'a')
    store.add(project.id, 'claude', 'b')
    store.add(project.id, 'claude', 'c')
    const taken = store.takeFirst(project.id, 'claude')!
    expect(taken.text).toBe('a')
    expect(store.list(project.id, 'claude').map((i) => i.text)).toEqual(['b', 'c'])
    store.putFirst(project.id, 'claude', taken)
    const back = store.list(project.id, 'claude')
    expect(back.map((i) => i.text)).toEqual(['a', 'b', 'c'])
    // Volta o mesmo item: id e data de criação.
    expect(back[0]).toEqual(taken)
    expect(store.terminalOf(taken.id)).toEqual({ projectId: project.id, engine: 'claude' })

    const c = back[2]
    store.moveToFront(c.id)
    expect(store.list(project.id, 'claude').map((i) => i.text)).toEqual(['c', 'a', 'b'])
    store.remove(c.id)
    expect(store.list(project.id, 'claude').map((i) => i.text)).toEqual(['a', 'b'])
    expect(store.terminalOf(c.id)).toBeNull()
    store.takeFirst(project.id, 'claude')
    store.takeFirst(project.id, 'claude')
    expect(store.takeFirst(project.id, 'claude')).toBeNull()
  })

  it('apagar o projeto apaga a fila', () => {
    store.add(project.id, 'claude', 'a')
    store.setPaused(project.id, 'claude', 'error')
    expect(store.state(project.id, 'claude')).toEqual({ paused: true, pauseReason: 'error' })
    createProjectsService(db).remove(project.id)
    expect(store.list(project.id, 'claude')).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM operator_queue').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM operator_queue_state').get() as { n: number }).n).toBe(0)
    expect(store.state(project.id, 'claude')).toEqual({ paused: false, pauseReason: null })
  })
})

// Manager falso: registra as chamadas e põe a sessão em working ao receber
// uma mensagem, como o de verdade faz.
function fakeManager() {
  const status = new Map<string, string>()
  const calls: unknown[][] = []
  let failSend = false
  const mgr = {
    status,
    calls,
    failNextSend() { failSend = true },
    get: (localId: string) => (status.has(localId) ? { localId, status: status.get(localId) } : undefined),
    list: () => [],
    send: (localId: string, text: string, opts?: { echo?: boolean }) => {
      if (failSend) { failSend = false; throw new Error('sessão morreu') }
      calls.push(['send', localId, text, opts])
      status.set(localId, 'working')
    },
    interrupt: async (localId: string) => { calls.push(['interrupt', localId]) },
  }
  return mgr
}

describe('serviço da fila do operador', () => {
  let mgr: ReturnType<typeof fakeManager>
  let svc: OperatorQueueService
  let broadcasts: any[]
  let holding: boolean
  const LOCAL = 'sess-1'

  beforeEach(() => {
    mgr = fakeManager()
    broadcasts = []
    holding = false
    svc = createOperatorQueueService({
      store,
      manager: mgr as any,
      broadcast: (m) => broadcasts.push(m),
      holds: () => holding,
      acceptsMidTurn: (engine) => engine === 'claude' || engine === 'codex',
      liveLocalId: (projectId) => (projectId === project.id && mgr.status.has(LOCAL) ? LOCAL : null),
    })
  })

  const ctx = (engine = 'claude') => ({ projectId: project.id, engine, localId: LOCAL })
  const texts = (engine = 'claude') => svc.dto(project.id, engine).items.map((i) => i.text)
  const sends = () => mgr.calls.filter((c) => c[0] === 'send')

  /** Enfileira com a sessão trabalhando, para nada ser entregue na hora. */
  const queued = (engine: string, ...items: string[]) => {
    mgr.status.set(LOCAL, 'working')
    for (const t of items) svc.add(project.id, engine, t)
  }

  it('offer entrega um e só um item', () => {
    queued('claude', 'a', 'b')
    mgr.status.set(LOCAL, 'idle')
    expect(svc.offer(ctx())).toBe(true)
    // Segundo aviso de "livre" no mesmo tique: a sessão já está trabalhando.
    expect(svc.offer(ctx())).toBe(false)
    expect(sends()).toEqual([['send', LOCAL, 'a', { echo: true }]])
    expect(texts()).toEqual(['b'])
    // needs_attention também é livre.
    mgr.status.set(LOCAL, 'needs_attention')
    expect(svc.offer(ctx())).toBe(true)
    expect(texts()).toEqual([])
    expect(svc.offer(ctx())).toBe(false)
    mgr.status.set(LOCAL, 'idle')
    expect(svc.offer(ctx())).toBe(false) // vazia
    expect(sends()).toHaveLength(2)
  })

  it('offer com fila pausada devolve false', () => {
    queued('claude', 'a')
    svc.pause(project.id, 'claude')
    mgr.status.set(LOCAL, 'idle')
    expect(svc.offer(ctx())).toBe(false)
    expect(sends()).toHaveLength(0)
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: true, pauseReason: 'manual' })
    // Segurando (aviso aberto) também não entrega.
    svc.resume(project.id, 'claude')
    expect(sends()).toHaveLength(1) // o resume entregou, sessão livre
    queued('claude', 'b')
    mgr.status.set(LOCAL, 'idle')
    holding = true
    expect(svc.offer(ctx())).toBe(false)
    expect(texts()).toEqual(['b'])
  })

  it('envio que falha devolve o item à frente e pausa com error', () => {
    queued('claude', 'a', 'b')
    const before = svc.dto(project.id, 'claude').items
    mgr.status.set(LOCAL, 'idle')
    mgr.failNextSend()
    expect(svc.offer(ctx())).toBe(false)
    const dto = svc.dto(project.id, 'claude')
    expect(dto.items).toEqual(before)
    expect(dto).toMatchObject({ paused: true, pauseReason: 'error' })
    // Pausada, o próximo "livre" não entrega.
    expect(svc.offer(ctx())).toBe(false)
    expect(sends()).toHaveLength(0)

    // Sessão que sumiu entre o "livre" e o envio: mesmo destino.
    svc.resume(project.id, 'claude') // entrega 'a'
    expect(texts()).toEqual(['b'])
    mgr.status.set(LOCAL, 'idle')
    mgr.failNextSend()
    svc.sendNow(svc.dto(project.id, 'claude').items[0].id)
    expect(texts()).toEqual(['b'])
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: true, pauseReason: 'error' })
  })

  it('add com sessão livre e fila vazia entrega na hora', () => {
    mgr.status.set(LOCAL, 'idle')
    const dto = svc.add(project.id, 'claude', 'agora')
    expect(sends()).toEqual([['send', LOCAL, 'agora', { echo: true }]])
    expect(dto.items).toEqual([])
    // Trabalhando: guarda.
    const dto2 = svc.add(project.id, 'claude', 'depois')
    expect(dto2.items.map((i) => i.text)).toEqual(['depois'])
    expect(sends()).toHaveLength(1)
    // Pausada: só guarda, mesmo com a sessão livre.
    store.takeFirst(project.id, 'claude')
    svc.pause(project.id, 'claude')
    mgr.status.set(LOCAL, 'idle')
    expect(svc.add(project.id, 'claude', 'pausada').items.map((i) => i.text)).toEqual(['pausada'])
    expect(sends()).toHaveLength(1)
    // Sem sessão viva: guarda.
    mgr.status.delete(LOCAL)
    expect(svc.add(project.id, 'codex', 'sem sessão').items.map((i) => i.text)).toEqual(['sem sessão'])
    expect(sends()).toHaveLength(1)
  })

  it('add com holds=true guarda e não entrega', () => {
    mgr.status.set(LOCAL, 'idle')
    holding = true
    const dto = svc.add(project.id, 'claude', 'segura')
    expect(dto.items.map((i) => i.text)).toEqual(['segura'])
    expect(sends()).toHaveLength(0)
  })

  it('sendNow em Claude trabalhando injeta', () => {
    queued('claude', 'a', 'b')
    const b = svc.dto(project.id, 'claude').items[1]
    const dto = svc.sendNow(b.id)
    expect(sends()).toEqual([['send', LOCAL, 'b', { echo: true }]])
    expect(mgr.calls.some((c) => c[0] === 'interrupt')).toBe(false)
    expect(dto.items.map((i) => i.text)).toEqual(['a'])
    // Com a fila pausada também injeta, e a pausa continua.
    svc.pause(project.id, 'claude')
    svc.sendNow(svc.dto(project.id, 'claude').items[0].id)
    expect(sends()).toHaveLength(2)
    expect(svc.dto(project.id, 'claude')).toMatchObject({ items: [], paused: true, pauseReason: 'manual' })
    // Sessão livre: entrega o item escolhido, mesmo que não seja o primeiro.
    queued('claude', 'c', 'd')
    mgr.status.set(LOCAL, 'idle')
    svc.sendNow(svc.dto(project.id, 'claude').items[1].id)
    expect(sends().at(-1)).toEqual(['send', LOCAL, 'd', { echo: true }])
    expect(texts()).toEqual(['c'])
    expect(codeOf(() => svc.sendNow(9999))).toBe('queue_item_not_found')
  })

  it('sendNow em Kimi trabalhando interrompe e o result interrompido não pausa', () => {
    queued('kimi', 'a', 'b')
    const b = svc.dto(project.id, 'kimi').items[1]
    const dto = svc.sendNow(b.id)
    expect(mgr.calls).toContainEqual(['interrupt', LOCAL])
    expect(sends()).toHaveLength(0)
    expect(dto.items.map((i) => i.text)).toEqual(['b', 'a'])
    svc.onTurnResult(project.id, 'kimi', { isError: true, interrupted: true, limited: false })
    expect(svc.dto(project.id, 'kimi')).toMatchObject({ paused: false, pauseReason: null })
    mgr.status.set(LOCAL, 'idle')
    expect(svc.offer(ctx('kimi'))).toBe(true)
    expect(sends()).toEqual([['send', LOCAL, 'b', { echo: true }]])
    // A marca foi consumida: a próxima interrupção já é do operador.
    svc.onTurnResult(project.id, 'kimi', { isError: false, interrupted: true, limited: false })
    expect(svc.dto(project.id, 'kimi')).toMatchObject({ paused: true, pauseReason: 'interrupted' })
  })

  it('sendNow em Kimi com a fila pausada entrega o item ao ficar livre e mantém a pausa', () => {
    queued('kimi', 'a', 'b')
    svc.pause(project.id, 'kimi')
    const b = svc.dto(project.id, 'kimi').items[1]
    svc.sendNow(b.id)
    svc.onTurnResult(project.id, 'kimi', { isError: false, interrupted: true, limited: false })
    mgr.status.set(LOCAL, 'idle')
    expect(svc.offer(ctx('kimi'))).toBe(true)
    expect(sends()).toEqual([['send', LOCAL, 'b', { echo: true }]])
    // Só o item do "enviar agora" passou; o resto espera o Retomar.
    mgr.status.set(LOCAL, 'idle')
    expect(svc.offer(ctx('kimi'))).toBe(false)
    expect(svc.dto(project.id, 'kimi')).toMatchObject({ paused: true, pauseReason: 'manual' })
    expect(texts('kimi')).toEqual(['a'])
  })

  it('interrupção do operador pausa com interrupted', () => {
    queued('claude', 'a')
    svc.onTurnResult(project.id, 'claude', { isError: true, interrupted: true, limited: false })
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: true, pauseReason: 'interrupted' })
  })

  it('turno com erro pausa', () => {
    queued('claude', 'a')
    svc.onTurnResult(project.id, 'claude', { isError: false, interrupted: false, limited: false })
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: false, pauseReason: null })
    svc.onTurnResult(project.id, 'claude', { isError: true, interrupted: false, limited: false })
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: true, pauseReason: 'error' })
    // Turno bom depois não tira a pausa: só o Retomar.
    svc.onTurnResult(project.id, 'claude', { isError: false, interrupted: false, limited: false })
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: true, pauseReason: 'error' })
  })

  it('limite pausa com limit', () => {
    queued('claude', 'a')
    svc.onTurnResult(project.id, 'claude', { isError: true, interrupted: false, limited: true })
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: true, pauseReason: 'limit' })
  })

  it('onSessionDied pausa com dead', () => {
    queued('claude', 'a')
    svc.onSessionDied(project.id, 'claude')
    expect(svc.dto(project.id, 'claude')).toMatchObject({ paused: true, pauseReason: 'dead', items: [{ text: 'a' }] })
  })

  it('resume tira a pausa e entrega se livre', () => {
    queued('claude', 'a', 'b')
    svc.pause(project.id, 'claude')
    // Trabalhando: só tira a pausa.
    let dto = svc.resume(project.id, 'claude')
    expect(dto).toMatchObject({ paused: false, pauseReason: null })
    expect(sends()).toHaveLength(0)
    svc.pause(project.id, 'claude')
    mgr.status.set(LOCAL, 'idle')
    dto = svc.resume(project.id, 'claude')
    expect(sends()).toEqual([['send', LOCAL, 'a', { echo: true }]])
    expect(dto).toMatchObject({ paused: false, items: [{ text: 'b' }] })
    // Segurando: tira a pausa mas não entrega.
    svc.pause(project.id, 'claude')
    mgr.status.set(LOCAL, 'idle')
    holding = true
    svc.resume(project.id, 'claude')
    expect(sends()).toHaveLength(1)
  })

  it('cada mudança faz broadcast operator_queue com o DTO', () => {
    const last = () => broadcasts.at(-1)
    const expectLast = (engine = 'claude') =>
      expect(last()).toEqual({ type: 'operator_queue', projectId: project.id, engine, queue: svc.dto(project.id, engine) })

    mgr.status.set(LOCAL, 'working')
    svc.add(project.id, 'claude', 'a'); expectLast()
    svc.add(project.id, 'claude', 'b'); expectLast()
    const [a, b] = svc.dto(project.id, 'claude').items
    let n = broadcasts.length
    svc.update(a.id, 'a2'); expect(broadcasts.length).toBe(n + 1); expectLast()
    n = broadcasts.length
    svc.reorder(project.id, 'claude', [b.id, a.id]); expect(broadcasts.length).toBe(n + 1); expectLast()
    n = broadcasts.length
    svc.pause(project.id, 'claude'); expect(broadcasts.length).toBe(n + 1); expectLast()
    n = broadcasts.length
    svc.resume(project.id, 'claude'); expect(broadcasts.length).toBe(n + 1); expectLast()
    n = broadcasts.length
    svc.remove(b.id); expect(broadcasts.length).toBe(n + 1); expectLast()
    mgr.status.set(LOCAL, 'idle')
    n = broadcasts.length
    svc.offer(ctx()); expect(broadcasts.length).toBe(n + 1); expectLast()
    n = broadcasts.length
    svc.onTurnResult(project.id, 'claude', { isError: true, interrupted: false, limited: false })
    expect(broadcasts.length).toBe(n + 1); expectLast()
    n = broadcasts.length
    svc.onSessionDied(project.id, 'claude'); expect(broadcasts.length).toBe(n + 1); expectLast()
    expect(codeOf(() => svc.remove(9999))).toBe('queue_item_not_found')
    expect(codeOf(() => svc.update(9999, 'x'))).toBe('queue_item_not_found')
  })
})
