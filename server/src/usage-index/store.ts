import { createHash } from 'node:crypto'
import type { Db } from '../db.js'

export type UsageEngine = 'claude' | 'codex'

/** Um pedido já lido do histórico: só números, modelo, pasta e hora — nunca texto de mensagem. */
export interface UsageRow {
  hour: string // UTC, 'YYYY-MM-DDTHH'
  engine: UsageEngine
  model: string
  cwd: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface FileState {
  path: string
  engine: UsageEngine
  size: number
  mtimeMs: number
  offset: number
  parser: string | null // JSON do estado do leitor do Codex (modelo/cwd/último total); null no Claude
}

// Tabelas novas (`usage_index_*`): o formato antigo, com a chave e o caminho em texto em cada
// linha, ocupava ~400 bytes por pedido; os nomes novos evitam colidir com uma base de teste velha.
// Cada arquivo ganha um id inteiro estável, e as linhas de uso e de chave guardam só esse id,
// para que um arquivo reescrito possa ser desfeito; a consulta do relatório agrega ignorando `file`.
// A chave de deduplicação é guardada como hash de 64 bits (INTEGER PRIMARY KEY, a própria rowid).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_index_files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, engine TEXT NOT NULL,
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, offset INTEGER NOT NULL, parser TEXT);
CREATE TABLE IF NOT EXISTS usage_index_hourly (file INTEGER NOT NULL, hour TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (file, hour, engine, model, cwd)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_usage_index_hourly_hour ON usage_index_hourly(hour);
CREATE TABLE IF NOT EXISTS usage_index_keys (key INTEGER PRIMARY KEY, file INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_usage_index_keys_file ON usage_index_keys(file);
`

/** Cria as tabelas do índice de uso, se faltarem. Barato e idempotente; o relatório chama uma vez ao registrar a rota. */
export function ensureUsageSchema(db: Db): void {
  db.exec(SCHEMA)
}

/**
 * Hash de 64 bits da chave de deduplicação (`message.id` + `requestId`): os 8 primeiros bytes
 * do sha256, lidos como inteiro com sinal, que é o que cabe numa INTEGER do SQLite. Com 1 milhão
 * de chaves a chance de haver alguma colisão fica abaixo de 1 em 10 milhões; uma colisão só
 * descartaria um pedido.
 */
export function usageKeyHash(key: string): bigint {
  return createHash('sha256').update(key).digest().readBigInt64BE(0)
}

interface FileRow {
  path: string
  engine: UsageEngine
  size: number
  mtime_ms: number
  offset: number
  parser: string | null
}

/**
 * Repositório do índice de uso lido dos históricos locais do Claude e do Codex.
 * Cada fatia lida de um arquivo é gravada numa transação só (linhas, chaves e
 * offset juntos), para que uma parada no meio da passada deixe o banco coerente.
 */
export function createUsageIndexStore(db: Db) {
  ensureUsageSchema(db)

  const selectFile = db.prepare('SELECT path, engine, size, mtime_ms, offset, parser FROM usage_index_files WHERE path = ?')
  const selectFileId = db.prepare('SELECT id FROM usage_index_files WHERE path = ?')
  const countFiles = db.prepare('SELECT COUNT(*) AS n FROM usage_index_files')
  // ON CONFLICT ... DO UPDATE mantém o id do arquivo (INSERT OR REPLACE apagaria a linha e daria outro).
  const saveFile = db.prepare(`
    INSERT INTO usage_index_files (path, engine, size, mtime_ms, offset, parser)
    VALUES (@path, @engine, @size, @mtimeMs, @offset, @parser)
    ON CONFLICT(path) DO UPDATE SET
      engine = excluded.engine, size = excluded.size, mtime_ms = excluded.mtime_ms,
      offset = excluded.offset, parser = excluded.parser
    RETURNING id
  `)
  const markSeen = db.prepare('INSERT OR IGNORE INTO usage_index_keys (key, file) VALUES (?, ?)')
  const addHourly = db.prepare(`
    INSERT INTO usage_index_hourly (file, hour, engine, model, cwd, input, output, cache_read, cache_write, reasoning)
    VALUES (@file, @hour, @engine, @model, @cwd, @input, @output, @cacheRead, @cacheWrite, @reasoning)
    ON CONFLICT(file, hour, engine, model, cwd) DO UPDATE SET
      input = input + excluded.input,
      output = output + excluded.output,
      cache_read = cache_read + excluded.cache_read,
      cache_write = cache_write + excluded.cache_write,
      reasoning = reasoning + excluded.reasoning
  `)
  const deleteHourly = db.prepare('DELETE FROM usage_index_hourly WHERE file = ?')
  const deleteSeen = db.prepare('DELETE FROM usage_index_keys WHERE file = ?')
  const deleteFile = db.prepare('DELETE FROM usage_index_files WHERE id = ?')

  const commit = db.transaction((state: FileState, hits: Array<{ key?: string; row: UsageRow }>): number => {
    // O estado vai primeiro para dar o id do arquivo; a transação desfaz tudo se uma linha falhar.
    const { id } = saveFile.get(state) as { id: number }
    let counted = 0
    for (const { key, row } of hits) {
      // A chave vale entre arquivos: se outro arquivo já a contou, o hit é descartado.
      if (key !== undefined && markSeen.run(usageKeyHash(key), id).changes !== 1) continue
      addHourly.run({
        file: id,
        hour: row.hour,
        engine: row.engine,
        model: row.model,
        cwd: row.cwd,
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        reasoning: row.reasoning,
      })
      counted++
    }
    return counted
  })

  const reset = db.transaction((path: string): void => {
    const found = selectFileId.get(path) as { id: number } | undefined
    if (!found) return
    deleteHourly.run(found.id)
    deleteSeen.run(found.id)
    deleteFile.run(found.id)
  })

  return {
    file(path: string): FileState | undefined {
      const r = selectFile.get(path) as FileRow | undefined
      if (!r) return undefined
      return { path: r.path, engine: r.engine, size: r.size, mtimeMs: r.mtime_ms, offset: r.offset, parser: r.parser }
    },
    /**
     * Numa transação só: grava o novo estado do arquivo e, para cada hit com `key`, registra a
     * chave para esse arquivo e descarta o hit se a chave já tinha sido contada (em qualquer
     * arquivo); soma os hits que sobraram em `usage_index_hourly`. Devolve quantos foram contados.
     */
    commitSlice(state: FileState, hits: Array<{ key?: string; row: UsageRow }>): number {
      return commit(state, hits)
    },
    /** Arquivo reescrito: apaga as linhas e as chaves que vieram dele e o estado salvo. */
    resetFile(path: string): void {
      reset(path)
    },
    fileCount(): number {
      return (countFiles.get() as { n: number }).n
    },
  }
}

export type UsageIndexStore = ReturnType<typeof createUsageIndexStore>
