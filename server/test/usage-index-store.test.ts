import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { openDb, type Db } from '../src/db.js'
import { createUsageIndexStore, ensureUsageSchema, usageKeyHash, type FileState, type UsageRow } from '../src/usage-index/store.js'

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
  (db.prepare('SELECT COALESCE(SUM(input), 0) AS n FROM usage_index_hourly').get() as { n: number }).n

/** Chaves guardadas, como os hashes que o repositório grava, em ordem. */
const chaves = (): bigint[] =>
  (db.prepare('SELECT key FROM usage_index_keys ORDER BY key').safeIntegers().all() as { key: bigint }[]).map(r => r.key)

const hashes = (...keys: string[]): bigint[] => keys.map(usageKeyHash).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

const fileId = (path: string): number | undefined =>
  (db.prepare('SELECT id FROM usage_index_files WHERE path = ?').get(path) as { id: number } | undefined)?.id

describe('createUsageIndexStore', () => {
  it('commitSlice soma na mesma hora/motor/modelo/pasta', () => {
    const store = createUsageIndexStore(db)
    expect(store.commitSlice(state('a.jsonl', 100), [{ row: row({ input: 10 }) }])).toBe(1)
    expect(store.commitSlice(state('a.jsonl', 200), [{ row: row({ input: 7 }) }])).toBe(1)
    const linhas = db.prepare('SELECT * FROM usage_index_hourly').all() as Array<Record<string, unknown>>
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
    expect(chaves()).toEqual(hashes('m1:r1'))
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

  it('com hash: chaves diferentes contam, a repetida entre arquivos não, e só números ficam no banco', () => {
    const store = createUsageIndexStore(db)
    expect(store.commitSlice(state('a.jsonl', 100), [
      { key: 'msg_01:req_01', row: row({ input: 1 }) },
      { key: 'msg_01:req_02', row: row({ input: 2 }) },
      { key: 'msg_02', row: row({ input: 4 }) },
    ])).toBe(3)
    expect(store.commitSlice(state('b.jsonl', 100), [
      { key: 'msg_01:req_02', row: row({ input: 100 }) },
      { key: 'msg_02', row: row({ input: 100 }) },
      { key: 'msg_03:req_03', row: row({ input: 8 }) },
    ])).toBe(1)
    expect(somaInput()).toBe(15)
    expect(chaves()).toEqual(hashes('msg_01:req_01', 'msg_01:req_02', 'msg_02', 'msg_03:req_03'))
    // nem a chave nem o caminho vão como texto para as linhas de chave e de uso
    const tipos = db.prepare('SELECT DISTINCT typeof(key) AS k, typeof(file) AS f FROM usage_index_keys').all()
    expect(tipos).toEqual([{ k: 'integer', f: 'integer' }])
    expect(db.prepare('SELECT DISTINCT typeof(file) AS f FROM usage_index_hourly').all()).toEqual([{ f: 'integer' }])
  })

  it('usageKeyHash: os 8 primeiros bytes do sha256 da chave, com sinal', () => {
    const esperado = createHash('sha256').update('msg_01:req_01').digest().readBigInt64BE(0)
    expect(usageKeyHash('msg_01:req_01')).toBe(esperado)
    expect(usageKeyHash('msg_01:req_01')).not.toBe(usageKeyHash('msg_01:req_02'))
  })

  it('o id do arquivo fica estável entre as fatias', () => {
    const store = createUsageIndexStore(db)
    store.commitSlice(state('a.jsonl', 100), [{ key: 'ka1', row: row() }])
    const id = fileId('a.jsonl')
    expect(id).toBeTypeOf('number')
    store.commitSlice(state('b.jsonl', 100), [{ key: 'kb1', row: row() }])
    store.commitSlice({ ...state('a.jsonl', 200), parser: '{"x":1}' }, [{ key: 'ka2', row: row({ hour: '2026-11-20T11' }) }])
    store.commitSlice(state('a.jsonl', 300), [])
    expect(fileId('a.jsonl')).toBe(id)
    expect(store.file('a.jsonl')).toEqual(state('a.jsonl', 300))
    // as linhas e as chaves das três fatias continuam presas ao mesmo id
    expect(db.prepare('SELECT DISTINCT file FROM usage_index_hourly WHERE hour = ?').all('2026-11-20T11')).toEqual([{ file: id }])
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_index_keys WHERE file = ?').get(id) as { n: number }).n).toBe(2)
    expect(store.fileCount()).toBe(2)
  })

  it('resetFile apaga o que veio do arquivo e mantém o resto', () => {
    const store = createUsageIndexStore(db)
    store.commitSlice(state('a', 100), [{ key: 'ka', row: row({ input: 10 }) }])
    store.commitSlice(state('b', 100), [{ key: 'kb', row: row({ input: 4 }) }])
    store.resetFile('a')
    expect(somaInput()).toBe(4)
    expect(chaves()).toEqual(hashes('kb'))
    expect(store.file('a')).toBeUndefined()
    expect(store.file('b')?.offset).toBe(100)
    expect(store.fileCount()).toBe(1)
    // a chave apagada volta a contar quando o arquivo é relido
    expect(store.commitSlice(state('a', 50), [{ key: 'ka', row: row({ input: 10 }) }])).toBe(1)
    expect(somaInput()).toBe(14)
    // arquivo que nunca foi indexado: nada acontece
    store.resetFile('nunca')
    expect(store.fileCount()).toBe(2)
  })

  it('ensureUsageSchema cria as tabelas e pode rodar de novo', () => {
    ensureUsageSchema(db)
    ensureUsageSchema(db)
    const nomes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'usage_index_%' ORDER BY name").all() as { name: string }[])
      .map(r => r.name)
    expect(nomes).toEqual(['usage_index_files', 'usage_index_hourly', 'usage_index_keys'])
    createUsageIndexStore(db)
  })
})
