import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createUsageIndexStore, type FileState, type UsageRow } from '../src/usage-index/store.js'

let db: Db

beforeEach(() => {
  db = openDb(':memory:')
})

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  hour: '2026-11-20T10', engine: 'claude', model: 'claude-opus', cwd: '/a/proj',
  input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 0,
  ...over,
})

const state = (path: string, offset: number): FileState => ({
  path, engine: 'claude', size: offset, mtimeMs: 1000, offset, parser: null,
})

const somaInput = (): number =>
  (db.prepare('SELECT COALESCE(SUM(input), 0) AS n FROM usage_hourly').get() as { n: number }).n

const chaves = (): string[] =>
  (db.prepare('SELECT key FROM usage_seen ORDER BY key').all() as { key: string }[]).map(r => r.key)

describe('createUsageIndexStore', () => {
  it('commitSlice soma na mesma hora/motor/modelo/pasta', () => {
    const store = createUsageIndexStore(db)
    expect(store.commitSlice(state('a.jsonl', 100), [{ row: row({ input: 10 }) }])).toBe(1)
    expect(store.commitSlice(state('a.jsonl', 200), [{ row: row({ input: 7 }) }])).toBe(1)
    const linhas = db.prepare('SELECT * FROM usage_hourly').all() as Array<Record<string, unknown>>
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ input: 17, output: 10, cache_read: 6, cache_write: 4, reasoning: 0 })
    expect(store.file('a.jsonl')).toEqual(state('a.jsonl', 200))
    expect(store.fileCount()).toBe(1)
  })

  it('commitSlice grava linhas e offset juntos', () => {
    const store = createUsageIndexStore(db)
    store.commitSlice(state('a.jsonl', 100), [{ key: 'm1:r1', row: row() }])
    const quebrada = row({ hour: null as unknown as string })
    expect(() => store.commitSlice(state('a.jsonl', 200), [
      { key: 'm2:r2', row: row({ input: 50 }) },
      { key: 'm3:r3', row: quebrada },
    ])).toThrow()
    expect(somaInput()).toBe(10)
    expect(chaves()).toEqual(['m1:r1'])
    expect(store.file('a.jsonl')?.offset).toBe(100)
  })

  it('chave já contada é descartada, mesmo vinda de outro arquivo', () => {
    const store = createUsageIndexStore(db)
    expect(store.commitSlice(state('a.jsonl', 100), [{ key: 'm1:r1', row: row() }])).toBe(1)
    expect(store.commitSlice(state('b.jsonl', 100), [{ key: 'm1:r1', row: row() }])).toBe(0)
    expect(somaInput()).toBe(10)
    // o estado do arquivo é gravado mesmo sem hit contado
    expect(store.file('b.jsonl')?.offset).toBe(100)
  })

  it('resetFile apaga o que veio do arquivo e mantém o resto', () => {
    const store = createUsageIndexStore(db)
    store.commitSlice(state('a', 100), [{ key: 'ka', row: row({ input: 10 }) }])
    store.commitSlice(state('b', 100), [{ key: 'kb', row: row({ input: 4 }) }])
    store.resetFile('a')
    expect(somaInput()).toBe(4)
    expect(chaves()).toEqual(['kb'])
    expect(store.file('a')).toBeUndefined()
    expect(store.file('b')?.offset).toBe(100)
    expect(store.fileCount()).toBe(1)
  })
})
