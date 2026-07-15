import type { Db } from './db.js'

export interface EngineTokens {
  input: number
  cachedInput: number
  output: number
  reasoning: number
  total: number
}

/** total = soma cumulativa de todos os dias; today = só a linha do dia corrente (UTC), zerada se ainda não houve record hoje. */
export interface EngineUsageEntry {
  total: EngineTokens
  today: EngineTokens
}

export interface EngineUsageService {
  record(engine: string, tokens: EngineTokens): void
  all(): Record<string, EngineUsageEntry>
}

const ZERO_TOKENS: EngineTokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }

// engine_usage (cumulativa, sem bucket por dia) é descartada aqui: dados de
// poucas horas, perda desprezível frente ao ganho de "hoje" por engine.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS engine_usage_daily (
  engine TEXT NOT NULL,
  day TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  cached_input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (engine, day)
);
DROP TABLE IF EXISTS engine_usage;
`

interface Row {
  engine: string
  input: number
  cached_input: number
  output: number
  reasoning: number
  total: number
}

const rowToTokens = (r: Row): EngineTokens => ({
  input: r.input,
  cachedInput: r.cached_input,
  output: r.output,
  reasoning: r.reasoning,
  total: r.total,
})

/**
 * Acumulador persistido de tokens por engine (ex.: codex), bucketado por DIA
 * (UTC), separado dos limites de plano do Claude (que vêm de
 * createUsageService/OAuth). O Claude não popula `tokens` no evento result,
 * então nunca soma nada aqui — engine-agnóstico: qualquer engine que setar
 * `tokens` é contabilizada. `now` é injetável para teste (clock fixo).
 */
export function createEngineUsageService(db: Db, now: () => Date = () => new Date()): EngineUsageService {
  db.exec(SCHEMA)

  const today = (): string => now().toISOString().slice(0, 10)

  const upsert = db.prepare(`
    INSERT INTO engine_usage_daily (engine, day, input, cached_input, output, reasoning, total, updated_at)
    VALUES (@engine, @day, @input, @cachedInput, @output, @reasoning, @total, datetime('now'))
    ON CONFLICT(engine, day) DO UPDATE SET
      input = input + @input,
      cached_input = cached_input + @cachedInput,
      output = output + @output,
      reasoning = reasoning + @reasoning,
      total = total + @total,
      updated_at = datetime('now')
  `)

  const selectTotals = db.prepare(`
    SELECT engine,
      SUM(input) AS input, SUM(cached_input) AS cached_input,
      SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(total) AS total
    FROM engine_usage_daily GROUP BY engine
  `)

  const selectToday = db.prepare(`
    SELECT engine, input, cached_input, output, reasoning, total
    FROM engine_usage_daily WHERE day = ?
  `)

  return {
    record(engine, tokens) {
      upsert.run({
        engine,
        day: today(),
        input: tokens.input,
        cachedInput: tokens.cachedInput,
        output: tokens.output,
        reasoning: tokens.reasoning,
        total: tokens.total,
      })
    },

    all() {
      const totals = selectTotals.all() as Row[]
      const todays = selectToday.all(today()) as Row[]
      const todayByEngine = new Map(todays.map((r) => [r.engine, r]))
      const out: Record<string, EngineUsageEntry> = {}
      for (const r of totals) {
        const t = todayByEngine.get(r.engine)
        out[r.engine] = { total: rowToTokens(r), today: t ? rowToTokens(t) : { ...ZERO_TOKENS } }
      }
      return out
    },
  }
}
