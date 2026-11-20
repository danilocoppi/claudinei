import type { Db } from '../db.js'
import type { Question } from '../claude/session.js'
import { GOAL_MAX_TURNS } from '../goal/texts.js'

/**
 * Estado de reinício por terminal (projeto + motor): os interruptores
 * ("Iniciar com o Claudinei", "Retomar trabalho interrompido" e "Continuar
 * sozinho quando o limite reabrir"), a marca de turno interrompido pelo
 * reinício do serviço e o limite de uso que o terminal bateu.
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

/**
 * O que fazer quando o limite de uso reabrir:
 * - `none`: nada, só o aviso;
 * - `armed`: retomar sozinho (com a folga depois do `resetsAt`);
 * - `snoozed`: esconder o aviso até a reabertura, sem mandar nada.
 */
export type LimitAction = 'none' | 'armed' | 'snoozed'

/** Quem disparou o turno que bateu o limite. */
export type LimitOrigin = 'operator' | 'schedule' | 'task' | 'claudinei'

/**
 * Estado do goal (`/goal`) do terminal:
 * - `active`: o laço segue (o "continue" sai no fim de cada turno);
 * - `waiting`: esperando tarefas que o próprio terminal delegou;
 * - `paused`: parado por um motivo (`GoalPause`), sem mensagem;
 * - `cap`: chegou ao teto de turnos sem `goal_done`;
 * - `done`: o agente declarou cumprido (`goal_done`), com a evidência.
 */
export type GoalStatus = 'active' | 'waiting' | 'paused' | 'cap' | 'done'

/** Por que o goal pausou: mensagem do operador, turno com erro, limite de uso ou Esc. */
export type GoalPause = 'operator' | 'error' | 'limit' | 'interrupt'

const GOAL_STATUSES: readonly string[] = ['active', 'waiting', 'paused', 'cap', 'done'] satisfies GoalStatus[]
const GOAL_PAUSES: readonly string[] = ['operator', 'error', 'limit', 'interrupt'] satisfies GoalPause[]

const LIMIT_ACTIONS: readonly string[] = ['none', 'armed', 'snoozed'] satisfies LimitAction[]
const LIMIT_ORIGINS: readonly string[] = ['operator', 'schedule', 'task', 'claudinei'] satisfies LimitOrigin[]

export interface TerminalStateRow {
  projectId: number; engine: string
  autostart: boolean; autoResume: boolean
  interruptedAt: string | null; interruptedLocalId: string | null
  lostQuestion: Question[] | null; resumeCount: number
  holdReason: HoldReason | null   // null + interruptedAt = na fila para retomar
  autoResumeLimit: boolean
  limitHitAt: string | null       // null = sem limite ativo
  limitResetsAt: number | null    // epoch SEGUNDOS; null = reabertura desconhecida
  limitAction: LimitAction; limitOrigin: LimitOrigin | null
  limitTries: number              // retomadas automáticas na janela; zera num turno sem erro
  goalCriterion: string | null    // null = sem goal
  goalStatus: GoalStatus | null
  goalPause: GoalPause | null     // só com goalStatus = 'paused'
  goalTurns: number               // turnos do goal contados até aqui
  goalEvidence: string | null     // a evidência do goal_done
  goalStartedAt: string | null
}

export interface TerminalStateDto {
  projectId: number; engine: string; autostart: boolean; autoResume: boolean
  interruption: null | { at: string; reason: HoldReason | 'queued'; question?: Question[] }
  autoResumeLimit: boolean
  usageLimit: null | { hitAt: string; resetsAt: number | null; action: LimitAction; origin: LimitOrigin }
  /**
   * Resultados de tarefas delegadas por este terminal esperando a entrega (só os
   * pendentes). Vem do serviço do aviso de tarefa, pelo `decorate` do reinício;
   * o `toDto` sozinho dá a lista vazia.
   */
  taskResults: { id: number; toProjectName: string; status: 'completed' | 'failed' }[]
  /**
   * Os resultados pendentes estão segurados pela marca do limite de uso (o lugar
   * 4 do árbitro): o limite está ativo, ou já saiu e o terminal ainda não voltou
   * a trabalhar. A tela usa para mostrar o aviso com a sessão viva parada. Vem do
   * `decorate` do aviso de tarefa; o `toDto` sozinho dá false.
   */
  taskResultsHeld: boolean
  /** O goal do terminal (`/goal`), do próprio estado gravado; null = sem goal. */
  goal: null | { criterion: string; status: GoalStatus; pause: GoalPause | null; turns: number; max: typeof GOAL_MAX_TURNS; evidence: string | null }
}

/** Erro com que fecham a tarefa encaminhada e a execução de agendamento que o reinício matou. */
export const RESTART_FAIL_TEXT = 'interrompida pelo reinício do Claudinei'

interface RawRow {
  project_id: number; engine: string
  autostart: number; auto_resume: number
  interrupted_at: string | null; interrupted_local_id: string | null; lost_question: string | null
  resume_count: number; hold_reason: string | null
  auto_resume_limit: number
  limit_hit_at: string | null; limit_resets_at: number | null
  limit_action: string; limit_origin: string | null; limit_tries: number
  goal_criterion: string | null; goal_status: string | null; goal_pause_reason: string | null
  goal_turns: number; goal_evidence: string | null; goal_started_at: string | null
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
    autoResumeLimit: r.auto_resume_limit === 1,
    limitHitAt: r.limit_hit_at,
    limitResetsAt: r.limit_resets_at,
    // Valor desconhecido no banco não arma nem adia nada: vira 'none'.
    limitAction: LIMIT_ACTIONS.includes(r.limit_action) ? (r.limit_action as LimitAction) : 'none',
    limitOrigin: r.limit_origin != null && LIMIT_ORIGINS.includes(r.limit_origin) ? (r.limit_origin as LimitOrigin) : null,
    limitTries: r.limit_tries,
    goalCriterion: r.goal_criterion,
    // Estado desconhecido no banco não gira o laço: vira sem goal.
    goalStatus: r.goal_status != null && GOAL_STATUSES.includes(r.goal_status) ? (r.goal_status as GoalStatus) : null,
    goalPause: r.goal_pause_reason != null && GOAL_PAUSES.includes(r.goal_pause_reason) ? (r.goal_pause_reason as GoalPause) : null,
    goalTurns: r.goal_turns,
    goalEvidence: r.goal_evidence,
    goalStartedAt: r.goal_started_at,
  }
}

function defaultRow(projectId: number, engine: string): TerminalStateRow {
  return {
    projectId, engine,
    autostart: false, autoResume: false,
    interruptedAt: null, interruptedLocalId: null,
    lostQuestion: null, resumeCount: 0, holdReason: null,
    autoResumeLimit: false,
    limitHitAt: null, limitResetsAt: null, limitAction: 'none', limitOrigin: null, limitTries: 0,
    goalCriterion: null, goalStatus: null, goalPause: null, goalTurns: 0, goalEvidence: null, goalStartedAt: null,
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
  // Não mexe em `limit_tries`: a tentativa automática conta por janela, e só um
  // turno sem erro a zera (resetLimitTries).
  const clearLimitSql = db.prepare(
    `UPDATE terminal_state
        SET limit_hit_at = NULL, limit_resets_at = NULL, limit_action = 'none', limit_origin = NULL
      WHERE project_id = ? AND engine = ?`,
  )
  const selectByAction = db.prepare(
    `SELECT * FROM terminal_state
      WHERE limit_action = ? AND limit_hit_at IS NOT NULL ORDER BY project_id, engine`,
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
    setPrefs(
      projectId: number, engine: string,
      p: { autostart?: boolean; autoResume?: boolean; autoResumeLimit?: boolean },
    ): TerminalStateRow {
      const bit = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0)
      const autostart = bit(p.autostart)
      const autoResume = bit(p.autoResume)
      const autoResumeLimit = bit(p.autoResumeLimit)
      db.prepare(
        `INSERT INTO terminal_state (project_id, engine, autostart, auto_resume, auto_resume_limit)
         VALUES (?, ?, COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0))
         ON CONFLICT(project_id, engine) DO UPDATE SET
           autostart = COALESCE(?, autostart),
           auto_resume = COALESCE(?, auto_resume),
           auto_resume_limit = COALESCE(?, auto_resume_limit)`,
      ).run(projectId, engine, autostart, autoResume, autoResumeLimit, autostart, autoResume, autoResumeLimit)
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

    /**
     * Grava o limite de uso que o terminal bateu agora. A ação volta a `none`
     * (o operador decide de novo) e não toca na marca do reinício, nos
     * interruptores nem em `limit_tries`.
     */
    recordUsageLimit(projectId: number, engine: string, p: { resetsAt: number | null; origin: LimitOrigin }): TerminalStateRow {
      db.prepare(
        `INSERT INTO terminal_state (project_id, engine, limit_hit_at, limit_resets_at, limit_action, limit_origin)
         VALUES (?, ?, datetime('now'), ?, 'none', ?)
         ON CONFLICT(project_id, engine) DO UPDATE SET
           limit_hit_at = datetime('now'),
           limit_resets_at = excluded.limit_resets_at,
           limit_action = 'none',
           limit_origin = excluded.limit_origin`,
      ).run(projectId, engine, p.resetsAt, p.origin)
      return get(projectId, engine)
    },

    /** Só muda a ação de uma linha que já existe: sem limite gravado não há o que armar. */
    setLimitAction(projectId: number, engine: string, action: LimitAction): void {
      db.prepare(`UPDATE terminal_state SET limit_action = ? WHERE project_id = ? AND engine = ?`).run(action, projectId, engine)
    },

    /**
     * Limpa o limite e devolve o que havia; `null` se não havia. Na transação,
     * o relógio e o clique em "Continuar agora" não retomam a mesma janela duas vezes.
     */
    takeLimit: db.transaction((projectId: number, engine: string): TerminalStateRow | null => {
      const row = get(projectId, engine)
      if (row.limitHitAt == null) return null
      clearLimitSql.run(projectId, engine)
      return row
    }),

    clearLimit(projectId: number, engine: string): void {
      clearLimitSql.run(projectId, engine)
    },

    bumpLimitTries(projectId: number, engine: string): void {
      db.prepare(
        `INSERT INTO terminal_state (project_id, engine, limit_tries) VALUES (?, ?, 1)
         ON CONFLICT(project_id, engine) DO UPDATE SET limit_tries = limit_tries + 1`,
      ).run(projectId, engine)
    },

    resetLimitTries(projectId: number, engine: string): void {
      db.prepare(`UPDATE terminal_state SET limit_tries = 0 WHERE project_id = ? AND engine = ?`).run(projectId, engine)
    },

    /** Terminais com limite ativo e retomada armada. */
    listArmed(): TerminalStateRow[] {
      return (selectByAction.all('armed') as RawRow[]).map(fromRaw)
    },

    /** Terminais com limite ativo e aviso adiado até a reabertura. */
    listSnoozed(): TerminalStateRow[] {
      return (selectByAction.all('snoozed') as RawRow[]).map(fromRaw)
    },

    /**
     * Inicia (ou substitui) o goal do terminal: ativo, sem turnos e sem
     * evidência. Não toca nos interruptores, na marca do reinício nem no limite.
     */
    startGoal(projectId: number, engine: string, criterion: string): void {
      db.prepare(
        `INSERT INTO terminal_state (project_id, engine, goal_criterion, goal_status, goal_pause_reason, goal_turns, goal_evidence, goal_started_at)
         VALUES (?, ?, ?, 'active', NULL, 0, NULL, datetime('now'))
         ON CONFLICT(project_id, engine) DO UPDATE SET
           goal_criterion = excluded.goal_criterion,
           goal_status = 'active', goal_pause_reason = NULL, goal_turns = 0,
           goal_evidence = NULL, goal_started_at = excluded.goal_started_at`,
      ).run(projectId, engine, criterion)
    },

    /** Troca o estado do goal; o motivo da pausa só fica com `paused`. */
    setGoalStatus(projectId: number, engine: string, status: GoalStatus, pause?: GoalPause | null): void {
      db.prepare(`UPDATE terminal_state SET goal_status = ?, goal_pause_reason = ? WHERE project_id = ? AND engine = ? AND goal_criterion IS NOT NULL`)
        .run(status, status === 'paused' ? (pause ?? null) : null, projectId, engine)
    },

    /** O `/goal resume`: ativo de novo, com os turnos zerados. */
    resumeGoal(projectId: number, engine: string): void {
      db.prepare(
        `UPDATE terminal_state SET goal_status = 'active', goal_pause_reason = NULL, goal_turns = 0
          WHERE project_id = ? AND engine = ? AND goal_criterion IS NOT NULL`,
      ).run(projectId, engine)
    },

    /** Conta um turno do goal e devolve o total. */
    bumpGoalTurn(projectId: number, engine: string): number {
      db.prepare(`UPDATE terminal_state SET goal_turns = goal_turns + 1 WHERE project_id = ? AND engine = ? AND goal_criterion IS NOT NULL`)
        .run(projectId, engine)
      return get(projectId, engine).goalTurns
    },

    /** O goal_done: cumprido, com a evidência. */
    finishGoal(projectId: number, engine: string, evidence: string): void {
      db.prepare(
        `UPDATE terminal_state SET goal_status = 'done', goal_pause_reason = NULL, goal_evidence = ?
          WHERE project_id = ? AND engine = ? AND goal_criterion IS NOT NULL`,
      ).run(evidence, projectId, engine)
    },

    /**
     * Devolve o goal a um retrato tirado antes (a partida de um goal novo que não
     * saiu). Retrato sem goal limpa.
     */
    restoreGoal(projectId: number, engine: string, snap: Pick<TerminalStateRow,
      'goalCriterion' | 'goalStatus' | 'goalPause' | 'goalTurns' | 'goalEvidence' | 'goalStartedAt'>): void {
      db.prepare(
        `UPDATE terminal_state
            SET goal_criterion = ?, goal_status = ?, goal_pause_reason = ?, goal_turns = ?,
                goal_evidence = ?, goal_started_at = ?
          WHERE project_id = ? AND engine = ?`,
      ).run(
        snap.goalCriterion, snap.goalCriterion == null ? null : snap.goalStatus,
        snap.goalCriterion == null ? null : snap.goalPause, snap.goalCriterion == null ? 0 : snap.goalTurns,
        snap.goalCriterion == null ? null : snap.goalEvidence, snap.goalCriterion == null ? null : snap.goalStartedAt,
        projectId, engine,
      )
    },

    /** O `/goal stop`: o terminal fica sem goal. */
    clearGoal(projectId: number, engine: string): void {
      db.prepare(
        `UPDATE terminal_state
            SET goal_criterion = NULL, goal_status = NULL, goal_pause_reason = NULL, goal_turns = 0,
                goal_evidence = NULL, goal_started_at = NULL
          WHERE project_id = ? AND engine = ?`,
      ).run(projectId, engine)
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
  let usageLimit: TerminalStateDto['usageLimit'] = null
  if (row.limitHitAt != null) {
    usageLimit = {
      hitAt: row.limitHitAt,
      resetsAt: row.limitResetsAt,
      action: row.limitAction,
      // recordUsageLimit sempre grava a origem; ausente no banco, vale a do operador.
      origin: row.limitOrigin ?? 'operator',
    }
  }
  const goal: TerminalStateDto['goal'] = row.goalCriterion != null && row.goalStatus != null
    ? {
        criterion: row.goalCriterion, status: row.goalStatus,
        pause: row.goalStatus === 'paused' ? row.goalPause : null,
        turns: row.goalTurns, max: GOAL_MAX_TURNS, evidence: row.goalEvidence,
      }
    : null
  return {
    projectId: row.projectId, engine: row.engine, autostart: row.autostart, autoResume: row.autoResume,
    interruption, autoResumeLimit: row.autoResumeLimit, usageLimit, taskResults: [], taskResultsHeld: false, goal,
  }
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
