import type { Db } from './db.js'

export type TaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

/**
 * Estado do aviso de resultado ao terminal que delegou: `pending` (esperando a
 * entrega), `delivered` (entregue numa mensagem do Claudinei), `dismissed` (o
 * operador fechou o aviso; o resultado segue em list_tasks), `none` (não há quem
 * acordar). A coluna fica NULL nas tarefas antigas e nas que ainda não terminaram.
 */
export type TaskNotify = 'pending' | 'delivered' | 'dismissed' | 'none'

export interface Task {
  id: number
  fromProjectId: number | null
  fromProjectName: string | null
  toProjectId: number
  toProjectName: string
  /** Engine que despachou (null: operador/desconhecida) e engine que executou (null: ainda não entregue). */
  fromEngine: string | null
  toEngine: string | null
  description: string
  status: TaskStatus
  result: string | null
  notify: TaskNotify | null
  createdAt: string
  updatedAt: string
}

/** Colunas da Task com os nomes dos projetos; cada consulta acrescenta o WHERE/ORDER. */
const SELECT_TASK = `SELECT t.id as id,
       t.from_project_id as fromProjectId, fp.name as fromProjectName,
       t.to_project_id as toProjectId, tp.name as toProjectName,
       t.from_engine as fromEngine, t.to_engine as toEngine,
       t.description as description, t.status as status, t.result as result,
       t.notify as notify,
       t.created_at as createdAt, t.updated_at as updatedAt
  FROM tasks t
  LEFT JOIN projects fp ON fp.id = t.from_project_id
  JOIN projects tp ON tp.id = t.to_project_id`

export function createTasksService(db: Db) {
  return {
    create(fromProjectId: number | null, toProjectId: number, description: string, status: TaskStatus = 'queued', fromEngine: string | null = null): { id: number } {
      const info = db
        .prepare(`INSERT INTO tasks (from_project_id, to_project_id, description, status, from_engine) VALUES (?, ?, ?, ?, ?)`)
        .run(fromProjectId, toProjectId, description, status, fromEngine)
      return { id: Number(info.lastInsertRowid) }
    },

    /** Registra a engine que de fato recebeu a task (conhecida só na entrega do drain). */
    setToEngine(id: number, engine: string): void {
      db.prepare(`UPDATE tasks SET to_engine=?, updated_at=datetime('now') WHERE id=?`).run(engine, id)
    },

    /** Promove a queued mais antiga do projeto alvo para in_progress (entrega da fila). */
    markInProgress(id: number): void {
      db.prepare(
        `UPDATE tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?`,
      ).run(id)
    },

    /** A tarefa `queued` mais antiga (FIFO) para o projeto alvo, ou undefined se a fila está vazia. */
    nextQueued(toProjectId: number): Task | undefined {
      return db
        .prepare(
          `${SELECT_TASK}
           WHERE t.to_project_id = ? AND t.status = 'queued'
           ORDER BY t.id ASC
           LIMIT 1`,
        )
        .get(toProjectId) as Task | undefined
    },

    setResult(id: number, status: 'completed' | 'failed', result: string): void {
      db.prepare(
        `UPDATE tasks SET status=?, result=?, updated_at=datetime('now') WHERE id=?`,
      ).run(status, result, id)
    },

    /** Grava o estado do aviso de resultado de várias tarefas de uma vez. */
    setNotify(ids: number[], notify: TaskNotify): void {
      if (ids.length === 0) return
      const stmt = db.prepare(`UPDATE tasks SET notify=? WHERE id=?`)
      db.transaction(() => { for (const id of ids) stmt.run(notify, id) })()
    },

    /**
     * Avisos pendentes do terminal de origem (projeto + motor), da mais antiga
     * para a mais nova. `fromEngine` nulo casa só as tarefas sem motor de origem.
     */
    pendingNotifyFor(fromProjectId: number, fromEngine: string | null): Task[] {
      return db
        .prepare(
          `${SELECT_TASK}
           WHERE t.from_project_id = ? AND t.from_engine IS ? AND t.notify = 'pending'
           ORDER BY t.id ASC`,
        )
        .all(fromProjectId, fromEngine) as Task[]
    },

    /** Todos os avisos pendentes, da mais antiga para a mais nova (subida do serviço). */
    allPendingNotify(): Task[] {
      return db
        .prepare(
          `${SELECT_TASK}
           WHERE t.notify = 'pending'
           ORDER BY t.id ASC`,
        )
        .all() as Task[]
    },

    /** Quantas tarefas desta origem (projeto + motor) seguem na fila ou em andamento. */
    openFrom(fromProjectId: number, fromEngine: string): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) as n FROM tasks
           WHERE from_project_id = ? AND from_engine = ? AND status IN ('queued', 'in_progress')`,
        )
        .get(fromProjectId, fromEngine) as { n: number }
      return row.n
    },

    list(limit = 100): Task[] {
      const rows = db
        .prepare(
          `${SELECT_TASK}
           ORDER BY t.id DESC
           LIMIT ?`,
        )
        .all(limit) as Task[]
      return rows
    },

    get(id: number): Task | undefined {
      return db
        .prepare(
          `${SELECT_TASK}
           WHERE t.id = ?`,
        )
        .get(id) as Task | undefined
    },

    /**
     * Tarefas em andamento entregues a este terminal (projeto + motor), da mais
     * antiga para a mais nova. Na subida, são as que o reinício deixou presas ao
     * turno interrompido: religadas se o terminal retoma, fechadas se não.
     */
    inProgressFor(toProjectId: number, toEngine: string): Task[] {
      return db
        .prepare(
          `${SELECT_TASK}
           WHERE t.to_project_id = ? AND t.to_engine = ? AND t.status = 'in_progress'
           ORDER BY t.id ASC`,
        )
        .all(toProjectId, toEngine) as Task[]
    },

    /** Todas as tarefas em andamento, da mais antiga para a mais nova (varredura da subida). */
    listInProgress(): Task[] {
      return db
        .prepare(
          `${SELECT_TASK}
           WHERE t.status = 'in_progress'
           ORDER BY t.id ASC`,
        )
        .all() as Task[]
    },
  }
}

export type TasksService = ReturnType<typeof createTasksService>
