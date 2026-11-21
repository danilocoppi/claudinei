import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createUndoStore, type UndoStore } from '../src/undo/store.js'
import { createTurnTracker } from '../src/undo/tracker.js'
import type { UndoCtx } from '../src/undo/types.js'
import { createRepoResolver, type RepoInfo } from '../src/checkpoint/repo.js'
import { createSerialQueue } from '../src/checkpoint/serial.js'
import { changedFiles } from '../src/checkpoint/diff.js'
import type { AgentEvent } from '../src/engine/types.js'
import {
  attributeTurn, listIntervals, markSide, summarize, UnattributableTurnError, type AttributedFile,
} from '../src/undo/attribution.js'
import { makeRepo } from './helpers/git-repo.js'

let db: Db
let store: UndoStore
let resolver: ReturnType<typeof createRepoResolver>
let queue: ReturnType<typeof createSerialQueue>
const cleanups: Array<() => void> = []
const paths = new Map<number, string>()

function tracker() {
  return createTurnTracker({ store, resolver, queue, projectPath: id => paths.get(id) ?? null })
}
type T = ReturnType<typeof tracker>

function project(path: string, name: string): number {
  const id = Number(db.prepare(`INSERT INTO projects (name, path) VALUES (?, ?)`).run(name, path).lastInsertRowid)
  paths.set(id, path)
  return id
}

function repo() {
  const r = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })
  cleanups.push(r.cleanup)
  return r
}

const info = () => ({ compaction: () => false, engineSessionId: 'S1', shuttingDown: false })

const result: AgentEvent = { kind: 'result', subtype: 'success', isError: false, resultText: '', costUsd: 0, raw: {} }

/** O agente declara escrever num caminho (Edit do Claude). */
function edit(t: T, ctx: UndoCtx, abs: string): void {
  t.onEvent(ctx, {
    kind: 'assistant', raw: {},
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: abs } }] },
  })
}

/** Envio como o do Claude: o send põe a sessão em working na hora. Devolve o id do turno. */
function send(t: T, ctx: UndoCtx, text: string): number {
  t.onInput(ctx, text, 'operator', () => t.onStatus(ctx, 'working', info()))
  return t.openSegment(ctx.localId)!
}

function finish(t: T, ctx: UndoCtx): void {
  t.onStatus(ctx, 'idle', info())
  t.onEvent(ctx, result)
}

/** Dois terminais (A e B) na mesma pasta do repositório. */
async function twoTerminals() {
  const r = repo()
  const a = project(r.dir, 'A')
  const b = project(r.dir, 'B')
  const t = tracker()
  const repoInfo = (await resolver.get(r.dir))!
  return {
    r, t, repoInfo,
    A: { localId: 'LA', projectId: a, engine: 'claude' } as UndoCtx,
    B: { localId: 'LB', projectId: b, engine: 'claude' } as UndoCtx,
  }
}

async function attribute(repoInfo: RepoInfo, turnId: number, projectRel = ''): Promise<AttributedFile[]> {
  return attributeTurn(repoInfo, store, store.turn(turnId)!, projectRel)
}

const brief = (files: AttributedFile[]) => files.map(f => ({ path: f.path, class: f.class, overlapped: f.overlapped }))

beforeEach(() => {
  db = openDb(':memory:')
  store = createUndoStore(db)
  resolver = createRepoResolver()
  queue = createSerialQueue()
  paths.clear()
})

afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

describe('atribuição entre terminais', () => {
  it('turno sozinho: tudo own', async () => {
    const { r, t, repoInfo, A } = await twoTerminals()
    const id = send(t, A, 'mexe')
    await t.idle()
    r.write('a.txt', 'a mudou\n')
    r.write('novo.txt', 'novo\n')
    finish(t, A)
    await t.idle()
    const files = await attribute(repoInfo, id)
    expect(brief(files)).toEqual([
      { path: 'a.txt', class: 'own', overlapped: false },
      { path: 'novo.txt', class: 'own', overlapped: false },
    ])
    expect(files.every(f => f.inProject)).toBe(true)
    expect(files[0]).toMatchObject({ status: 'modified', added: 1, removed: 1 })
    expect(files[1]).toMatchObject({ status: 'added', added: 1, removed: 0 })
  })

  it('sobrepostos, caminho declarado só por A: own em A, fora de B', async () => {
    const { r, t, repoInfo, A, B } = await twoTerminals()
    const ta = send(t, A, 'A trabalha')
    await t.idle()
    const tb = send(t, B, 'B trabalha')
    await t.idle()
    edit(t, A, join(r.dir, 'a.txt'))
    r.write('a.txt', 'de A\n')
    finish(t, A)
    await t.idle()
    finish(t, B)
    await t.idle()
    expect(brief(await attribute(repoInfo, ta))).toEqual([{ path: 'a.txt', class: 'own', overlapped: false }])
    expect(await attribute(repoInfo, tb)).toEqual([])
  })

  it('sobrepostos sem declaração: uncertain nos dois', async () => {
    const { r, t, repoInfo, A, B } = await twoTerminals()
    const ta = send(t, A, 'A trabalha')
    await t.idle()
    const tb = send(t, B, 'B trabalha')
    await t.idle()
    r.write('b.txt', 'de alguém\n')
    finish(t, B)
    await t.idle()
    finish(t, A)
    await t.idle()
    expect(brief(await attribute(repoInfo, ta))).toEqual([{ path: 'b.txt', class: 'uncertain', overlapped: false }])
    expect(brief(await attribute(repoInfo, tb))).toEqual([{ path: 'b.txt', class: 'uncertain', overlapped: false }])
  })

  it('os dois declararam: overlapped', async () => {
    const { r, t, repoInfo, A, B } = await twoTerminals()
    const ta = send(t, A, 'A trabalha')
    await t.idle()
    const tb = send(t, B, 'B trabalha')
    await t.idle()
    edit(t, A, join(r.dir, 'c.txt'))
    edit(t, B, join(r.dir, 'c.txt'))
    r.write('c.txt', 'dos dois\n')
    finish(t, A)
    await t.idle()
    finish(t, B)
    await t.idle()
    expect(brief(await attribute(repoInfo, ta))).toEqual([{ path: 'c.txt', class: 'own', overlapped: true }])
    expect(brief(await attribute(repoInfo, tb))).toEqual([{ path: 'c.txt', class: 'own', overlapped: true }])
  })

  it('mudança fora de turno vira intervalo between e não entra em nenhum turno', async () => {
    const { r, t, repoInfo, A } = await twoTerminals()
    const t1 = send(t, A, 'primeiro')
    await t.idle()
    r.write('a.txt', 'do turno\n')
    finish(t, A)
    await t.idle()
    // O operador no editor, entre os turnos.
    r.write('fora.txt', 'do operador\n')
    const t2 = send(t, A, 'segundo')
    await t.idle()
    finish(t, A)
    await t.idle()
    expect(brief(await attribute(repoInfo, t1))).toEqual([{ path: 'a.txt', class: 'own', overlapped: false }])
    expect(await attribute(repoInfo, t2)).toEqual([])

    const end1 = store.mark(store.turn(t1)!.endMark!)!
    const start2 = store.mark(store.turn(t2)!.startMark!)!
    const between = listIntervals(store, repoInfo.key)
    expect(between.map(i => [i.from.id, i.to.id, i.kind])).toEqual([[end1.id, start2.id, 'between']])
    const outside = await changedFiles(repoInfo, markSide(store, between[0].from), markSide(store, between[0].to))
    expect(outside.map(f => f.path)).toEqual(['fora.txt'])

    // Um desfazer: o par undo_pre → undo_post vira intervalo `undo`, o mais novo primeiro.
    const pre = await t.takeMark(repoInfo, 'undo_pre')
    r.write('a.txt', 'a\n')
    const post = await t.takeMark(repoInfo, 'undo_post')
    const end2 = store.turn(t2)!.endMark!
    expect(listIntervals(store, repoInfo.key).map(i => [i.from.id, i.to.id, i.kind])).toEqual([
      [pre, post, 'undo'],
      [end2, pre, 'between'],
      [end1.id, start2.id, 'between'],
    ])
    expect(listIntervals(store, repoInfo.key, 1).map(i => i.kind)).toEqual(['undo'])
  })

  it('intervalo com marco apagado no meio (retenção) não vira between', async () => {
    const { r, t, repoInfo, A } = await twoTerminals()
    send(t, A, 'primeiro')
    await t.idle()
    finish(t, A)
    await t.idle()
    const t2 = send(t, A, 'segundo')
    await t.idle()
    r.write('a.txt', 'x\n')
    finish(t, A)
    await t.idle()
    // A retenção levou o turno do meio: o "fim do primeiro → fim do segundo" não é fora de turno.
    db.prepare(`DELETE FROM undo_marks WHERE id = ?`).run(store.turn(t2)!.startMark)
    expect(listIntervals(store, repoInfo.key)).toEqual([])
  })

  it('arquivo que mudou e voltou no turno não aparece', async () => {
    const { r, t, repoInfo, A, B } = await twoTerminals()
    const ta = send(t, A, 'A trabalha')
    await t.idle()
    send(t, B, 'B trabalha')
    await t.idle()
    edit(t, A, join(r.dir, 'a.txt'))
    r.write('a.txt', 'mexido\n')
    r.write('b.txt', 'também\n')
    finish(t, B)
    await t.idle()
    // Já sozinho, A devolve o a.txt ao que era.
    r.write('a.txt', 'a\n')
    finish(t, A)
    await t.idle()
    expect(brief(await attribute(repoInfo, ta))).toEqual([{ path: 'b.txt', class: 'uncertain', overlapped: false }])
  })

  it('subagente dentro do turno conta como o turno', async () => {
    const { r, t, repoInfo, A, B } = await twoTerminals()
    const ta = send(t, A, 'A trabalha')
    await t.idle()
    send(t, B, 'B trabalha')
    await t.idle()
    finish(t, B)
    await t.idle()
    // Um ativo só (A): a escrita sem declaração (subagente, Bash) é do turno.
    r.write('sub/feito.txt', 'pelo subagente\n')
    finish(t, A)
    await t.idle()
    expect(brief(await attribute(repoInfo, ta))).toEqual([{ path: 'sub/feito.txt', class: 'own', overlapped: false }])
  })

  it('summarize de não-admin: fora da pasta do projeto vira outside', async () => {
    const r = repo()
    mkdirSync(join(r.dir, 'server'))
    const p = project(join(r.dir, 'server'), 'S')
    const t = tracker()
    const ctx: UndoCtx = { localId: 'LS', projectId: p, engine: 'claude' }
    const repoInfo = (await resolver.get(r.dir))!
    const id = send(t, ctx, 'mexe')
    await t.idle()
    r.write('server/x.ts', 'um\ndois\n')
    r.write('serverx.txt', 'vizinho\n')
    r.write('a.txt', 'a\nmais\n')
    finish(t, ctx)
    await t.idle()
    const files = await attribute(repoInfo, id, 'server')
    expect(files.map(f => [f.path, f.inProject])).toEqual([
      ['a.txt', false], ['server/x.ts', true], ['serverx.txt', false],
    ])
    expect(summarize(files, { isAdmin: false })).toEqual({ files: 1, added: 2, removed: 0, outside: 2, uncertain: 0, unsnapshotted: 0 })
    expect(summarize(files, { isAdmin: true })).toEqual({ files: 3, added: 4, removed: 0, outside: 0, uncertain: 0, unsnapshotted: 0 })
    // Pasta do projeto no topo (''): tudo dentro.
    expect((await attribute(repoInfo, id, '')).every(f => f.inProject)).toBe(true)
    // Barra no fim não muda nada.
    expect((await attribute(repoInfo, id, 'server/')).map(f => f.inProject)).toEqual([false, true, false])
  })

  it('pasta do projeto começando com ponto não perde o ponto', async () => {
    const r = repo()
    mkdirSync(join(r.dir, '.config'))
    const p = project(join(r.dir, '.config'), 'Dot')
    const t = tracker()
    const ctx: UndoCtx = { localId: 'LD', projectId: p, engine: 'claude' }
    const repoInfo = (await resolver.get(r.dir))!
    const id = send(t, ctx, 'mexe')
    await t.idle()
    r.write('.config/x', 'x\n')
    r.write('config/y', 'y\n')
    finish(t, ctx)
    await t.idle()
    expect((await attribute(repoInfo, id, '.config')).map(f => [f.path, f.inProject])).toEqual([
      ['.config/x', true], ['config/y', false],
    ])
  })

  it('summarize conta incertos e sem retrato à parte; +/− só dos próprios', () => {
    const f = (path: string, cls: 'own' | 'uncertain', status: AttributedFile['status'], added: number, inProject = true): AttributedFile =>
      ({ path, status, added, removed: 1, binary: false, class: cls, overlapped: false, inProject })
    const files = [
      f('a', 'own', 'modified', 3),
      f('b', 'uncertain', 'modified', 5),
      f('c', 'own', 'unsnapshotted', 0),
      f('d', 'uncertain', 'added', 7, false),
    ]
    expect(summarize(files, { isAdmin: false })).toEqual({ files: 2, added: 3, removed: 2, outside: 1, uncertain: 1, unsnapshotted: 1 })
    expect(summarize(files, { isAdmin: true })).toEqual({ files: 2, added: 3, removed: 2, outside: 0, uncertain: 2, unsnapshotted: 1 })
  })

  it('turno sem marco de fim (em andamento) não tem atribuição: erro próprio', async () => {
    const { t, repoInfo, A } = await twoTerminals()
    const id = send(t, A, 'ainda trabalhando')
    await t.idle()
    await expect(attribute(repoInfo, id)).rejects.toBeInstanceOf(UnattributableTurnError)
    finish(t, A)
    await t.idle()
  })
})
