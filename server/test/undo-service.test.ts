import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createUndoStore, type MarkKind, type UndoStore } from '../src/undo/store.js'
import { createTurnTracker } from '../src/undo/tracker.js'
import type { UndoCtx } from '../src/undo/types.js'
import { createRepoResolver, type RepoInfo } from '../src/checkpoint/repo.js'
import { createSerialQueue } from '../src/checkpoint/serial.js'
import type { AgentEvent } from '../src/engine/types.js'
import type { SessionInfo } from '../src/claude/manager.js'
import { createUndoService, UndoChangedError, type UndoService } from '../src/undo/service.js'
import { FILES_REVERTED_PREFIX, type UndoPreview, type ViewerFull } from '../../shared/undo.js'
import { makeRepo } from './helpers/git-repo.js'

let db: Db
let store: UndoStore
let resolver: ReturnType<typeof createRepoResolver>
let queue: ReturnType<typeof createSerialQueue>
const cleanups: Array<() => void> = []
const projects = new Map<number, { id: number; name: string; path: string }>()
let sessions: Array<Pick<SessionInfo, 'localId' | 'projectId' | 'engine' | 'status'>> = []
let broadcasts: Array<Record<string, unknown>> = []
let writeEnds: string[] = []
/** Chamado no meio do takeMark do serviço (antes do marco), para espiar a escrita. */
let onMark: ((kind: MarkKind) => void) | null = null
/** Chamado logo depois do prepareRestore do serviço (antes da seção síncrona da escrita). */
let afterPrepare: (() => void) | null = null

// O prepareRestore real, com um gancho depois dele: o editor salva entre o preparo e a escrita.
vi.mock('../src/checkpoint/restore.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/checkpoint/restore.js')>()
  return {
    ...real,
    prepareRestore: async (...args: Parameters<typeof real.prepareRestore>) => {
      const prepared = await real.prepareRestore(...args)
      afterPrepare?.()
      return prepared
    },
  }
})

/** Os testes de permissão não valem como root (o root escreve em pasta só de leitura). */
const asRoot = process.getuid?.() === 0

const ADMIN: ViewerFull = { isAdmin: true, projectIds: 'all' }
const only = (...ids: number[]): ViewerFull => ({ isAdmin: false, projectIds: ids })

function project(path: string, name: string): number {
  const id = Number(db.prepare(`INSERT INTO projects (name, path) VALUES (?, ?)`).run(name, path).lastInsertRowid)
  projects.set(id, { id, name, path })
  return id
}

function repo(files: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }) {
  const r = makeRepo(files)
  cleanups.push(r.cleanup)
  return r
}

function setup(extra: { restoreMaxBytes?: number } = {}) {
  let service!: UndoService
  const tracker = createTurnTracker({
    store, resolver, queue,
    projectPath: id => projects.get(id)?.path ?? null,
    holdInput: ctx => service.holdInput(ctx),
  })
  service = createUndoService({
    db, store, resolver, queue,
    manager: { list: () => sessions as SessionInfo[] },
    projects: { get: id => projects.get(id) },
    canSee: (v, id) => v.isAdmin || v.projectIds === 'all' || v.projectIds.includes(id),
    broadcast: m => broadcasts.push(m as Record<string, unknown>),
    takeMark: (r: RepoInfo, kind: MarkKind) => {
      onMark?.(kind)
      return tracker.takeMark(r, kind)
    },
    onWriteEnd: top => writeEnds.push(top),
    log: () => {},
    ...extra,
  })
  return { tracker, service }
}
type T = ReturnType<typeof setup>['tracker']

const info = () => ({ compaction: () => false, engineSessionId: 'S1', shuttingDown: false })
const result: AgentEvent = { kind: 'result', subtype: 'success', isError: false, resultText: '', costUsd: 0, raw: {} }

function edit(t: T, ctx: UndoCtx, abs: string): void {
  t.onEvent(ctx, {
    kind: 'assistant', raw: {},
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: abs } }] },
  })
}

function send(t: T, ctx: UndoCtx, text: string): number {
  t.onInput(ctx, text, 'operator', () => t.onStatus(ctx, 'working', info()))
  return t.openSegment(ctx.localId)!
}

function finish(t: T, ctx: UndoCtx): void {
  t.onStatus(ctx, 'idle', info())
  t.onEvent(ctx, result)
}

const ctxOf = (projectId: number, localId: string): UndoCtx => ({ localId, projectId, engine: 'claude' })

/** Um turno inteiro: abre, roda `work` (escreve no disco) e fecha. */
async function turn(t: T, ctx: UndoCtx, work: () => void): Promise<number> {
  const id = send(t, ctx, 'trabalha')
  await t.idle()
  work()
  finish(t, ctx)
  await t.idle()
  return id
}

const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8')
const lines = (n: number, change: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `linha ${i + 1}`).join('\n') + '\n'
const brief = (p: UndoPreview) => p.files.map(f => ({ path: f.path, class: f.class, verdict: f.verdict, overlapped: f.overlapped, checked: f.checked }))

beforeEach(() => {
  db = openDb(':memory:')
  store = createUndoStore(db)
  resolver = createRepoResolver()
  queue = createSerialQueue()
  projects.clear()
  sessions = []
  broadcasts = []
  writeEnds = []
  onMark = null
  afterPrepare = null
})

afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

describe('prévia', () => {
  it('prévia: own marcado, uncertain desmarcado, overlapped vira conflict', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = ctxOf(project(r.dir, 'B'), 'LB')
    const { tracker: t, service } = setup()
    const ta = send(t, A, 'A trabalha')
    await t.idle()
    send(t, B, 'B trabalha')
    await t.idle()
    edit(t, A, join(r.dir, 'a.txt'))
    edit(t, A, join(r.dir, 'c.txt'))
    edit(t, B, join(r.dir, 'c.txt'))
    r.write('a.txt', 'de A\n')
    r.write('b.txt', 'de ninguém\n')
    r.write('c.txt', 'dos dois\n')
    finish(t, B)
    await t.idle()
    finish(t, A)
    await t.idle()

    const p = await service.preview([ta], ADMIN)
    expect(brief(p)).toEqual([
      { path: 'a.txt', class: 'own', verdict: 'revert', overlapped: false, checked: true },
      { path: 'b.txt', class: 'uncertain', verdict: 'revert', overlapped: false, checked: false },
      // Agora = depois, mas outro terminal declarou o caminho: aparece como conflito.
      { path: 'c.txt', class: 'own', verdict: 'conflict', overlapped: true, checked: false },
    ])
    expect(p.files.find(f => f.path === 'c.txt')!.mergeable).toBe(false)
    expect(p.turnIds).toEqual([ta])
    expect(p.blockedBy).toBeNull()
    expect(p.branchChanged).toBeNull()
    expect(p.hiddenOutside).toBe(0)
    expect(p.token).toMatch(/^[0-9a-f]{40}$/)

    // Sem decisões: só o marcado volta.
    const run = await service.apply([ta], { token: p.token, decisions: {} }, ADMIN)
    expect(Object.fromEntries(run.files.map(f => [f.path, f.result]))).toEqual({ 'a.txt': 'reverted', 'b.txt': 'kept', 'c.txt': 'kept' })
    expect(read(r.dir, 'a.txt')).toBe('a\n')
    expect(read(r.dir, 'b.txt')).toBe('de ninguém\n')
    expect(read(r.dir, 'c.txt')).toBe('dos dois\n')
  })

  it('decisões: incerto marcado volta, sobreposto só com force; decisão inválida recusa sem escrever', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = ctxOf(project(r.dir, 'B'), 'LB')
    const { tracker: t, service } = setup()
    const ta = send(t, A, 'A trabalha')
    await t.idle()
    send(t, B, 'B trabalha')
    await t.idle()
    edit(t, A, join(r.dir, 'c.txt'))
    edit(t, B, join(r.dir, 'c.txt'))
    r.write('b.txt', 'de ninguém\n')
    r.write('c.txt', 'dos dois\n')
    finish(t, B)
    finish(t, A)
    await t.idle()

    const p = await service.preview([ta], ADMIN)
    for (const decisions of [
      { 'c.txt': 'revert' }, // sobreposto é conflito: revert não vale
      { 'c.txt': 'merge' }, // não é mergeable
      { 'zzz.txt': 'keep' }, // fora da prévia
      { 'b.txt': 'apagar' }, // ação desconhecida
    ]) {
      await expect(service.apply([ta], { token: p.token, decisions: decisions as never }, ADMIN))
        .rejects.toMatchObject({ code: 'undo_bad_decision' })
    }
    expect(read(r.dir, 'b.txt')).toBe('de ninguém\n')
    const key = (await resolver.get(r.dir))!.key
    expect(store.latestMarks(key, 100).every(m => m.kind !== 'undo_pre')).toBe(true)

    const run = await service.apply([ta], { token: p.token, decisions: { 'b.txt': 'revert', 'c.txt': 'force' } }, ADMIN)
    expect(Object.fromEntries(run.files.map(f => [f.path, f.result]))).toEqual({ 'b.txt': 'reverted', 'c.txt': 'forced' })
    expect(read(r.dir, 'b.txt')).toBe('b\n')
    expect(read(r.dir, 'c.txt')).toBe('c\n')
  })
})

describe('desfazer', () => {
  it('apply volta os arquivos e grava a nota uma vez', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'mudou\n')
      r.write('novo.txt', 'novo\n')
      rmSync(join(r.dir, 'b.txt'))
    })
    const repoInfo = (await resolver.get(r.dir))!
    const p = await service.preview([ta], ADMIN)
    const run = await service.apply([ta], { token: p.token, decisions: {} }, ADMIN)
    await t.idle()

    expect(run.kind).toBe('undo')
    expect(run.turnIds).toEqual([ta])
    expect(run.redone).toBe(false)
    expect(run.files).toEqual([
      { path: 'a.txt', result: 'reverted' }, { path: 'b.txt', result: 'reverted' }, { path: 'novo.txt', result: 'reverted' },
    ])
    expect(read(r.dir, 'a.txt')).toBe('a\n')
    expect(read(r.dir, 'b.txt')).toBe('b\n')
    expect(existsSync(join(r.dir, 'novo.txt'))).toBe(false)

    // O desfazer gravado, com os marcos antes e depois da escrita.
    const row = store.run(run.id)!
    expect(row.preMark).not.toBeNull()
    expect(row.postMark).not.toBeNull()
    expect(store.mark(row.preMark!)!.kind).toBe('undo_pre')
    expect(store.mark(row.postMark!)!.kind).toBe('undo_post')
    expect(store.lastRunFor(ta)!.id).toBe(run.id)
    expect(broadcasts).toContainEqual({ type: 'undo_run', projectId: A.projectId, engine: 'claude', run: { ...run, hiddenOutside: 0 } })
    expect(writeEnds).toEqual([repoInfo.top])
    expect(service.holds(A.projectId, 'claude')).toBe(false)

    // A nota vai na próxima mensagem, uma vez só.
    const texts: string[] = []
    t.onInput(A, 'segue', 'operator', final => texts.push(final))
    t.onInput(A, 'e mais', 'operator', final => texts.push(final))
    expect(texts[0].startsWith(`${FILES_REVERTED_PREFIX}: The operator reverted the file changes of an earlier turn: a.txt, b.txt, novo.txt.`)).toBe(true)
    expect(texts[0].endsWith('\n\nsegue')).toBe(true)
    expect(texts[1]).toBe('e mais')
    // Os marcos das duas mensagens saem antes de o repositório do teste sumir.
    await t.idle()
  })

  it('bloqueado com outro terminal working no mesmo repo e com in_terminal; nome vira null sem acesso', async () => {
    const r = repo({ 'a.txt': 'a\n', 'sub/x.txt': 'x\n' })
    const outro = repo({ 'z.txt': 'z\n' })
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = project(join(r.dir, 'sub'), 'B')
    const C = project(outro.dir, 'C')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => r.write('a.txt', 'mudou\n'))

    sessions = [{ localId: 'LC', projectId: C, engine: 'claude', status: 'working' }]
    expect((await service.preview([ta], ADMIN)).blockedBy).toBeNull()

    sessions = [
      { localId: 'LB2', projectId: B, engine: 'codex', status: 'in_terminal' },
      { localId: 'LB', projectId: B, engine: 'claude', status: 'working' },
    ]
    const p = await service.preview([ta], ADMIN)
    expect(p.blockedBy).toEqual({ kind: 'working', terminal: 'B' })
    expect((await service.preview([ta], only(A.projectId))).blockedBy).toEqual({ kind: 'working', terminal: null })
    await expect(service.apply([ta], { token: p.token, decisions: {} }, ADMIN)).rejects.toMatchObject({ code: 'undo_blocked' })
    expect(read(r.dir, 'a.txt')).toBe('mudou\n')

    sessions = [{ localId: 'LB2', projectId: B, engine: 'codex', status: 'in_terminal' }]
    expect((await service.preview([ta], ADMIN)).blockedBy).toEqual({ kind: 'in_terminal', terminal: 'B' })
    await expect(service.apply([ta], { token: p.token, decisions: {} }, ADMIN)).rejects.toMatchObject({ code: 'undo_blocked' })

    // Terminal que começa a trabalhar entre a prévia e a escrita: a seção síncrona reconfere.
    sessions = []
    onMark = kind => { if (kind === 'undo_pre') sessions = [{ localId: 'LB', projectId: B, engine: 'claude', status: 'working' }] }
    await expect(service.apply([ta], { token: p.token, decisions: {} }, ADMIN)).rejects.toMatchObject({ code: 'undo_blocked' })
    expect(read(r.dir, 'a.txt')).toBe('mudou\n')
    expect(service.holds(A.projectId, 'claude')).toBe(false)
    expect(writeEnds.length).toBe(1)
  })

  it('conflito cujo "agora" virou pasta: keepOnly na prévia, e voltar mesmo assim é recusado', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'mudou\n')
      r.write('b.txt', 'mudou\n')
    })
    // Depois do turno, a.txt virou pasta.
    rmSync(join(r.dir, 'a.txt'))
    mkdirSync(join(r.dir, 'a.txt'))
    r.write('a.txt/dentro.txt', 'x\n')
    const p = await service.preview([ta], ADMIN)
    const a = p.files.find(f => f.path === 'a.txt')!
    expect(a).toMatchObject({ verdict: 'conflict', keepOnly: true, mergeable: false })
    expect(p.files.find(f => f.path === 'b.txt')!.keepOnly).toBeUndefined()
    await expect(service.apply([ta], { token: p.token, decisions: { 'a.txt': 'force' } }, ADMIN))
      .rejects.toMatchObject({ code: 'undo_bad_decision' })
    const run = await service.apply([ta], { token: p.token, decisions: { 'a.txt': 'keep' } }, ADMIN)
    expect(run.files).toEqual(expect.arrayContaining([{ path: 'b.txt', result: 'reverted' }]))
    expect(read(r.dir, 'a.txt/dentro.txt')).toBe('x\n')
  })

  it('arquivo rastreado acima do teto vai para notUndoable como too_big, e o resto da prévia e do desfazer segue', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup({ restoreMaxBytes: 100 })
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'mudou\n')
      r.write('b.txt', 'z'.repeat(500) + '\n')
    })
    const p = await service.preview([ta], ADMIN)
    expect(p.files.map(f => f.path)).toEqual(['a.txt'])
    expect(p.notUndoable).toEqual([expect.objectContaining({ path: 'b.txt', status: 'too_big', size: 501 })])
    const run = await service.apply([ta], { token: p.token, decisions: {} }, ADMIN)
    expect(run.files).toEqual([{ path: 'a.txt', result: 'reverted' }])
    expect(read(r.dir, 'a.txt')).toBe('a\n')
    expect(read(r.dir, 'b.txt')).toBe('z'.repeat(500) + '\n')
  })

  it('token velho: 409 undo_changed sem escrever', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'turno\n')
      r.write('b.txt', 'turno\n')
    })
    const key = (await resolver.get(r.dir))!.key
    const p = await service.preview([ta], ADMIN)
    const marks = store.latestMarks(key, 100).length
    // O editor salva depois da prévia.
    r.write('a.txt', 'editor\n')
    const err = await service.apply([ta], { token: p.token, decisions: {} }, ADMIN).catch(e => e)
    expect(err).toBeInstanceOf(UndoChangedError)
    expect(err.code).toBe('undo_changed')
    expect(err.preview.token).not.toBe(p.token)
    expect(err.preview.files.find((f: { path: string }) => f.path === 'a.txt').verdict).toBe('conflict')
    expect(read(r.dir, 'a.txt')).toBe('editor\n')
    expect(read(r.dir, 'b.txt')).toBe('turno\n')
    expect(store.latestMarks(key, 100).length).toBe(marks)
    expect(store.lastRunFor(ta)).toBeUndefined()
    expect(broadcasts.filter(m => m.type === 'undo_run')).toEqual([])
  })

  it('o editor salva depois da conferência do token: undo_changed e nada escrito', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'turno\n')
      r.write('b.txt', 'turno\n')
    })
    const p = await service.preview([ta], ADMIN)
    onMark = kind => { if (kind === 'undo_pre') r.write('a.txt', 'editor\n') }
    const err = await service.apply([ta], { token: p.token, decisions: {} }, ADMIN).catch(e => e)
    expect(err).toBeInstanceOf(UndoChangedError)
    expect(read(r.dir, 'a.txt')).toBe('editor\n')
    expect(read(r.dir, 'b.txt')).toBe('turno\n')
    expect(store.lastRunFor(ta)).toBeUndefined()
    expect(service.holds(A.projectId, 'claude')).toBe(false)
  })

  it('turno late ou failed: undo_unavailable', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const t1 = await turn(t, A, () => r.write('a.txt', 'um\n'))
    const t2 = await turn(t, A, () => r.write('b.txt', 'dois\n'))
    store.markLate(t1)
    store.setSnapshot(t2, 'failed', 'disco cheio')
    await expect(service.preview([t1], ADMIN)).rejects.toMatchObject({ code: 'undo_unavailable' })
    await expect(service.apply([t1], { token: 'x', decisions: {} }, ADMIN)).rejects.toMatchObject({ code: 'undo_unavailable' })
    await expect(service.preview([t2], ADMIN)).rejects.toMatchObject({ code: 'undo_unavailable' })
    // O diff do turno atrasado aparece (com aviso, na tela); o desfazer não.
    expect((await service.turnFiles(t1, ADMIN)).files.map(f => f.path)).toEqual(['a.txt'])
    await expect(service.turnFiles(t2, ADMIN)).rejects.toMatchObject({ code: 'undo_unavailable' })
    // Em andamento também.
    const t3 = send(t, A, 'em curso')
    await t.idle()
    await expect(service.preview([t3], ADMIN)).rejects.toMatchObject({ code: 'undo_unavailable' })
    expect(read(r.dir, 'a.txt')).toBe('um\n')
  })

  it('turno antigo com turno depois mexendo no mesmo arquivo: cai em conflict', async () => {
    const r = repo({ 'a.txt': lines(12), 'b.txt': 'b\n' })
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const t1 = await turn(t, A, () => {
      r.write('a.txt', lines(12, { 2: 'TURNO 1' }))
      r.write('b.txt', 'turno 1\n')
    })
    await turn(t, A, () => r.write('a.txt', lines(12, { 2: 'TURNO 1', 9: 'TURNO 2' })))
    const p = await service.preview([t1], ADMIN)
    const a = p.files.find(f => f.path === 'a.txt')!
    expect(a).toMatchObject({ verdict: 'conflict', mergeable: true, checked: false })
    expect(a.sinceTurn).toContain('+TURNO 2')
    expect(p.files.find(f => f.path === 'b.txt')).toMatchObject({ verdict: 'revert', checked: true })
    const run = await service.apply([t1], { token: p.token, decisions: { 'a.txt': 'merge' } }, ADMIN)
    expect(run.files).toEqual([{ path: 'a.txt', result: 'merged' }, { path: 'b.txt', result: 'reverted' }])
    expect(read(r.dir, 'a.txt')).toBe(lines(12, { 9: 'TURNO 2' }))
  })

  it('branchChanged depois de checkout', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => r.write('novo.txt', 'novo\n'))
    expect((await service.preview([ta], ADMIN)).branchChanged).toBeNull()
    r.run('checkout', '-q', '-b', 'outro')
    expect((await service.preview([ta], ADMIN)).branchChanged).toEqual({ from: 'main', to: 'outro' })
  })

  it('holdInput lança durante a escrita e holds fica verdadeiro', async () => {
    const r = repo({ 'a.txt': 'a\n', 'sub/x.txt': 'x\n' })
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = ctxOf(project(join(r.dir, 'sub'), 'B'), 'LB')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => r.write('a.txt', 'mudou\n'))
    await resolver.get(join(r.dir, 'sub'))
    const seen: Array<{ kind: MarkKind; holds: boolean; error: unknown }> = []
    onMark = kind => {
      let error: unknown = null
      try { t.onInput(B, 'no meio', 'operator', () => {}) } catch (e) { error = (e as { code?: string }).code }
      seen.push({ kind, holds: service.holds(B.projectId, 'claude'), error })
    }
    const p = await service.preview([ta], ADMIN)
    await service.apply([ta], { token: p.token, decisions: {} }, ADMIN)
    expect(seen).toEqual([
      { kind: 'undo_pre', holds: true, error: 'undo_writing' },
      { kind: 'undo_post', holds: true, error: 'undo_writing' },
    ])
    expect(service.holds(B.projectId, 'claude')).toBe(false)
    expect(() => service.holdInput(B)).not.toThrow()
  })

  it('não-admin: arquivo fora do projeto não entra na prévia e fica em hiddenOutside; turnDiff de caminho fora recusa com forbidden_path', async () => {
    const r = repo({ 'raiz.txt': 'raiz\n', 'server/x.txt': 'x\n' })
    const P = ctxOf(project(join(r.dir, 'server'), 'P'), 'LP')
    const outroProjeto = project(r.dir, 'Q')
    const { tracker: t, service } = setup()
    const tp = await turn(t, P, () => {
      r.write('server/x.txt', 'turno\n')
      r.write('raiz.txt', 'turno\n')
    })
    const viewer = only(P.projectId)

    const files = await service.turnFiles(tp, viewer)
    expect(files.files.map(f => f.path)).toEqual(['server/x.txt'])
    expect(files.hiddenOutside).toBe(1)
    expect((await service.turnFiles(tp, ADMIN)).files.map(f => f.path)).toEqual(['raiz.txt', 'server/x.txt'])

    await expect(service.turnDiff(tp, 'raiz.txt', viewer)).rejects.toMatchObject({ code: 'forbidden_path' })
    expect((await service.turnDiff(tp, 'server/x.txt', viewer)).text).toContain('+turno')
    expect((await service.turnDiff(tp, 'raiz.txt', ADMIN)).text).toContain('+turno')
    await expect(service.turnFiles(tp, only(outroProjeto))).rejects.toMatchObject({ code: 'forbidden_project' })

    const p = await service.preview([tp], viewer)
    expect(p.files.map(f => f.path)).toEqual(['server/x.txt'])
    expect(p.hiddenOutside).toBe(1)
    await expect(service.apply([tp], { token: p.token, decisions: { 'raiz.txt': 'revert' } }, viewer))
      .rejects.toMatchObject({ code: 'undo_bad_decision' })
    const run = await service.apply([tp], { token: p.token, decisions: {} }, viewer)
    expect(run.files).toEqual([{ path: 'server/x.txt', result: 'reverted' }])
    expect(read(r.dir, 'server/x.txt')).toBe('x\n')
    expect(read(r.dir, 'raiz.txt')).toBe('turno\n')
    // A nota leva só o que foi desfeito.
    expect(store.takeNote(P.projectId, 'claude')).toEqual(['server/x.txt'])
  })

  it('arquivo grande demais: fica em notUndoable e o diff vem sem texto', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('grande.bin', Buffer.alloc(2 * 1024 * 1024 + 1, 1))
      r.write('a.txt', 'mudou\n')
    })
    const p = await service.preview([ta], ADMIN)
    expect(p.files.map(f => f.path)).toEqual(['a.txt'])
    expect(p.notUndoable).toEqual([expect.objectContaining({ path: 'grande.bin', status: 'too_big' })])
    expect(await service.turnDiff(ta, 'grande.bin', ADMIN)).toEqual({ path: 'grande.bin', binary: false, text: '', truncated: false })
    await expect(service.apply([ta], { token: p.token, decisions: { 'grande.bin': 'force' } }, ADMIN))
      .rejects.toMatchObject({ code: 'undo_bad_decision' })
  })

  it('várias turnIds: cada arquivo volta ao início do primeiro turno que o mexeu', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = ctxOf(project(r.dir, 'B'), 'LB')
    const { tracker: t, service } = setup()
    const t1 = await turn(t, A, () => r.write('a.txt', 'a1\n'))
    const t2 = await turn(t, A, () => {
      r.write('a.txt', 'a2\n')
      r.write('b.txt', 'b2\n')
    })
    const t3 = await turn(t, A, () => r.write('c.txt', 'c3\n'))
    // Fora da lista: c.txt mexido pelo t3 fica.
    const p = await service.preview([t2, t1], ADMIN)
    expect(p.turnIds).toEqual([t1, t2])
    expect(brief(p)).toEqual([
      { path: 'a.txt', class: 'own', verdict: 'revert', overlapped: false, checked: true },
      { path: 'b.txt', class: 'own', verdict: 'revert', overlapped: false, checked: true },
    ])
    const run = await service.apply([t1, t2], { token: p.token, decisions: {} }, ADMIN, { note: false })
    expect(run.turnIds).toEqual([t1, t2])
    expect(read(r.dir, 'a.txt')).toBe('a\n')
    expect(read(r.dir, 'b.txt')).toBe('b\n')
    expect(read(r.dir, 'c.txt')).toBe('c3\n')
    expect(store.takeNote(A.projectId, 'claude')).toBeNull()
    expect(store.lastRunFor(t1)!.id).toBe(run.id)
    expect(store.lastRunFor(t3)).toBeUndefined()

    const tb = await turn(t, B, () => r.write('b.txt', 'de B\n'))
    await expect(service.preview([t3, tb], ADMIN)).rejects.toMatchObject({ code: 'undo_mixed_terminals' })
  })

  it.skipIf(asRoot)('erro de E/S num arquivo: failed no desfazer gravado e o resto segue', async () => {
    const r = repo({ 'a.txt': 'a\n', 'trava/b.txt': 'b\n' })
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'turno\n')
      r.write('trava/b.txt', 'turno\n')
    })
    const p = await service.preview([ta], ADMIN)
    onMark = kind => {
      if (kind === 'undo_pre') {
        chmodSync(join(r.dir, 'trava'), 0o555)
        cleanups.push(() => chmodSync(join(r.dir, 'trava'), 0o755))
      }
    }
    const run = await service.apply([ta], { token: p.token, decisions: {} }, ADMIN)
    expect(run.files.map(f => [f.path, f.result])).toEqual([['a.txt', 'reverted'], ['trava/b.txt', 'failed']])
    expect(run.files[1].error).toMatch(/EACCES|permission/i)
    expect(store.run(run.id)!.files[1]).toMatchObject({ result: 'failed', error: run.files[1].error })
    expect(store.run(run.id)!.postMark).not.toBeNull()
    expect(read(r.dir, 'a.txt')).toBe('a\n')
    expect(store.takeNote(A.projectId, 'claude')).toEqual(['a.txt'])
    expect(service.holds(A.projectId, 'claude')).toBe(false)
    expect(writeEnds.length).toBe(1)
  })

  it('o editor salva entre o preparo e a escrita: nada escrito e undo_changed com a prévia nova', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'turno\n')
      r.write('b.txt', 'turno\n')
    })
    const p = await service.preview([ta], ADMIN)
    // b.txt vem depois de a.txt: sem a reconferência de todos, a.txt seria escrito.
    afterPrepare = () => r.write('b.txt', 'editor\n')
    const err = await service.apply([ta], { token: p.token, decisions: {} }, ADMIN).catch(e => e)
    expect(err).toBeInstanceOf(UndoChangedError)
    expect(err.preview.token).not.toBe(p.token)
    expect(err.preview.files.find((f: { path: string }) => f.path === 'b.txt').verdict).toBe('conflict')
    expect(err.preview.files.find((f: { path: string }) => f.path === 'a.txt').verdict).toBe('revert')
    expect(read(r.dir, 'a.txt')).toBe('turno\n')
    expect(read(r.dir, 'b.txt')).toBe('editor\n')
    expect(store.lastRunFor(ta)).toBeUndefined()
    expect(broadcasts.filter(m => m.type === 'undo_run')).toEqual([])
    expect(service.holds(A.projectId, 'claude')).toBe(false)
    expect(writeEnds.length).toBe(1)

    // Com a prévia nova, o desfazer segue (b.txt, em conflito, fica).
    afterPrepare = null
    const run = await service.apply([ta], { token: err.preview.token, decisions: {} }, ADMIN)
    expect(Object.fromEntries(run.files.map(f => [f.path, f.result]))).toEqual({ 'a.txt': 'reverted', 'b.txt': 'kept' })
  })

  it('pasta de projeto ainda não resolvida do mesmo repositório também é segurada', async () => {
    const r = repo({ 'a.txt': 'a\n', 'sub/x.txt': 'x\n' })
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const B = ctxOf(project(join(r.dir, 'sub'), 'B'), 'LB')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => r.write('a.txt', 'mudou\n'))
    const seen: Array<{ holds: boolean; error: unknown }> = []
    onMark = kind => {
      if (kind !== 'undo_pre') return
      // Ninguém resolveu sub/ ainda: vale o prefixo do caminho.
      expect(resolver.peek(join(r.dir, 'sub'))).toBeUndefined()
      let error: unknown = null
      try { service.holdInput(B) } catch (e) { error = (e as { code?: string }).code }
      seen.push({ holds: service.holds(B.projectId, 'claude'), error })
    }
    const p = await service.preview([ta], ADMIN)
    await service.apply([ta], { token: p.token, decisions: {} }, ADMIN)
    expect(seen).toEqual([{ holds: true, error: 'undo_writing' }])
    expect(service.holds(B.projectId, 'claude')).toBe(false)
  })

  it('undo_run publicado leva só os caminhos da pasta do projeto; quem chamou vê o que pode ver', async () => {
    const r = repo({ 'raiz.txt': 'raiz\n', 'server/x.txt': 'x\n' })
    const P = ctxOf(project(join(r.dir, 'server'), 'P'), 'LP')
    const { tracker: t, service } = setup()
    const tp = await turn(t, P, () => {
      r.write('server/x.txt', 'turno\n')
      r.write('raiz.txt', 'turno\n')
    })
    const p = await service.preview([tp], ADMIN)
    const run = await service.apply([tp], { token: p.token, decisions: {} }, ADMIN)
    // O administrador recebe tudo.
    expect(run.files).toEqual([{ path: 'raiz.txt', result: 'reverted' }, { path: 'server/x.txt', result: 'reverted' }])
    const msg = broadcasts.find(m => m.type === 'undo_run')!
    expect(msg.run).toEqual({ ...run, files: [{ path: 'server/x.txt', result: 'reverted' }], hiddenOutside: 1 })
    expect(JSON.stringify(broadcasts)).not.toContain('raiz.txt')
    // O refazer do administrador também publica sem o caminho de fora.
    const rp = await service.previewRedo(run.id, ADMIN)
    const redone = await service.redo(run.id, { token: rp.token, decisions: {} }, ADMIN)
    expect(redone.files.map(f => f.path)).toEqual(['raiz.txt', 'server/x.txt'])
    const msgs = broadcasts.filter(m => m.type === 'undo_run')
    expect(msgs[1].run).toEqual({ ...redone, files: [{ path: 'server/x.txt', result: 'reverted' }], hiddenOutside: 1 })
    expect(JSON.stringify(broadcasts)).not.toContain('raiz.txt')
  })

  it('arquivo mexido só pelo t1 e mudado fora de turno antes do t2: [t1, t2] cai em conflict', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const t1 = await turn(t, A, () => r.write('a.txt', 'a1\n'))
    // Entre os turnos, fora de qualquer turno.
    r.write('a.txt', 'a1 e o editor\n')
    const t2 = await turn(t, A, () => r.write('b.txt', 'b2\n'))
    const p = await service.preview([t1, t2], ADMIN)
    expect(brief(p)).toEqual([
      { path: 'a.txt', class: 'own', verdict: 'conflict', overlapped: false, checked: false },
      { path: 'b.txt', class: 'own', verdict: 'revert', overlapped: false, checked: true },
    ])
    const run = await service.apply([t1, t2], { token: p.token, decisions: {} }, ADMIN)
    expect(Object.fromEntries(run.files.map(f => [f.path, f.result]))).toEqual({ 'a.txt': 'kept', 'b.txt': 'reverted' })
    expect(read(r.dir, 'a.txt')).toBe('a1 e o editor\n')
  })

  it('arquivo já como antes: force e merge recusados; keep e revert não fazem nada', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'turno\n')
      r.write('b.txt', 'turno\n')
    })
    r.write('a.txt', 'a\n')
    const p = await service.preview([ta], ADMIN)
    expect(p.files.find(f => f.path === 'a.txt')).toMatchObject({ verdict: 'already', checked: false })
    for (const action of ['force', 'merge']) {
      await expect(service.apply([ta], { token: p.token, decisions: { 'a.txt': action as never } }, ADMIN))
        .rejects.toMatchObject({ code: 'undo_bad_decision' })
    }
    expect(read(r.dir, 'b.txt')).toBe('turno\n')
    const run = await service.apply([ta], { token: p.token, decisions: { 'a.txt': 'revert' } }, ADMIN)
    expect(Object.fromEntries(run.files.map(f => [f.path, f.result]))).toEqual({ 'a.txt': 'already', 'b.txt': 'reverted' })
  })
})

describe('refazer', () => {
  it('não-admin não refaz desfazer com arquivos ocultos: redo_hidden_files sem escrever', async () => {
    const r = repo({ 'raiz.txt': 'raiz\n', 'server/x.txt': 'x\n' })
    const P = ctxOf(project(join(r.dir, 'server'), 'P'), 'LP')
    const { tracker: t, service } = setup()
    const tp = await turn(t, P, () => {
      r.write('server/x.txt', 'turno\n')
      r.write('raiz.txt', 'turno\n')
    })
    const p = await service.preview([tp], ADMIN)
    const undone = await service.apply([tp], { token: p.token, decisions: {} }, ADMIN)
    await t.idle()
    const viewer = only(P.projectId)
    await expect(service.previewRedo(undone.id, viewer)).rejects.toMatchObject({ code: 'redo_hidden_files' })
    await expect(service.redo(undone.id, { token: 'x', decisions: {} }, viewer)).rejects.toMatchObject({ code: 'redo_hidden_files' })
    expect(read(r.dir, 'server/x.txt')).toBe('x\n')
    expect(read(r.dir, 'raiz.txt')).toBe('raiz\n')
    expect(store.run(undone.id)!.redoneAt).toBeNull()
    expect(broadcasts.filter(m => m.type === 'undo_run').length).toBe(1)
    // O administrador ainda tem o Refazer.
    const rp = await service.previewRedo(undone.id, ADMIN)
    await service.redo(undone.id, { token: rp.token, decisions: {} }, ADMIN)
    expect(read(r.dir, 'raiz.txt')).toBe('turno\n')
  })

  it('não-admin refaz desfazer sem arquivos ocultos', async () => {
    const r = repo({ 'raiz.txt': 'raiz\n', 'server/x.txt': 'x\n' })
    const P = ctxOf(project(join(r.dir, 'server'), 'P'), 'LP')
    const { tracker: t, service } = setup()
    const tp = await turn(t, P, () => r.write('server/x.txt', 'turno\n'))
    const viewer = only(P.projectId)
    const p = await service.preview([tp], viewer)
    const undone = await service.apply([tp], { token: p.token, decisions: {} }, viewer)
    await t.idle()
    const rp = await service.previewRedo(undone.id, viewer)
    expect(rp.hiddenOutside).toBe(0)
    const redone = await service.redo(undone.id, { token: rp.token, decisions: {} }, viewer)
    expect(redone.files).toEqual([{ path: 'server/x.txt', result: 'reverted' }])
    expect(read(r.dir, 'server/x.txt')).toBe('turno\n')
  })
  it('refazer volta o que o desfazer tirou; com o arquivo mexido depois, conflict', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => {
      r.write('a.txt', 'turno\n')
      r.write('novo.txt', 'novo\n')
      r.write('c.txt', 'turno\n')
    })
    const p = await service.preview([ta], ADMIN)
    // c.txt fica (keep): o refazer não o toca.
    const undone = await service.apply([ta], { token: p.token, decisions: { 'c.txt': 'keep' } }, ADMIN)
    await t.idle()

    const rp = await service.previewRedo(undone.id, ADMIN)
    expect(brief(rp)).toEqual([
      { path: 'a.txt', class: 'own', verdict: 'revert', overlapped: false, checked: true },
      { path: 'novo.txt', class: 'own', verdict: 'revert', overlapped: false, checked: true },
    ])
    const redone = await service.redo(undone.id, { token: rp.token, decisions: {} }, ADMIN)
    expect(redone.kind).toBe('redo')
    expect(redone.turnIds).toEqual([ta])
    expect(redone.files).toEqual([{ path: 'a.txt', result: 'reverted' }, { path: 'novo.txt', result: 'reverted' }])
    expect(read(r.dir, 'a.txt')).toBe('turno\n')
    expect(read(r.dir, 'novo.txt')).toBe('novo\n')
    expect(read(r.dir, 'c.txt')).toBe('turno\n')
    expect(store.run(undone.id)!.redoneAt).not.toBeNull()
    expect(store.run(redone.id)!.redoOf).toBe(undone.id)
    // A nota do desfazer, ainda não entregue, perde o que voltou.
    expect(store.takeNote(A.projectId, 'claude')).toBeNull()
    expect(broadcasts.filter(m => m.type === 'undo_run').length).toBe(2)
    await expect(service.previewRedo(undone.id, ADMIN)).rejects.toMatchObject({ code: 'undo_already_redone' })
    await expect(service.previewRedo(redone.id, ADMIN)).rejects.toMatchObject({ code: 'undo_not_redoable' })

    // Desfaz de novo e mexe no arquivo: o refazer vira conflito.
    const p2 = await service.preview([ta], ADMIN)
    const undone2 = await service.apply([ta], { token: p2.token, decisions: {} }, ADMIN)
    await t.idle()
    r.write('a.txt', 'mexido\n')
    const rp2 = await service.previewRedo(undone2.id, ADMIN)
    expect(rp2.files.find(f => f.path === 'a.txt')).toMatchObject({ verdict: 'conflict', checked: false })
    await expect(service.redo(undone2.id, { token: rp2.token, decisions: { 'a.txt': 'revert' } }, ADMIN))
      .rejects.toMatchObject({ code: 'undo_bad_decision' })
    const redone2 = await service.redo(undone2.id, { token: rp2.token, decisions: {} }, ADMIN)
    expect(Object.fromEntries(redone2.files.map(f => [f.path, f.result]))).toEqual({ 'a.txt': 'kept', 'c.txt': 'reverted', 'novo.txt': 'reverted' })
    expect(read(r.dir, 'a.txt')).toBe('mexido\n')
  })
})

describe('retrato perdido', () => {
  it('ref apagada: turnFiles grava lost e responde snapshot_lost', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => r.write('a.txt', 'mudou\n'))
    // O repositório perde as refs e o gc leva os objetos (no repo temporário).
    for (const ref of r.run('for-each-ref', '--format=%(refname)', 'refs/claudinei/').split('\n').filter(Boolean)) {
      r.run('update-ref', '-d', ref)
    }
    rmSync(join(r.dir, '.git', 'claudinei-index'), { force: true })
    r.run('reflog', 'expire', '--expire=now', '--all')
    r.run('gc', '-q', '--prune=now')
    await expect(service.turnFiles(ta, ADMIN)).rejects.toMatchObject({ code: 'snapshot_lost' })
    expect(store.turn(ta)!.snapshot).toBe('lost')
    await expect(service.preview([ta], ADMIN)).rejects.toMatchObject({ code: 'snapshot_lost' })
  })

  it('git que falha na conferência não grava lost: snapshot_check_failed, e passa quando o git volta', async () => {
    const r = repo()
    const A = ctxOf(project(r.dir, 'A'), 'LA')
    const { tracker: t, service } = setup()
    const ta = await turn(t, A, () => r.write('a.txt', 'mudou\n'))
    // Sem a pasta de objetos o git nem reconhece o repositório: falha do git, não retrato perdido.
    renameSync(join(r.dir, '.git', 'objects'), join(r.dir, '.git', 'objetos-fora'))
    const back = () => renameSync(join(r.dir, '.git', 'objetos-fora'), join(r.dir, '.git', 'objects'))
    try {
      await expect(service.turnFiles(ta, ADMIN)).rejects.toMatchObject({ code: 'snapshot_check_failed' })
      await expect(service.preview([ta], ADMIN)).rejects.toMatchObject({ code: 'snapshot_check_failed' })
      expect(store.turn(ta)!.snapshot).toBe('ok')
    } finally {
      back()
    }
    expect((await service.turnFiles(ta, ADMIN)).files.map(f => f.path)).toEqual(['a.txt'])
  })
})

describe('resumo do turno', () => {
  it('summarizeTurn grava o resumo da pasta do projeto e publica undo_turn', async () => {
    const r = repo({ 'raiz.txt': 'raiz\n', 'server/x.txt': 'x\n' })
    const P = ctxOf(project(join(r.dir, 'server'), 'P'), 'LP')
    mkdirSync(join(r.dir, 'server'), { recursive: true })
    const { tracker: t, service } = setup()
    const tp = await turn(t, P, () => {
      r.write('server/x.txt', 'turno\nmais\n')
      r.write('raiz.txt', 'turno\n')
    })
    await service.summarizeTurn(tp)
    const summary = { files: 1, added: 2, removed: 1, outside: 1, uncertain: 0, unsnapshotted: 0 }
    expect(store.turn(tp)!.summary).toEqual(summary)
    const msg = broadcasts.find(m => m.type === 'undo_turn')!
    expect(msg).toMatchObject({ type: 'undo_turn', projectId: P.projectId, localId: 'LP', engine: 'claude' })
    expect(msg.turn).toMatchObject({ id: tp, state: 'ok', summary, lastRun: null, endKind: 'result' })
  })
})
