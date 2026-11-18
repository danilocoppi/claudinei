/**
 * Acompanhamento de tarefas longas, por terminal (projeto + motor).
 *
 * O agente publica o estado inteiro pela ferramenta `update_progress` do Hermes;
 * aqui ele é conferido e gravado num arquivo JSON por terminal, que a coluna da
 * interface mostra e o operador pode abrir. Ver
 * docs/superpowers/specs/2026-11-18-acompanhamento-de-tarefas-design.md.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from './user-error.js'

export type ProgressStatus = 'pending' | 'in_progress' | 'review' | 'blocked' | 'done'
export const PROGRESS_STATUSES: readonly ProgressStatus[] = ['pending', 'in_progress', 'review', 'blocked', 'done']

export interface ProgressInput {
  title: string
  now: { title: string; detail?: string }
  tasks: { name: string; status: ProgressStatus; note?: string }[]
  waiting: string[]
}
export interface Progress extends ProgressInput { updatedAt: string }

const LIMITS = { title: 200, nowTitle: 200, detail: 1000, tasks: 40, name: 200, note: 500, waiting: 10, waitingItem: 500 }

type Result = { ok: true; value: ProgressInput } | { ok: false; error: string }

/** Texto obrigatório (não vazio) ou opcional, aparado e com teto. Erro em inglês: vai ao agente. */
function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new Error(`${field} must not be empty`)
  if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`)
  return trimmed || undefined
}

export function validateProgress(input: unknown): Result {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('progress must be an object')
    const o = input as Record<string, unknown>
    const title = text(o.title, 'title', LIMITS.title, true)!
    if (!o.now || typeof o.now !== 'object') throw new Error('now must be an object with a title')
    const nowIn = o.now as Record<string, unknown>
    const now = { title: text(nowIn.title, 'now.title', LIMITS.nowTitle, true)! }
    const detail = text(nowIn.detail, 'now.detail', LIMITS.detail, false)
    if (!Array.isArray(o.tasks)) throw new Error('tasks must be a list')
    if (o.tasks.length > LIMITS.tasks) throw new Error(`tasks must have at most ${LIMITS.tasks} items`)
    const tasks = o.tasks.map((t, i) => {
      if (!t || typeof t !== 'object') throw new Error(`tasks[${i}] must be an object`)
      const task = t as Record<string, unknown>
      const name = text(task.name, `tasks[${i}].name`, LIMITS.name, true)!
      if (!PROGRESS_STATUSES.includes(task.status as ProgressStatus)) {
        throw new Error(`tasks[${i}].status must be one of ${PROGRESS_STATUSES.join(', ')}`)
      }
      const note = text(task.note, `tasks[${i}].note`, LIMITS.note, false)
      return { name, status: task.status as ProgressStatus, ...(note ? { note } : {}) }
    })
    const waitingIn = o.waiting ?? []
    if (!Array.isArray(waitingIn)) throw new Error('waiting must be a list')
    if (waitingIn.length > LIMITS.waiting) throw new Error(`waiting must have at most ${LIMITS.waiting} items`)
    const waiting = waitingIn
      .map((w, i) => text(w, `waiting[${i}]`, LIMITS.waitingItem, false))
      .filter((w): w is string => !!w)
    return { ok: true, value: { title, now: detail ? { ...now, detail } : now, tasks, waiting } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** O motor vira nome de arquivo: só letras minúsculas, dígitos e hífen. */
const ENGINE_RE = /^[a-z0-9-]{1,32}$/

export function createProgressStore(opts: { dir: string; now?: () => Date }) {
  const now = opts.now ?? (() => new Date())
  const pathOf = (projectId: number, engine: string): string => {
    if (!Number.isInteger(projectId) || projectId <= 0) throw new UserError('invalid_project', 'projeto inválido')
    if (!ENGINE_RE.test(engine)) throw new UserError('invalid_engine', `motor inválido: ${engine}`)
    return join(opts.dir, `${projectId}-${engine}.json`)
  }
  return {
    pathOf,
    get(projectId: number, engine: string): Progress | null {
      const file = pathOf(projectId, engine)
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as Progress
        const checked = validateProgress(data)
        return checked.ok && typeof data.updatedAt === 'string' ? { ...checked.value, updatedAt: data.updatedAt } : null
      } catch {
        // Sem arquivo, ou corrompido: sem acompanhamento.
        return null
      }
    },
    set(projectId: number, engine: string, input: ProgressInput): Progress {
      const file = pathOf(projectId, engine)
      const progress: Progress = { ...input, updatedAt: now().toISOString() }
      mkdirSync(opts.dir, { recursive: true })
      // Atômico: quem lê nunca pega o arquivo pela metade.
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(progress, null, 2))
      renameSync(tmp, file)
      return progress
    },
    clear(projectId: number, engine: string): void {
      rmSync(pathOf(projectId, engine), { force: true })
    },
  }
}

export type ProgressStore = ReturnType<typeof createProgressStore>
