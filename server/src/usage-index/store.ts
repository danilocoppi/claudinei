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

// As linhas guardam o arquivo de origem para que um arquivo reescrito possa
// ser desfeito; a consulta do relatório agrega ignorando `file`.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_files (path TEXT PRIMARY KEY, engine TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, offset INTEGER NOT NULL, parser TEXT);
CREATE TABLE IF NOT EXISTS usage_hourly (file TEXT NOT NULL, hour TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (file, hour, engine, model, cwd));
CREATE INDEX IF NOT EXISTS idx_usage_hourly_hour ON usage_hourly(hour);
CREATE TABLE IF NOT EXISTS usage_seen (key TEXT PRIMARY KEY, file TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_usage_seen_file ON usage_seen(file);
`

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
  db.exec(SCHEMA)

  const selectFile = db.prepare('SELECT path, engine, size, mtime_ms, offset, parser FROM usage_files WHERE path = ?')
  const countFiles = db.prepare('SELECT COUNT(*) AS n FROM usage_files')
  const saveFile = db.prepare(`
    INSERT OR REPLACE INTO usage_files (path, engine, size, mtime_ms, offset, parser)
    VALUES (@path, @engine, @size, @mtimeMs, @offset, @parser)
  `)
  const markSeen = db.prepare('INSERT OR IGNORE INTO usage_seen (key, file) VALUES (?, ?)')
  const addHourly = db.prepare(`
    INSERT INTO usage_hourly (file, hour, engine, model, cwd, input, output, cache_read, cache_write, reasoning)
    VALUES (@file, @hour, @engine, @model, @cwd, @input, @output, @cacheRead, @cacheWrite, @reasoning)
    ON CONFLICT(file, hour, engine, model, cwd) DO UPDATE SET
      input = input + excluded.input,
      output = output + excluded.output,
      cache_read = cache_read + excluded.cache_read,
      cache_write = cache_write + excluded.cache_write,
      reasoning = reasoning + excluded.reasoning
  `)
  const deleteHourly = db.prepare('DELETE FROM usage_hourly WHERE file = ?')
  const deleteSeen = db.prepare('DELETE FROM usage_seen WHERE file = ?')
  const deleteFile = db.prepare('DELETE FROM usage_files WHERE path = ?')

  const commit = db.transaction((state: FileState, hits: Array<{ key?: string; row: UsageRow }>): number => {
    let counted = 0
    for (const { key, row } of hits) {
      // A chave vale entre arquivos: se outro arquivo já a contou, o hit é descartado.
      if (key !== undefined && markSeen.run(key, state.path).changes !== 1) continue
      addHourly.run({
        file: state.path,
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
    saveFile.run(state)
    return counted
  })

  const reset = db.transaction((path: string): void => {
    deleteHourly.run(path)
    deleteSeen.run(path)
    deleteFile.run(path)
  })

  return {
    file(path: string): FileState | undefined {
      const r = selectFile.get(path) as FileRow | undefined
      if (!r) return undefined
      return { path: r.path, engine: r.engine, size: r.size, mtimeMs: r.mtime_ms, offset: r.offset, parser: r.parser }
    },
    /**
     * Numa transação só: para cada hit com `key`, registra a chave para `state.path` e descarta o
     * hit se a chave já tinha sido contada (em qualquer arquivo); soma os hits que sobraram em
     * `usage_hourly` e grava o novo estado do arquivo. Devolve quantos hits foram contados.
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
