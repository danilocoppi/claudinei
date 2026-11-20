import type { Db } from '../db.js'
import type { Question } from '../claude/session.js'

/**
 * Estado de reinício por terminal (projeto + motor): os dois interruptores
 * ("Iniciar com o Claudinei" e "Retomar trabalho interrompido") e a marca de
 * turno interrompido pelo reinício do serviço.
 *
 * Terminal sem linha é o padrão: tudo desligado e nada interrompido. As linhas
 * só nascem quando algo é gravado.
 */

/**
 * Por que uma interrupção não foi retomada sozinha:
 * - `off`: "retomar" desligado no terminal;
 * - `question`: havia pergunta aberta, e o agente seguiria sem a decisão;
 * - `limit`: já foi retomada 3 vezes seguidas sem concluir;
 * - `failed`: a retomada automática falhou.
 */
export type HoldReason = 'off' | 'question' | 'limit' | 'failed'

export interface TerminalStateRow {
  projectId: number; engine: string
  autostart: boolean; autoResume: boolean
  interruptedAt: string | null; interruptedLocalId: string | null
  lostQuestion: Question[] | null; resumeCount: number
  holdReason: HoldReason | null   // null + interruptedAt = na fila para retomar
}

export interface TerminalStateDto {
  projectId: number; engine: string; autostart: boolean; autoResume: boolean
  interruption: null | { at: string; reason: HoldReason | 'queued'; question?: Question[] }
}

/** Erro com que fecham a tarefa encaminhada e a execução de agendamento que o reinício matou. */
export const RESTART_FAIL_TEXT = 'interrompida pelo reinício do Claudinei'

interface RawRow {
  project_id: number; engine: string
  autostart: number; auto_resume: number
  interrupted_at: string | null; interrupted_local_id: string | null; lost_question: string | null
  resume_count: number; hold_reason: string | null
}

/** JSON das perguntas gravado no banco. Ilegível vira `null`: perder o texto da pergunta não pode derrubar a subida. */
function parseQuestions(raw: string | null): Question[] | null {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as Question[]) : null
  } catch {
    return null
  }
}

function fromRaw(r: RawRow): TerminalStateRow {
  return {
    projectId: r.project_id,
    engine: r.engine,
    autostart: r.autostart === 1,
    autoResume: r.auto_resume === 1,
    interruptedAt: r.interrupted_at,
    interruptedLocalId: r.interrupted_local_id,
    lostQuestion: parseQuestions(r.lost_question),
    resumeCount: r.resume_count,
    holdReason: r.hold_reason as HoldReason | null,
  }
}

function defaultRow(projectId: number, engine: string): TerminalStateRow {
  return {
    projectId, engine,
    autostart: false, autoResume: false,
    interruptedAt: null, interruptedLocalId: null,
    lostQuestion: null, resumeCount: 0, holdReason: null,
  }
}

/** Grava a interrupção sem tocar nos interruptores nem no contador; zera o motivo de espera. */
function markInterruptedSql(db: Db, projectId: number, engine: string, localId: string, question: Question[] | null): void {
  db.prepare(
    `INSERT INTO terminal_state (project_id, engine, interrupted_at, interrupted_local_id, lost_question, hold_reason)
     VALUES (?, ?, datetime('now'), ?, ?, NULL)
     ON CONFLICT(project_id, engine) DO UPDATE SET
       interrupted_at = datetime('now'),
       interrupted_local_id = excluded.interrupted_local_id,
       lost_question = excluded.lost_question,
       hold_reason = NULL`,
  ).run(projectId, engine, localId, question ? JSON.stringify(question) : null)
}

export function createTerminalStateStore(db: Db) {
  const selectOne = db.prepare(`SELECT * FROM terminal_state WHERE project_id = ? AND engine = ?`)
  const selectAll = db.prepare(`SELECT * FROM terminal_state ORDER BY project_id, engine`)
  const clearSql = db.prepare(
    `UPDATE terminal_state
        SET interrupted_at = NULL, interrupted_local_id = NULL, lost_question = NULL, hold_reason = NULL
      WHERE project_id = ? AND engine = ?`,
  )

  function get(projectId: number, engine: string): TerminalStateRow {
    const r = selectOne.get(projectId, engine) as RawRow | undefined
    return r ? fromRaw(r) : defaultRow(projectId, engine)
  }

  return {
    get,

    list(): TerminalStateRow[] {
      return (selectAll.all() as RawRow[]).map(fromRaw)
    },

    /** Grava só os interruptores que vieram; o que ficou de fora mantém o valor. */
    setPrefs(projectId: number, engine: string, p: { autostart?: boolean; autoResume?: boolean }): TerminalStateRow {
      const autostart = p.autostart === undefined ? null : p.autostart ? 1 : 0
      const autoResume = p.autoResume === undefined ? null : p.autoResume ? 1 : 0
      db.prepare(
        `INSERT INTO terminal_state (project_id, engine, autostart, auto_resume)
         VALUES (?, ?, COALESCE(?, 0), COALESCE(?, 0))
         ON CONFLICT(project_id, engine) DO UPDATE SET
           autostart = COALESCE(?, autostart),
           auto_resume = COALESCE(?, auto_resume)`,
      ).run(projectId, engine, autostart, autoResume, autostart, autoResume)
      return get(projectId, engine)
    },

    markInterrupted(projectId: number, engine: string, localId: string, question: Question[] | null): void {
      markInterruptedSql(db, projectId, engine, localId, question)
    },

    setHold(projectId: number, engine: string, reason: HoldReason): void {
      db.prepare(
        `INSERT INTO terminal_state (project_id, engine, hold_reason) VALUES (?, ?, ?)
         ON CONFLICT(project_id, engine) DO UPDATE SET hold_reason = excluded.hold_reason`,
      ).run(projectId, engine, reason)
    },

    /**
     * Limpa a marca e devolve o que havia; `null` se não havia. Na transação,
     * dois pedidos simultâneos (Continuar e a subida, por exemplo) não levam a
     * mesma interrupção duas vezes.
     */
    takeInterruption: db.transaction((projectId: number, engine: string): TerminalStateRow | null => {
      const row = get(projectId, engine)
      if (row.interruptedAt == null) return null
      clearSql.run(projectId, engine)
      return row
    }),

    clearInterruption(projectId: number, engine: string): void {
      clearSql.run(projectId, engine)
    },

    bumpResume(projectId: number, engine: string): void {
      db.prepare(
        `INSERT INTO terminal_state (project_id, engine, resume_count) VALUES (?, ?, 1)
         ON CONFLICT(project_id, engine) DO UPDATE SET resume_count = resume_count + 1`,
      ).run(projectId, engine)
    },

    resetResume(projectId: number, engine: string): void {
      db.prepare(`UPDATE terminal_state SET resume_count = 0 WHERE project_id = ? AND engine = ?`).run(projectId, engine)
    },
  }
}

export type TerminalStateStore = ReturnType<typeof createTerminalStateStore>

export function toDto(row: TerminalStateRow): TerminalStateDto {
  let interruption: TerminalStateDto['interruption'] = null
  if (row.interruptedAt != null) {
    interruption = { at: row.interruptedAt, reason: row.holdReason ?? 'queued' }
    if (row.lostQuestion) interruption.question = row.lostQuestion
  }
  return { projectId: row.projectId, engine: row.engine, autostart: row.autostart, autoResume: row.autoResume, interruption }
}

/**
 * Queda brusca (SIGKILL, crash, OOM): não houve encerramento para registrar
 * nada, então quem ficou persistido como `working` estava no meio de um turno.
 * Roda na subida, ANTES do gerenciador de sessões, que reescreve esses status.
 * A pergunta aberta vem de `sessions.pending_question`. Devolve quantas marcou.
 */
export function captureCrashed(db: Db): number {
  const rows = db.prepare(
    `SELECT local_id, project_id, engine, pending_question FROM sessions
      WHERE status = 'working' ORDER BY updated_at, rowid`,
  ).all() as { local_id: string; project_id: number; engine: string; pending_question: string | null }[]
  db.transaction(() => {
    for (const r of rows) markInterruptedSql(db, r.project_id, r.engine, r.local_id, parseQuestions(r.pending_question))
  })()
  return rows.length
}
