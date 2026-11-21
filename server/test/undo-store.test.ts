import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createUndoStore, type MarkRow, type UndoStore } from '../src/undo/store.js'

let db: Db
let store: UndoStore
let projectId: number

function newProject(name = 'P'): number {
  return Number(db.prepare(`INSERT INTO projects (name, path) VALUES (?, ?)`).run(name, '/tmp/p').lastInsertRowid)
}

function mark(repoKey: string, n: number, extra: Partial<Omit<MarkRow, 'id' | 'createdAt'>> = {}): number {
  return store.insertMark({
    repoKey, n, repoTop: '/repo', ref: `refs/claudinei/${repoKey}/${n}`, commitSha: 'c'.repeat(40),
    headSha: null, branch: null, mode: 'full', kind: 'turn_start', active: [], big: [], listingHash: null, ...extra,
  })
}

beforeEach(() => {
  db = openDb(':memory:')
  store = createUndoStore(db)
  projectId = newProject()
})

describe('marcos', () => {
  it('numeração de marcos por chave', () => {
    expect(store.nextMarkN('k1')).toBe(1)
    mark('k1', store.nextMarkN('k1'))
    mark('k1', store.nextMarkN('k1'))
    expect(store.nextMarkN('k1')).toBe(3)
    expect(store.nextMarkN('k2')).toBe(1)
    expect(() => mark('k1', 2)).toThrow()
  })

  it('grava e lê o marco com o JSON parseado', () => {
    const big = [{ path: 'big.bin', size: 3_000_000, mtimeMs: 1 }]
    const id = mark('k', 1, { headSha: 'h'.repeat(40), branch: 'main', mode: 'limited', kind: 'message', active: [4, 5], big, listingHash: 'abc' })
    const m = store.mark(id)!
    expect(m).toMatchObject({ id, repoKey: 'k', n: 1, headSha: 'h'.repeat(40), branch: 'main', mode: 'limited', kind: 'message', active: [4, 5], big, listingHash: 'abc' })
    expect(typeof m.createdAt).toBe('string')
    expect(store.mark(9999)).toBeUndefined()
  })

  it('marksRange e latestMarks', () => {
    for (let n = 1; n <= 5; n++) mark('k', n)
    mark('outra', 1)
    expect(store.marksRange('k', 2, 4).map(m => m.n)).toEqual([2, 3, 4])
    expect(store.latestMarks('k', 2).map(m => m.n)).toEqual([5, 4])
  })
})

describe('listings', () => {
  it('listing deduplicado pelo hash', () => {
    const entries = [{ path: 'a', size: 1, mtimeMs: 2 }, { path: 'dir com espaço/b', size: 3, mtimeMs: 4 }]
    const h1 = store.putListing(entries)
    const h2 = store.putListing(entries.map(e => ({ ...e })))
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{40}$/)
    expect((db.prepare('SELECT COUNT(*) AS c FROM undo_listings').get() as { c: number }).c).toBe(1)
    expect(store.listing(h1)).toEqual(entries)
    expect(store.listing('0'.repeat(40))).toBeNull()
    const h3 = store.putListing([])
    expect(h3).not.toBe(h1)
    expect(store.listing(h3)).toEqual([])
  })
})

describe('turnos', () => {
  const base = { projectId: 0, localId: 'L1', engine: 'claude', origin: 'operator' as const }

  it('openTurn grava pendente e os padrões', () => {
    const id = store.openTurn({ ...base, projectId, textKey: 'faça y', repoKey: 'k', repoTop: '/repo' })
    expect(store.turn(id)).toMatchObject({
      id, localId: 'L1', projectId, engine: 'claude', origin: 'operator', textKey: 'faça y', midTurn: false,
      anchor: null, bornSessionId: null, conversationId: null, repoKey: 'k', repoTop: '/repo',
      startMark: null, endMark: null, endKind: null, snapshot: 'pending', snapshotError: null, limited: false,
      declared: [], summary: null, rewoundAt: null, endedAt: null,
    })
  })

  it('openTurns só os sem end', () => {
    const a = store.openTurn({ ...base, projectId })
    const b = store.openTurn({ ...base, projectId, midTurn: true })
    const m = mark('k', 1)
    store.setEnd(a, m, 'result', 'conv-1')
    expect(store.openTurns().map(t => t.id)).toEqual([b])
    const t = store.turn(a)!
    expect(t).toMatchObject({ endMark: m, endKind: 'result', conversationId: 'conv-1' })
    expect(t.endedAt).not.toBeNull()
    expect(store.turn(b)!.midTurn).toBe(true)
  })

  it('setRepo grava o repositório do turno aberto antes da resolução', () => {
    const a = store.openTurn({ ...base, projectId })
    store.setRepo(a, 'k2', '/repo2')
    expect(store.turn(a)).toMatchObject({ repoKey: 'k2', repoTop: '/repo2' })
  })

  it('setEnd com conversa nula mantém a que havia', () => {
    const a = store.openTurn({ ...base, projectId, conversationId: 'c0' })
    store.setEnd(a, null, 'dead', null)
    expect(store.turn(a)).toMatchObject({ conversationId: 'c0', endKind: 'dead', endMark: null })
  })

  it('setStart, markLate, setSnapshot, setAnchor, addDeclared e setSummary', () => {
    const a = store.openTurn({ ...base, projectId })
    store.markLate(a)
    store.setStart(a, mark('k', 1), 'ok', undefined, true)
    // Tardio não volta a ok quando o marco de início chega depois.
    expect(store.turn(a)).toMatchObject({ snapshot: 'late', limited: true, startMark: expect.any(Number) })
    store.setSnapshot(a, 'failed', 'git morreu')
    expect(store.turn(a)).toMatchObject({ snapshot: 'failed', snapshotError: 'git morreu' })
    store.setSnapshot(a, 'lost')
    expect(store.turn(a)).toMatchObject({ snapshot: 'lost', snapshotError: null })
    store.setAnchor(a, 'turn-xyz')
    store.addDeclared(a, ['a.ts', 'b.ts'])
    store.addDeclared(a, ['b.ts', 'c.ts'])
    const summary = { files: 3, added: 10, removed: 2, outside: 1, uncertain: 0, unsnapshotted: 0 }
    store.setSummary(a, summary)
    expect(store.turn(a)).toMatchObject({ anchor: 'turn-xyz', declared: ['a.ts', 'b.ts', 'c.ts'], summary })

    const b = store.openTurn({ ...base, projectId })
    store.setStart(b, null, 'no_git', 'sem git')
    expect(store.turn(b)).toMatchObject({ snapshot: 'no_git', snapshotError: 'sem git', startMark: null, limited: false })
  })

  it('terminalTurns por id, markRewound e setConversation', () => {
    const other = newProject('Q')
    const a = store.openTurn({ ...base, projectId })
    store.openTurn({ ...base, projectId, engine: 'codex' })
    store.openTurn({ ...base, projectId: other })
    const d = store.openTurn({ ...base, projectId })
    expect(store.terminalTurns(projectId, 'claude').map(t => t.id)).toEqual([a, d])
    store.markRewound([a])
    store.setConversation([a, d], 'novo')
    expect(store.turn(a)!.rewoundAt).not.toBeNull()
    expect(store.turn(d)!.rewoundAt).toBeNull()
    expect(store.turn(a)!.conversationId).toBe('novo')
    expect(store.turn(d)!.conversationId).toBe('novo')
    store.markRewound([])
    store.setConversation([], 'x')
  })
})

describe('desfazeres', () => {
  it('insertRun, run, lastRunFor e setRedone', () => {
    const files = [{ path: 'a.ts', result: 'reverted' as const }, { path: 'b.ts', result: 'kept' as const }]
    const r1 = store.insertRun({ projectId, engine: 'claude', kind: 'undo', turnIds: [1, 2], repoKey: 'k', preMark: 1, postMark: 2, files })
    const r2 = store.insertRun({ projectId, engine: 'claude', kind: 'undo', turnIds: [2], repoKey: 'k', preMark: 3, postMark: 4, files: [] })
    const redo = store.insertRun({ projectId, engine: 'claude', kind: 'redo', turnIds: [2], repoKey: 'k', preMark: 5, postMark: 6, files: [], redoOf: r2 })
    expect(store.run(r1)).toMatchObject({ id: r1, projectId, engine: 'claude', kind: 'undo', turnIds: [1, 2], repoKey: 'k', preMark: 1, postMark: 2, files, redoOf: null, redoneAt: null })
    expect(store.run(redo)!.redoOf).toBe(r2)
    expect(store.lastRunFor(1)!.id).toBe(r1)
    // O último desfazer do turno, não o refazer.
    expect(store.lastRunFor(2)!.id).toBe(r2)
    expect(store.lastRunFor(12)).toBeUndefined()
    store.setRedone(r2)
    expect(store.run(r2)!.redoneAt).not.toBeNull()
  })
})

describe('notas', () => {
  it('takeNote une duas notas e apaga', () => {
    expect(store.takeNote(projectId, 'claude')).toBeNull()
    store.addNote(projectId, 'claude', ['a.ts', 'b.ts'])
    store.addNote(projectId, 'claude', ['b.ts', 'c.ts'])
    store.addNote(projectId, 'codex', ['z.ts'])
    expect(store.takeNote(projectId, 'claude')).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(store.takeNote(projectId, 'claude')).toBeNull()
    expect(store.takeNote(projectId, 'codex')).toEqual(['z.ts'])
  })
})

describe('cascade', () => {
  it('excluir o projeto apaga turnos, desfazeres e notas (cascade)', () => {
    const other = newProject('Q')
    for (const p of [projectId, other]) {
      store.openTurn({ projectId: p, localId: 'L', engine: 'claude', origin: 'operator' })
      store.insertRun({ projectId: p, engine: 'claude', kind: 'undo', turnIds: [1], repoKey: 'k', preMark: null, postMark: null, files: [] })
      store.addNote(p, 'claude', ['a'])
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE project_id = ?`).get(projectId) as { c: number }).c
    expect(count('undo_turns')).toBe(0)
    expect(count('undo_runs')).toBe(0)
    expect(count('undo_notes')).toBe(0)
    expect(store.terminalTurns(other, 'claude')).toHaveLength(1)
    expect(store.takeNote(other, 'claude')).toEqual(['a'])
  })
})

describe('schema', () => {
  it('reabrir o banco não falha e os índices existem', () => {
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'undo_%'`).all() as { name: string }[]).map(r => r.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_undo_turns_terminal', 'idx_undo_turns_local', 'idx_undo_marks_repo']))
  })
})
