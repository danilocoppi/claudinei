import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createUndoStore, type UndoStore } from '../src/undo/store.js'
import { createTurnTracker } from '../src/undo/tracker.js'
import type { UndoCtx } from '../src/undo/types.js'
import { createRepoResolver } from '../src/checkpoint/repo.js'
import { createSerialQueue } from '../src/checkpoint/serial.js'
import { UserError } from '../src/user-error.js'
import { filesRevertedNote, turnKey, withNote } from '../../shared/undo.js'
import type { AgentEvent } from '../src/engine/types.js'
import { makeRepo, makeTempDir } from './helpers/git-repo.js'

let db: Db
let store: UndoStore
let resolver: ReturnType<typeof createRepoResolver>
let queue: ReturnType<typeof createSerialQueue>
const cleanups: Array<() => void> = []
const paths = new Map<number, string>()

type Deps = Parameters<typeof createTurnTracker>[0]
function tracker(extra: Partial<Deps> = {}) {
  return createTurnTracker({ store, resolver, queue, projectPath: id => paths.get(id) ?? null, ...extra })
}

function project(path: string, name = 'P'): number {
  const id = Number(db.prepare(`INSERT INTO projects (name, path) VALUES (?, ?)`).run(name, path).lastInsertRowid)
  paths.set(id, path)
  return id
}

function repo(files?: Record<string, string>) {
  const r = makeRepo(files)
  cleanups.push(r.cleanup)
  return r
}

const info = (o: Partial<{ compaction: () => boolean; engineSessionId: string | null; shuttingDown: boolean }> = {}) =>
  ({ compaction: () => false, engineSessionId: 'S1', shuttingDown: false, ...o })

const result = (subtype = 'success'): AgentEvent =>
  ({ kind: 'result', subtype, isError: subtype !== 'success', resultText: '', costUsd: 0, raw: {} })

const toolUse = (name: string, input: unknown): AgentEvent =>
  ({ kind: 'assistant', raw: {}, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } })

type T = ReturnType<typeof tracker>

/** Envio como o do Claude: o send põe a sessão em working na hora. */
function send(t: T, ctx: UndoCtx, text: string, origin: 'operator' | 'claudinei' | 'task' | 'schedule' = 'operator', sent: string[] = []) {
  t.onInput(ctx, text, origin, final => { sent.push(final); t.onStatus(ctx, 'working', info()) })
  return sent
}

/** Fim como o do Claude: o status sai de working antes do result. */
function finish(t: T, ctx: UndoCtx, subtype = 'success') {
  t.onStatus(ctx, 'idle', info())
  t.onEvent(ctx, result(subtype))
}

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

describe('rastreador de turnos', () => {
  it('mensagem abre trecho com marco turn_start e o fim fecha com turn_end', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const opened: number[] = []
    const closed: number[] = []
    const t = tracker({ onTurnOpened: id => opened.push(id), onTurnClosed: id => closed.push(id) })
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    const sent = send(t, ctx, '[Task from X]: faça   a coisa')
    expect(sent).toEqual(['[Task from X]: faça   a coisa'])
    const id = t.openSegment('L1')!
    expect(id).toBeTypeOf('number')
    expect(opened).toEqual([id])
    await t.idle()
    r.write('novo.txt', 'oi\n')
    finish(t, ctx)
    expect(t.openSegment('L1')).toBeUndefined()
    await t.idle()
    const turn = store.turn(id)!
    expect(turn).toMatchObject({
      origin: 'operator', textKey: turnKey('[Task from X]: faça   a coisa'), midTurn: false, snapshot: 'ok',
      repoTop: realpathSync(r.dir), endKind: 'result', conversationId: 'S1', limited: false,
    })
    expect(turn.endedAt).not.toBeNull()
    const start = store.mark(turn.startMark!)!
    const end = store.mark(turn.endMark!)!
    expect(start).toMatchObject({ kind: 'turn_start', active: [id], n: 1, mode: 'full' })
    expect(end).toMatchObject({ kind: 'turn_end', active: [], n: 2 })
    expect(turn.repoKey).toBe(start.repoKey)
    expect(closed).toEqual([id])
    // O retrato não toca o git do operador.
    expect(r.run('status', '--porcelain')).toBe('?? novo.txt\n')
  })

  it('mensagem no meio do turno fecha o trecho e abre outro num marco só (mid_turn)', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, 'primeira')
    const first = t.openSegment('L1')!
    await t.idle()
    send(t, ctx, 'segunda')
    const second = t.openSegment('L1')!
    expect(second).not.toBe(first)
    await t.idle()
    const a = store.turn(first)!
    const b = store.turn(second)!
    expect(b.midTurn).toBe(true)
    expect(a.endMark).toBe(b.startMark)
    expect(a.endKind).toBe('result')
    expect(store.mark(b.startMark!)).toMatchObject({ kind: 'message', active: [second] })
    expect(store.latestMarks(a.repoKey!, 10)).toHaveLength(2)
    finish(t, ctx)
    await t.idle()
    expect(store.turn(second)).toMatchObject({ endKind: 'result' })
    expect(store.latestMarks(a.repoKey!, 10)).toHaveLength(3)
  })

  it('turno aberto pelo motor ganha origem engine', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    t.onStatus(ctx, 'working', info())
    expect(t.openSegment('L1')).toBeUndefined() // decide na microtask
    await Promise.resolve()
    const id = t.openSegment('L1')!
    expect(store.turn(id)).toMatchObject({ origin: 'engine', textKey: null, midTurn: false })
    finish(t, ctx)
    await t.idle()
    expect(store.turn(id)).toMatchObject({ endKind: 'result', snapshot: 'ok' })
  })

  it('compactação não abre trecho', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    // O /compact: o manager liga a marca depois do status working.
    let compacting = false
    t.onStatus(ctx, 'working', info({ compaction: () => compacting }))
    compacting = true
    await t.idle()
    t.onStatus(ctx, 'idle', info({ compaction: () => compacting }))
    t.onEvent(ctx, result())
    await t.idle()
    expect(store.terminalTurns(projectId, 'claude')).toEqual([])
    expect(store.latestMarks((await resolver.get(r.dir))!.key, 1)).toEqual([])
  })

  describe('fins', () => {
    async function endWith(go: (t: T, ctx: UndoCtx) => void) {
      const r = repo()
      const projectId = project(r.dir)
      const t = tracker()
      const ctx = { localId: 'L1', projectId, engine: 'claude' }
      send(t, ctx, 'faz')
      const id = t.openSegment('L1')!
      go(t, ctx)
      await t.idle()
      return store.turn(id)!
    }

    it('cut: idle sem result', async () => {
      expect((await endWith((t, ctx) => t.onStatus(ctx, 'idle', info()))).endKind).toBe('cut')
    })
    it('interrupted: result com subtipo error_during_execution ou interrupted', async () => {
      expect((await endWith((t, ctx) => finish(t, ctx, 'error_during_execution'))).endKind).toBe('interrupted')
      expect((await endWith((t, ctx) => { t.onEvent(ctx, result('interrupted')); t.onStatus(ctx, 'needs_attention', info()) })).endKind).toBe('interrupted')
    })
    it('dead', async () => {
      const turn = await endWith((t, ctx) => t.onStatus(ctx, 'dead', info({ engineSessionId: 'S9' })))
      expect(turn).toMatchObject({ endKind: 'dead', conversationId: 'S9' })
      expect(turn.endMark).not.toBeNull()
    })
    it('stopped e restart com shuttingDown', async () => {
      expect((await endWith((t, ctx) => t.onStatus(ctx, 'stopped', info()))).endKind).toBe('stopped')
      expect((await endWith((t, ctx) => t.onStatus(ctx, 'stopped', info({ shuttingDown: true })))).endKind).toBe('restart')
    })
    it('result que chega bem depois do status não muda o fim já decidido', async () => {
      const turn = await endWith((t, ctx) => {
        t.onStatus(ctx, 'idle', info())
        void Promise.resolve().then(() => Promise.resolve()).then(() => t.onEvent(ctx, result()))
      })
      expect(turn.endKind).toBe('cut')
    })
    it('status repetido fora de working não fecha o trecho que ainda não trabalhou', async () => {
      const r = repo()
      const projectId = project(r.dir)
      const t = tracker()
      const ctx = { localId: 'L1', projectId, engine: 'codex' }
      // Motor que só passa a working depois (Codex): o idle repetido não corta.
      t.onInput(ctx, 'faz', 'operator', () => {})
      const id = t.openSegment('L1')!
      t.onStatus(ctx, 'idle', info())
      await t.idle()
      expect(t.openSegment('L1')).toBe(id)
      t.onStatus(ctx, 'working', info())
      t.onEvent(ctx, result())
      t.onStatus(ctx, 'idle', info())
      await t.idle()
      expect(store.turn(id)).toMatchObject({ endKind: 'result' })
    })
  })

  it('retrato atrasado: tool_use antes do marco de início pronto', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const repoInfo = (await resolver.get(r.dir))!
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    void queue.run(repoInfo.key, () => gate)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, 'faz')
    const id = t.openSegment('L1')!
    t.onEvent(ctx, toolUse('Bash', { command: 'ls' }))
    release()
    await t.idle()
    const turn = store.turn(id)!
    expect(turn.snapshot).toBe('late')
    expect(turn.startMark).not.toBeNull()
    // Depois do marco pronto, ferramenta não atrasa.
    send(t, ctx, 'mais')
    await t.idle()
    const second = t.openSegment('L1')!
    t.onEvent(ctx, toolUse('Bash', { command: 'ls' }))
    await t.idle()
    expect(store.turn(second)!.snapshot).toBe('ok')
  })

  it('send que lança não grava trecho nem consome a nota', () => {
    const r = repo()
    const projectId = project(r.dir)
    store.addNote(projectId, 'claude', ['a.txt'])
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    expect(() => t.onInput(ctx, 'oi', 'operator', () => { throw new Error('sessão morta') })).toThrow('sessão morta')
    expect(store.terminalTurns(projectId, 'claude')).toEqual([])
    expect(t.openSegment('L1')).toBeUndefined()
    expect(store.takeNote(projectId, 'claude')).toEqual(['a.txt'])
  })

  it('nota files reverted vai na frente uma vez só', async () => {
    const r = repo()
    const projectId = project(r.dir)
    store.addNote(projectId, 'claude', ['a.txt', 'b/c.txt'])
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    const sent: string[] = []
    send(t, ctx, 'm1', 'operator', sent)
    send(t, ctx, 'm2', 'operator', sent)
    expect(sent).toEqual([withNote(filesRevertedNote(['a.txt', 'b/c.txt']), 'm1'), 'm2'])
    expect(store.takeNote(projectId, 'claude')).toBeNull()
    await t.idle()
    const [first] = store.terminalTurns(projectId, 'claude')
    expect(first.textKey).toBe('m1')
  })

  it('holdInput lança e a mensagem não sai', () => {
    const r = repo()
    const projectId = project(r.dir)
    store.addNote(projectId, 'claude', ['a.txt'])
    const t = tracker({ holdInput: () => { throw new UserError('undo_writing', 'desfazendo arquivos neste repositório') } })
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    const sendFn = vi.fn()
    let err: unknown
    try { t.onInput(ctx, 'oi', 'operator', sendFn) } catch (e) { err = e }
    expect(err).toBeInstanceOf(UserError)
    expect((err as UserError).code).toBe('undo_writing')
    expect(sendFn).not.toHaveBeenCalled()
    expect(store.terminalTurns(projectId, 'claude')).toEqual([])
    expect(store.takeNote(projectId, 'claude')).toEqual(['a.txt'])
  })

  it('origem goal e claudinei', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, '[Claudinei: goal]: termine', 'claudinei')
    finish(t, ctx)
    send(t, ctx, '[Claudinei] olá', 'claudinei')
    finish(t, ctx)
    send(t, ctx, 'agendado', 'schedule')
    finish(t, ctx)
    await t.idle()
    expect(store.terminalTurns(projectId, 'claude').map(x => x.origin)).toEqual(['goal', 'claudinei', 'schedule'])
  })

  it('pasta sem git grava no_git sem chamar git', async () => {
    const dir = makeTempDir()
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const projectId = project(dir)
    const run = vi.spyOn(queue, 'run')
    const closed: number[] = []
    const t = tracker({ onTurnClosed: id => closed.push(id) })
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, 'faz')
    const id = t.openSegment('L1')!
    t.onEvent(ctx, toolUse('Write', { file_path: 'sub/a.txt', content: '' }))
    await t.idle()
    finish(t, ctx)
    await t.idle()
    // Agora a pasta já é conhecida: o trecho nasce no_git na hora.
    send(t, ctx, 'de novo')
    const second = t.openSegment('L1')!
    expect(store.turn(second)!.snapshot).toBe('no_git')
    finish(t, ctx)
    await t.idle()
    expect(run).not.toHaveBeenCalled()
    expect(store.turn(id)).toMatchObject({ snapshot: 'no_git', startMark: null, endMark: null, endKind: 'result', declared: ['sub/a.txt'] })
    expect(closed).toEqual([id, second])
  })

  it('caminhos declarados relativos ao topo; fora do repo não entram', async () => {
    const r = repo()
    mkdirSync(join(r.dir, 'server'))
    const projectId = project(join(r.dir, 'server'))
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, 'faz')
    const id = t.openSegment('L1')!
    t.onEvent(ctx, toolUse('Edit', { file_path: 'src/a.ts' }))
    t.onEvent(ctx, toolUse('Write', { file_path: '/etc/fora.txt' }))
    t.onEvent(ctx, toolUse('file_change', { changes: [{ path: join(r.dir, 'README.md') }] }))
    finish(t, ctx)
    await t.idle()
    expect(store.turn(id)!.declared).toEqual(['server/src/a.ts', 'README.md'])
  })

  it('turn_started do Codex grava a âncora', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'codex' }
    send(t, ctx, 'faz')
    const id = t.openSegment('L1')!
    t.onEvent(ctx, { kind: 'system', subtype: 'turn_started', raw: { turnId: 'turn-7' } })
    await t.idle()
    expect(store.turn(id)!.anchor).toBe('turn-7')
  })

  it('active: dois terminais no mesmo repo, o marco do segundo início lista os dois', async () => {
    const r = repo()
    const a = project(r.dir, 'A')
    const b = project(r.dir, 'B')
    const t = tracker()
    const ca = { localId: 'LA', projectId: a, engine: 'claude' }
    const cb = { localId: 'LB', projectId: b, engine: 'codex' }
    send(t, ca, 'a')
    const ta = t.openSegment('LA')!
    send(t, cb, 'b')
    const tb = t.openSegment('LB')!
    finish(t, ca)
    await t.idle()
    expect(store.mark(store.turn(ta)!.startMark!)!.active).toEqual([ta])
    expect(store.mark(store.turn(tb)!.startMark!)!.active).toEqual([ta, tb])
    expect(store.mark(store.turn(ta)!.endMark!)!.active).toEqual([tb])
    // Ordem dos marcos = ordem dos pedidos.
    expect(store.marksRange(store.turn(ta)!.repoKey!, 1, 10).map(m => m.kind)).toEqual(['turn_start', 'turn_start', 'turn_end'])
    finish(t, cb)
    await t.idle()
    expect(store.mark(store.turn(tb)!.endMark!)!.active).toEqual([])
  })

  it('takeMark: marco fora de turno com os trechos abertos do repo', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, 'faz')
    const id = t.openSegment('L1')!
    const repoInfo = (await resolver.get(r.dir))!
    const markId = await t.takeMark(repoInfo, 'undo_pre')
    expect(store.mark(markId)).toMatchObject({ kind: 'undo_pre', active: [id], repoKey: repoInfo.key })
  })

  it('boot fecha turno aberto como uncertain', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t1 = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t1, ctx, 'faz')
    const id = t1.openSegment('L1')!
    await t1.idle()
    // O serviço caiu; outro rastreador sobe com o mesmo banco.
    resolver = createRepoResolver()
    queue = createSerialQueue()
    const closed: number[] = []
    const t2 = tracker({ onTurnClosed: x => closed.push(x) })
    await t2.boot()
    const turn = store.turn(id)!
    expect(turn.endKind).toBe('uncertain')
    expect(store.mark(turn.endMark!)).toMatchObject({ kind: 'turn_end', active: [] })
    expect(store.openTurns()).toEqual([])
    expect(closed).toEqual([id])
  })

  it('boot: turno sem marco de início vira failed; sem repo fecha sem marco', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const pending = store.openTurn({ localId: 'L1', projectId, engine: 'claude', origin: 'operator', repoKey: 'naoexiste00000000', repoTop: join(r.dir, 'sumiu') })
    const noGit = store.openTurn({ localId: 'L2', projectId, engine: 'claude', origin: 'operator', snapshot: 'no_git' })
    await tracker().boot()
    expect(store.turn(pending)).toMatchObject({ endKind: 'uncertain', endMark: null, snapshot: 'failed' })
    expect(store.turn(noGit)).toMatchObject({ endKind: 'uncertain', endMark: null, snapshot: 'no_git' })
  })

  it('interativo: open/close viram um trecho interactive', async () => {
    const r = repo()
    const projectId = project(r.dir)
    const t = tracker()
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    t.onInteractive(ctx, 'open')
    const id = t.openSegment('L1')!
    // Status de sessão não fecha o trecho interativo.
    t.onStatus(ctx, 'stopped', info())
    expect(t.openSegment('L1')).toBe(id)
    r.write('feito-no-terminal.txt', 'x\n')
    t.onInteractive(ctx, 'close')
    await t.idle()
    const turn = store.turn(id)!
    expect(turn).toMatchObject({ origin: 'interactive', snapshot: 'ok', endKind: 'stopped' })
    expect(store.mark(turn.startMark!)!.kind).toBe('terminal_open')
    expect(store.mark(turn.endMark!)!.kind).toBe('terminal_close')
  })

  it('falha do git: snapshot failed com a mensagem', async () => {
    const r = repo()
    const projectId = project(r.dir)
    await resolver.get(r.dir)
    // O índice próprio vira pasta: o retrato falha.
    mkdirSync(join(r.dir, '.git', 'claudinei-index'))
    const t = tracker({ log: () => {} })
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, 'faz')
    const id = t.openSegment('L1')!
    finish(t, ctx)
    await t.idle()
    const turn = store.turn(id)!
    expect(turn.snapshot).toBe('failed')
    expect(turn.snapshotError).toBeTruthy()
    expect(turn).toMatchObject({ startMark: null, endMark: null, endKind: 'result' })
  })

  it('limitado: o modo do marco de início; o seguinte usa a listagem do anterior', async () => {
    const r = repo()
    for (let i = 0; i < 3; i++) writeFileSync(join(r.dir, `solto${i}.txt`), `s${i}\n`)
    const projectId = project(r.dir)
    const limits = { untrackedMaxBytes: 2 * 1024 * 1024, limitedFiles: 2, limitedBytes: 200 * 1024 * 1024 }
    const t = tracker({ snapshotLimits: limits })
    const ctx = { localId: 'L1', projectId, engine: 'claude' }
    send(t, ctx, 'faz')
    const id = t.openSegment('L1')!
    await t.idle()
    r.write('criado.txt', 'novo\n')
    finish(t, ctx)
    await t.idle()
    const turn = store.turn(id)!
    expect(turn.limited).toBe(true)
    const start = store.mark(turn.startMark!)!
    const end = store.mark(turn.endMark!)!
    expect(start.mode).toBe('limited')
    expect(store.listing(start.listingHash!)!.map(e => e.path).sort()).toEqual(['solto0.txt', 'solto1.txt', 'solto2.txt'])
    // O marco de fim pôs o solto criado no turno (veio da listagem do anterior).
    expect(r.run('ls-tree', '-r', '--name-only', end.commitSha).split('\n')).toContain('criado.txt')
    expect(r.run('ls-tree', '-r', '--name-only', start.commitSha).split('\n')).not.toContain('solto0.txt')
  })
})
