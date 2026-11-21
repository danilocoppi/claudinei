import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createUndoStore, type UndoStore } from '../src/undo/store.js'
import { createTurnTracker } from '../src/undo/tracker.js'
import type { UndoCtx } from '../src/undo/types.js'
import { createRepoResolver } from '../src/checkpoint/repo.js'
import { createSerialQueue } from '../src/checkpoint/serial.js'
import type { AgentEvent } from '../src/engine/types.js'
import { runRetention } from '../src/undo/retention.js'
import { makeRepo, runGit } from './helpers/git-repo.js'

let db: Db
let store: UndoStore
let resolver: ReturnType<typeof createRepoResolver>
let queue: ReturnType<typeof createSerialQueue>
const cleanups: Array<() => void> = []
const projects = new Map<number, { id: number; name: string; path: string }>()

function project(path: string, name: string): number {
  const id = Number(db.prepare(`INSERT INTO projects (name, path) VALUES (?, ?)`).run(name, path).lastInsertRowid)
  projects.set(id, { id, name, path })
  return id
}

function repo() {
  const r = makeRepo({ 'a.txt': 'a\n' })
  cleanups.push(r.cleanup)
  return r
}

function tracker() {
  return createTurnTracker({ store, resolver, queue, projectPath: id => projects.get(id)?.path ?? null, log: () => {} })
}
type T = ReturnType<typeof tracker>

const info = () => ({ compaction: () => false, engineSessionId: 'S1', shuttingDown: false })
const result: AgentEvent = { kind: 'result', subtype: 'success', isError: false, resultText: '', costUsd: 0, raw: {} }
const ctxOf = (projectId: number, localId: string, engine = 'claude'): UndoCtx => ({ localId, projectId, engine })

function send(t: T, ctx: UndoCtx, text = 'trabalha'): number {
  t.onInput(ctx, text, 'operator', () => t.onStatus(ctx, 'working', info()))
  return t.openSegment(ctx.localId)!
}
function finish(t: T, ctx: UndoCtx): void {
  t.onStatus(ctx, 'idle', info())
  t.onEvent(ctx, result)
}
async function turn(t: T, ctx: UndoCtx, work: () => void = () => {}): Promise<number> {
  const id = send(t, ctx)
  await t.idle()
  work()
  finish(t, ctx)
  await t.idle()
  return id
}

/** Faz o turno ter terminado há `days` dias. */
const age = (id: number, days: number): void => {
  db.prepare(`UPDATE undo_turns SET ended_at = datetime('now', ?) WHERE id = ?`).run(`-${days} days`, id)
}
const refsOf = (dir: string): string[] =>
  runGit(dir, 'for-each-ref', '--format=%(refname)', 'refs/claudinei/').split('\n').filter(Boolean).sort()
const marksOf = (): Array<{ id: number; n: number; ref: string; commit: string }> =>
  (db.prepare(`SELECT id, n, ref, commit_sha AS "commit" FROM undo_marks ORDER BY n`).all() as Array<{ id: number; n: number; ref: string; commit: string }>)
const retain = () => runRetention({ store, db, resolver, queue, log: () => {} })

beforeEach(() => {
  db = openDb(':memory:')
  store = createUndoStore(db)
  resolver = createRepoResolver()
  queue = createSerialQueue()
  projects.clear()
})

afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

describe('retenção', () => {
  it('turno de 31 dias some e a ref dele também (sem gc: o commit continua lá)', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const t = tracker()
    const t1 = await turn(t, A, () => r.write('a.txt', 'um\n'))
    const t2 = await turn(t, A, () => r.write('a.txt', 'dois\n'))
    const before = marksOf()
    expect(before).toHaveLength(4)
    age(t1, 31)

    expect(await retain()).toEqual({ turns: 1, marks: 2 })
    expect(store.turn(t1)).toBeUndefined()
    expect(store.turn(t2)).toBeDefined()
    const after = marksOf()
    expect(after.map(m => m.n)).toEqual([before[2].n, before[3].n])
    expect(refsOf(r.dir)).toEqual(after.map(m => m.ref).sort())
    // Nunca gc: o objeto do marco apagado ainda existe.
    expect(() => runGit(r.dir, 'cat-file', '-e', `${before[0].commit}^{commit}`)).not.toThrow()
  })

  it('turno de 29 dias fica', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const t = tracker()
    const t1 = await turn(t, A)
    age(t1, 29)
    expect(await retain()).toEqual({ turns: 0, marks: 0 })
    expect(store.turn(t1)).toBeDefined()
  })

  it('o 201º turno do terminal some; outro terminal não conta', async () => {
    const p = project('/tmp/sem-git-retencao', 'P')
    const ids: number[] = []
    for (let i = 0; i < 201; i++) {
      const id = store.openTurn({ localId: 'L', projectId: p, engine: 'claude', origin: 'operator', snapshot: 'no_git' })
      store.setEnd(id, null, 'result', null)
      ids.push(id)
    }
    const other: number[] = []
    for (let i = 0; i < 3; i++) other.push(store.openTurn({ localId: 'L2', projectId: p, engine: 'codex', origin: 'operator', snapshot: 'no_git' }))

    expect(await retain()).toEqual({ turns: 1, marks: 0 })
    expect(store.turn(ids[0])).toBeUndefined()
    expect(store.terminalTurns(p, 'claude').map(x => x.id)).toEqual(ids.slice(1))
    expect(store.terminalTurns(p, 'codex').map(x => x.id)).toEqual(other)
  })

  it('marco dentro da janela de turno restante fica; o de fora sai', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = ctxOf(project(r.dir, 'B'), 'LB')
    const t = tracker()
    const t0 = await turn(t, A) // marcos 1 e 2: fora de qualquer janela restante
    const ta = send(t, A) // marco 3
    await t.idle()
    const tb = await turn(t, B) // marcos 4 e 5, dentro da janela de ta
    finish(t, A) // marco 6
    await t.idle()
    age(t0, 40)
    age(tb, 40)

    expect(await retain()).toEqual({ turns: 2, marks: 2 })
    expect(store.turn(ta)).toBeDefined()
    expect(marksOf().map(m => m.n)).toEqual([3, 4, 5, 6])
    expect(refsOf(r.dir)).toEqual(marksOf().map(m => m.ref).sort())
  })

  it('turno ainda aberto segura os marcos dele em diante', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = ctxOf(project(r.dir, 'B'), 'LB')
    const t = tracker()
    send(t, A) // marco 1, aberto
    await t.idle()
    const tb = await turn(t, B) // marcos 2 e 3
    const tc = await turn(t, B) // marcos 4 e 5
    age(tb, 40)
    age(tc, 40)
    expect(await retain()).toEqual({ turns: 2, marks: 0 })
    expect(marksOf().map(m => m.n)).toEqual([1, 2, 3, 4, 5])
  })

  it('pre/post de desfazer restante ficam; desfazer sem turno sai', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const t = tracker()
    const t1 = await turn(t, A) // marcos 1 e 2
    const info1 = (await resolver.get(r.dir))!
    const pre = await t.takeMark(info1, 'undo_pre') // 3
    const post = await t.takeMark(info1, 'undo_post') // 4
    const run = store.insertRun({ projectId: A.projectId, engine: 'claude', kind: 'undo', turnIds: [t1], repoKey: info1.key, preMark: pre, postMark: post, files: [] })
    const t2 = await turn(t, A) // 5 e 6
    const gone = store.insertRun({ projectId: A.projectId, engine: 'claude', kind: 'undo', turnIds: [t2], repoKey: info1.key, preMark: null, postMark: null, files: [] })
    const t3 = await turn(t, A) // 7 e 8
    age(t2, 40)

    expect(await retain()).toEqual({ turns: 1, marks: 2 })
    expect(store.run(run)).toBeDefined()
    expect(store.run(gone)).toBeUndefined()
    expect(store.turn(t3)).toBeDefined()
    expect(marksOf().map(m => m.n)).toEqual([1, 2, 3, 4, 7, 8])
    expect(refsOf(r.dir)).toEqual(marksOf().map(m => m.ref).sort())
  })

  it('o marco mais novo do repositório fica mesmo sem turno: o n não se repete', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const t = tracker()
    const t1 = await turn(t, A) // 1 e 2
    age(t1, 40)
    expect(await retain()).toEqual({ turns: 1, marks: 1 })
    expect(marksOf().map(m => m.n)).toEqual([2])
    const info1 = (await resolver.get(r.dir))!
    expect(store.nextMarkN(info1.key)).toBe(3)
  })

  it('ref de outra instância no n seguinte: o marco pula para o livre e a retenção não apaga a ref alheia', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const key = (await resolver.get(r.dir))!.key
    const head = runGit(r.dir, 'rev-parse', 'HEAD').trim()
    // Outra instância, com outro banco, já gravou o 1.
    runGit(r.dir, 'update-ref', `refs/claudinei/${key}/1`, head)
    const t = tracker()
    const t1 = await turn(t, A) // 2 e 3
    const marks = marksOf()
    expect(marks.map(m => m.n)).toEqual([2, 3])
    expect(runGit(r.dir, 'rev-parse', `refs/claudinei/${key}/1`).trim()).toBe(head)
    expect(store.nextMarkN(key)).toBe(4)
    // A ref 2 vira de outra instância (sobrescrita por uma versão antiga): a retenção não a apaga.
    runGit(r.dir, 'update-ref', marks[0].ref, head)
    age(t1, 40)
    expect(await retain()).toEqual({ turns: 1, marks: 1 })
    expect(marksOf().map(m => m.n)).toEqual([3])
    expect(refsOf(r.dir)).toEqual([`refs/claudinei/${key}/1`, marks[0].ref, marks[1].ref].sort())
    expect(runGit(r.dir, 'rev-parse', marks[0].ref).trim()).toBe(head)
  })

  it('excluir o terminal apaga os turnos e a retenção apaga as refs', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const t = tracker()
    await turn(t, A)
    await turn(t, A)
    expect(refsOf(r.dir)).toHaveLength(4)
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(A.projectId)
    expect(store.terminalTurns(A.projectId, 'claude')).toEqual([])

    expect(await retain()).toEqual({ turns: 0, marks: 3 })
    expect(marksOf().map(m => m.n)).toEqual([4])
    expect(refsOf(r.dir)).toEqual(marksOf().map(m => m.ref))
  })

  it('listagens sem marco somem; a do marco que fica, não', async () => {
    const orphan = store.putListing([{ path: 'x', size: 1, mtimeMs: 1 }])
    expect(store.listing(orphan)).not.toBeNull()
    await retain()
    expect(store.listing(orphan)).toBeNull()
  })

  it('repositório que sumiu: o banco limpa, as refs ficam sem erro', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const t = tracker()
    const t1 = await turn(t, A)
    await turn(t, A)
    age(t1, 40)
    r.cleanup()
    const fresh = createRepoResolver()
    await expect(runRetention({ store, db, resolver: fresh, queue, log: () => {} })).resolves.toEqual({ turns: 1, marks: 2 })
  })
})
