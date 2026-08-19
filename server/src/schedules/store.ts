import { mkdirSync, readFileSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db.js'
import { nextRun, validateCadence, type Cadence } from './cadence.js'

/** Teto do conteúdo guardado por execução. */
export const MAX_CONTENT = 128 * 1024
/** Quanto do último resultado a listagem carrega junto (o resto vem sob demanda). */
export const PREVIEW_BYTES = 4096
const TRUNCATED = '\n\n_[resultado cortado em 128 KB]_\n'

export type RunStatus = 'running' | 'ok' | 'error' | 'timeout' | 'skipped'

export interface ScheduleRun {
  id: number
  scheduleId: number
  seq: number
  startedAt: string
  finishedAt: string | null
  status: RunStatus
  title: string | null
  contentSize: number | null
  error: string | null
  localId: string | null
  late: boolean
  /** Só na listagem do último: início do conteúdo, para a tela abrir já com algo. */
  preview?: string | null
}

export interface Schedule {
  id: number
  projectId: number
  name: string
  task: string
  cadence: Cadence
  engine: string | null
  model: string | null
  effort: string | null
  expectsResult: boolean
  keepResults: number
  enabled: boolean
  nextRunAt: string | null
  consecutiveFailures: number
  runCount: number
  lastRun?: ScheduleRun | null
}

export interface ScheduleInput {
  name: string
  task: string
  cadence: Cadence
  engine?: string | null
  model?: string | null
  effort?: string | null
  expectsResult?: boolean
  keepResults?: number
}

/**
 * Extrai o título do resultado: a primeira linha útil, sem as marcas de markdown
 * que só fazem sentido renderizadas. É o que o feed lista — e o que sobra quando o
 * conteúdo já foi podado.
 */
export function titleOf(content: string): string | null {
  for (const raw of content.split('\n')) {
    const line = raw
      .replace(/^\s*#{1,6}\s*/, '')      // cabeçalho
      .replace(/^\s*[-*+>]\s+/, '')      // lista/citação
      .replace(/\*\*|__|`/g, '')         // ênfase e código inline
      .trim()
    if (line) return line.slice(0, 100)
  }
  return null
}

const truncate = (content: string): string => {
  if (Buffer.byteLength(content) <= MAX_CONTENT) return content
  // Corta por BYTES (não por caracteres): um resultado cheio de acentos ou emoji
  // estouraria o teto se contássemos posições de string.
  const cut = Buffer.from(content).subarray(0, MAX_CONTENT).toString('utf8')
  return cut + TRUNCATED
}

const rowToSchedule = (r: any): Schedule => ({
  id: r.id, projectId: r.project_id, name: r.name, task: r.task,
  cadence: JSON.parse(r.cadence) as Cadence,
  engine: r.engine ?? null, model: r.model ?? null, effort: r.effort ?? null,
  expectsResult: !!r.expects_result, keepResults: r.keep_results,
  enabled: !!r.enabled, nextRunAt: r.next_run_at ?? null,
  consecutiveFailures: r.consecutive_failures, runCount: r.run_count,
})

const rowToRun = (r: any): ScheduleRun => ({
  id: r.id, scheduleId: r.schedule_id, seq: r.seq, startedAt: r.started_at,
  finishedAt: r.finished_at ?? null, status: r.status as RunStatus,
  title: r.title ?? null, contentSize: r.content_size ?? null,
  error: r.error ?? null, localId: r.local_id ?? null, late: !!r.late,
})

/**
 * Agendamentos e suas execuções. O conteúdo dos resultados vive em disco
 * (`<dir>/<scheduleId>/<seq>.md`) e o banco guarda só título e tamanho — ver a
 * spec de 2026-08-18 para o porquê.
 */
export function createSchedulesStore(db: Db, opts: { dir: string }) {
  const dirOf = (scheduleId: number) => join(opts.dir, String(scheduleId))
  const fileOf = (scheduleId: number, seq: number) => join(dirOf(scheduleId), `${seq}.md`)

  const computeNext = (cadence: Cadence, from = new Date()): string | null =>
    nextRun(cadence, from, 1)[0]?.toISOString() ?? null

  /** Apaga as execuções que passam do limite, com seus arquivos. */
  const prune = (scheduleId: number, keep: number): void => {
    const doomed = db.prepare(
      `SELECT id, seq FROM schedule_runs WHERE schedule_id=? ORDER BY seq DESC LIMIT -1 OFFSET ?`,
    ).all(scheduleId, keep) as any[]
    for (const r of doomed) {
      try { rmSync(fileOf(scheduleId, r.seq)) } catch { /* já não existe */ }
      db.prepare(`DELETE FROM schedule_runs WHERE id=?`).run(r.id)
    }
  }

  const store = {
    list(): Schedule[] {
      return (db.prepare(`SELECT * FROM schedules ORDER BY id ASC`).all() as any[]).map(rowToSchedule)
    },

    get(id: number): Schedule | null {
      const r = db.prepare(`SELECT * FROM schedules WHERE id=?`).get(id) as any
      return r ? rowToSchedule(r) : null
    },

    /** Do terminal, cada um já com o último resultado (título + preview). */
    listByProject(projectId: number): Schedule[] {
      return (db.prepare(`SELECT * FROM schedules WHERE project_id=? ORDER BY id ASC`).all(projectId) as any[])
        .map(rowToSchedule)
        .map((s) => ({ ...s, lastRun: store.lastRun(s.id) }))
    },

    create(projectId: number, input: ScheduleInput): Schedule {
      const problem = validateCadence(input.cadence)
      if (problem) throw new Error(problem)
      const info = db.prepare(`
        INSERT INTO schedules (project_id, name, task, cadence, engine, model, effort, expects_result, keep_results, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        projectId, input.name, input.task, JSON.stringify(input.cadence),
        input.engine ?? null, input.model ?? null, input.effort ?? null,
        input.expectsResult === false ? 0 : 1, input.keepResults ?? 10,
        computeNext(input.cadence),
      )
      return store.get(Number(info.lastInsertRowid))!
    },

    update(id: number, patch: Partial<ScheduleInput>): Schedule {
      const cur = store.get(id)
      if (!cur) throw new Error(`agendamento ${id} não existe`)
      if (patch.cadence) {
        const problem = validateCadence(patch.cadence)
        if (problem) throw new Error(problem)
      }
      const next = { ...cur, ...patch }
      db.prepare(`
        UPDATE schedules SET name=?, task=?, cadence=?, engine=?, model=?, effort=?,
                             expects_result=?, keep_results=?, next_run_at=?
        WHERE id=?`).run(
        next.name, next.task, JSON.stringify(next.cadence),
        next.engine ?? null, next.model ?? null, next.effort ?? null,
        next.expectsResult === false ? 0 : 1, next.keepResults ?? 10,
        // Trocar a cadência sem recalcular deixaria o agendamento preso ao horário
        // antigo até disparar uma vez.
        cur.enabled ? computeNext(next.cadence) : null,
        id,
      )
      if (patch.keepResults !== undefined) prune(id, patch.keepResults)
      return store.get(id)!
    },

    setEnabled(id: number, enabled: boolean): Schedule {
      const cur = store.get(id)
      if (!cur) throw new Error(`agendamento ${id} não existe`)
      // Pausado zera o horário; retomar recalcula a partir de AGORA — um agendamento
      // pausado por uma semana não deve acordar devendo execuções.
      db.prepare(`UPDATE schedules SET enabled=?, next_run_at=? WHERE id=?`)
        .run(enabled ? 1 : 0, enabled ? computeNext(cur.cadence) : null, id)
      return store.get(id)!
    },

    remove(id: number): void {
      db.prepare(`DELETE FROM schedule_runs WHERE schedule_id=?`).run(id)
      db.prepare(`DELETE FROM schedules WHERE id=?`).run(id)
      try { rmSync(dirOf(id), { recursive: true }) } catch { /* nunca teve resultado */ }
    },

    /** Habilitados cujo horário já chegou. */
    due(now: Date): Schedule[] {
      return (db.prepare(`SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC`)
        .all(now.toISOString()) as any[]).map(rowToSchedule)
    },

    /** Recalcula o próximo horário a partir de `from` (o agendador chama após disparar). */
    reschedule(id: number, from = new Date()): void {
      const cur = store.get(id)
      if (!cur || !cur.enabled) return
      db.prepare(`UPDATE schedules SET next_run_at=? WHERE id=?`).run(computeNext(cur.cadence, from), id)
    },

    // ---- execuções ----

    startRun(scheduleId: number, opts: { late?: boolean; localId?: string }): ScheduleRun {
      const seq = ((db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM schedule_runs WHERE schedule_id=?`)
        .get(scheduleId) as any).n as number) + 1
      const info = db.prepare(`
        INSERT INTO schedule_runs (schedule_id, seq, started_at, status, local_id, late)
        VALUES (?, ?, ?, 'running', ?, ?)`).run(
        scheduleId, seq, new Date().toISOString(), opts.localId ?? null, opts.late ? 1 : 0)
      db.prepare(`UPDATE schedules SET run_count = run_count + 1 WHERE id=?`).run(scheduleId)
      return rowToRun(db.prepare(`SELECT * FROM schedule_runs WHERE id=?`).get(Number(info.lastInsertRowid)))
    },

    finishRun(runId: number, res: { status: RunStatus; content?: string; error?: string; localId?: string }): ScheduleRun {
      const run = db.prepare(`SELECT * FROM schedule_runs WHERE id=?`).get(runId) as any
      if (!run) throw new Error(`execução ${runId} não existe`)

      let title: string | null = null
      let size: number | null = null
      let writeError: string | undefined
      if (res.content) {
        const content = truncate(res.content)
        title = titleOf(content)
        try {
          mkdirSync(dirOf(run.schedule_id), { recursive: true })
          writeFileSync(fileOf(run.schedule_id, run.seq), content)
          size = Buffer.byteLength(content)
        } catch (err) {
          // Falhar a execução inteira porque o disco não aceitou o arquivo seria pior
          // que registrar o que aconteceu: a tarefa RODOU.
          writeError = `resultado não pôde ser gravado: ${(err as Error).message}`
        }
      }
      db.prepare(`
        UPDATE schedule_runs SET finished_at=?, status=?, title=?, content_size=?, error=?, local_id=COALESCE(?, local_id)
        WHERE id=?`).run(
        new Date().toISOString(), res.status, title ?? res.error?.slice(0, 100) ?? null, size,
        [res.error, writeError].filter(Boolean).join(' · ') || null, res.localId ?? null, runId)

      const failed = res.status !== 'ok' && res.status !== 'skipped'
      db.prepare(`UPDATE schedules SET consecutive_failures = ${failed ? 'consecutive_failures + 1' : '0'} WHERE id=?`)
        .run(run.schedule_id)

      const keep = (db.prepare(`SELECT keep_results FROM schedules WHERE id=?`).get(run.schedule_id) as any)?.keep_results ?? 10
      prune(run.schedule_id, keep)
      return rowToRun(db.prepare(`SELECT * FROM schedule_runs WHERE id=?`).get(runId))
    },

    hasRunning(scheduleId: number): boolean {
      return !!db.prepare(`SELECT 1 FROM schedule_runs WHERE schedule_id=? AND status='running'`).get(scheduleId)
    },

    listRuns(scheduleId: number, limit = 20): ScheduleRun[] {
      return (db.prepare(`SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY seq DESC LIMIT ?`)
        .all(scheduleId, limit) as any[]).map(rowToRun)
    },

    /** A execução mais recente, com o começo do conteúdo já embutido. */
    lastRun(scheduleId: number): ScheduleRun | null {
      const r = db.prepare(`SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY seq DESC LIMIT 1`).get(scheduleId) as any
      if (!r) return null
      const run = rowToRun(r)
      return { ...run, preview: run.contentSize ? store.readPreview(scheduleId, run.seq) : null }
    },

    /** Conteúdo completo, ou null se o arquivo se perdeu (a execução continua no feed). */
    readContent(scheduleId: number, seq: number): string | null {
      try { return readFileSync(fileOf(scheduleId, seq), 'utf8') } catch { return null }
    },

    /** Só o começo do arquivo: a listagem não pode custar 128 KB por agendamento. */
    readPreview(scheduleId: number, seq: number): string | null {
      let fd: number | undefined
      try {
        fd = openSync(fileOf(scheduleId, seq), 'r')
        const buf = Buffer.alloc(PREVIEW_BYTES)
        const read = readSync(fd, buf, 0, PREVIEW_BYTES, 0)
        return buf.subarray(0, read).toString('utf8')
      } catch {
        return null
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    },
  }
  return store
}

export type SchedulesStore = ReturnType<typeof createSchedulesStore>
