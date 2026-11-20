import type { Db } from '../db.js'
import type { Project } from '../projects.js'
import { createUsageIndexStore } from './store.js'

export type UsagePeriod = '24h' | '7d' | '30d' | '90d'

export interface UsageTotals { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; spent: number }

export interface UsageReport {
  period: UsagePeriod
  totals: UsageTotals
  cachePct: number // 0..100, uma casa decimal; 0 sem entrada
  terminals: Array<{
    projectIds: number[] // vazio = "Fora do Claudinei"; vários = pasta compartilhada
    names: string[]
    path: string | null
    byEngine: Record<string, UsageTotals>
    totals: UsageTotals
  }> // ordenado por totals.spent desc
  models: Array<{ model: string; engine: string; totals: UsageTotals }> // por spent desc
  series: Array<{ bucket: string; spent: number; cacheRead: number }> // horas (24h) ou dias locais
  oldestHour: string | null // hora mais antiga indexada
}

type ProjectRef = Pick<Project, 'id' | 'name' | 'path'>

const PERIOD_DAYS: Record<UsagePeriod, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Tira as barras do fim; a raiz '/' vira '' para que `'' + '/'` case com qualquer caminho absoluto. */
const trimSlashes = (p: string): string => p.replace(/\/+$/, '')

/**
 * Projetos donos de um `cwd`: vence a pasta igual ou a mais específica que o contém, sempre
 * por fronteira de diretório (`/a/proj2/x` não é de `/a/proj`). Devolve todos os projetos
 * daquela pasta (pasta compartilhada), na ordem da lista, ou `[]` sem casamento.
 */
export function matchProject(cwd: string, projects: ProjectRef[]): ProjectRef[] {
  if (!cwd) return []
  const dir = trimSlashes(cwd)
  let best: string | null = null
  let owners: ProjectRef[] = []
  for (const p of projects) {
    if (!p.path || !p.path.trim()) continue
    const path = trimSlashes(p.path)
    if (dir !== path && !dir.startsWith(path + '/')) continue
    if (best === null || path.length > best.length) {
      best = path
      owners = [p]
    } else if (path === best) {
      owners.push(p)
    }
  }
  return owners
}

const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, spent: 0 })

interface AggRow { hour: string; engine: string; model: string; cwd: string; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }

/** Soma a linha nos totais; `spent` = entrada + saída + escrito no cache (o raciocínio já está na saída). */
function add(t: UsageTotals, r: AggRow): void {
  t.input += r.input
  t.output += r.output
  t.cacheRead += r.cacheRead
  t.cacheWrite += r.cacheWrite
  t.reasoning += r.reasoning
  t.spent += r.input + r.output + r.cacheWrite
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Rótulo local ('YYYY-MM-DDTHH' ou 'YYYY-MM-DD') de um instante já deslocado para o fuso local. */
function label(localMs: number, hourly: boolean): string {
  const d = new Date(localMs)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return hourly ? `${day}T${pad(d.getUTCHours())}` : day
}

/** Início do balde local que contém o instante (deslocado para o fuso local). */
const bucketStart = (localMs: number, hourly: boolean): number =>
  Math.floor(localMs / (hourly ? HOUR_MS : DAY_MS)) * (hourly ? HOUR_MS : DAY_MS)

/** 'YYYY-MM-DDTHH' em UTC → início daquela hora em ms. */
const hourMs = (hour: string): number => Date.parse(`${hour}:00:00Z`)

const byTotals = (a: { totals: UsageTotals }, b: { totals: UsageTotals }): number =>
  b.totals.spent - a.totals.spent || b.totals.cacheRead - a.totals.cacheRead

/**
 * Relatório de uso do período: um SELECT agrupado por hora, motor, modelo e pasta a partir do
 * início do período; o casamento com os projetos e a montagem ficam em memória.
 */
export function buildUsageReport(
  db: Db,
  opts: { period: UsagePeriod; now: Date; tzOffsetMin: number; projects: ProjectRef[] },
): UsageReport {
  const { period, now, projects } = opts
  // Garante as tabelas mesmo se o indexador ainda não rodou nesta base.
  createUsageIndexStore(db)

  // Início do período: agora menos N dias, arredondado para baixo na hora UTC.
  const startMs = Math.floor((now.getTime() - PERIOD_DAYS[period] * DAY_MS) / HOUR_MS) * HOUR_MS
  const start = new Date(startMs).toISOString().slice(0, 13)

  const rows = db.prepare(`
    SELECT hour, engine, model, cwd,
      SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead,
      SUM(cache_write) AS cacheWrite, SUM(reasoning) AS reasoning
    FROM usage_hourly WHERE hour >= ?
    GROUP BY hour, engine, model, cwd
  `).all(start) as AggRow[]
  const oldest = db.prepare('SELECT MIN(hour) AS h FROM usage_hourly').get() as { h: string | null }

  // Série local, crescente e preenchida com zero do balde do início até o balde de agora.
  const hourly = period === '24h'
  const tzMs = (Number.isFinite(opts.tzOffsetMin) ? opts.tzOffsetMin : 0) * 60_000
  const step = hourly ? HOUR_MS : DAY_MS
  const series: UsageReport['series'] = []
  const seriesAt = new Map<string, UsageReport['series'][number]>()
  const lastBucket = bucketStart(now.getTime() - tzMs, hourly)
  for (let b = bucketStart(startMs - tzMs, hourly); b <= lastBucket; b += step) {
    const point = { bucket: label(b, hourly), spent: 0, cacheRead: 0 }
    series.push(point)
    seriesAt.set(point.bucket, point)
  }

  const totals = zero()
  const terminals = new Map<string | null, UsageReport['terminals'][number]>()
  const models = new Map<string, UsageReport['models'][number]>()
  const matchCache = new Map<string, ProjectRef[]>()

  for (const r of rows) {
    add(totals, r)

    let owners = matchCache.get(r.cwd)
    if (!owners) {
      owners = matchProject(r.cwd, projects)
      matchCache.set(r.cwd, owners)
    }
    const key = owners.length ? trimSlashes(owners[0].path) || '/' : null
    let term = terminals.get(key)
    if (!term) {
      term = { projectIds: owners.map(p => p.id), names: owners.map(p => p.name), path: key, byEngine: {}, totals: zero() }
      terminals.set(key, term)
    }
    add(term.totals, r)
    add(term.byEngine[r.engine] ??= zero(), r)

    const modelKey = `${r.engine}\u0000${r.model}`
    let model = models.get(modelKey)
    if (!model) {
      model = { model: r.model, engine: r.engine, totals: zero() }
      models.set(modelKey, model)
    }
    add(model.totals, r)

    // Linhas além de agora (relógio adiantado) ficam fora da série, mas contam nos totais.
    const point = seriesAt.get(label(hourMs(r.hour) - tzMs, hourly))
    if (point) {
      point.spent += r.input + r.output + r.cacheWrite
      point.cacheRead += r.cacheRead
    }
  }

  const cacheBase = totals.input + totals.cacheRead + totals.cacheWrite
  return {
    period,
    totals,
    cachePct: cacheBase ? Math.round((totals.cacheRead / cacheBase) * 1000) / 10 : 0,
    terminals: [...terminals.values()].filter(t => t.totals.spent > 0 || t.totals.cacheRead > 0).sort(byTotals),
    models: [...models.values()].sort(byTotals),
    series,
    oldestHour: oldest.h,
  }
}
