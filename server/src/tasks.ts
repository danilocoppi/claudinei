import type { Db } from './db.js'

export type TaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

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
  createdAt: string
  updatedAt: string
}

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
          `SELECT t.id as id,
                  t.from_project_id as fromProjectId, fp.name as fromProjectName,
                  t.to_project_id as toProjectId, tp.name as toProjectName,
                  t.from_engine as fromEngine, t.to_engine as toEngine,
                  t.description as description, t.status as status, t.result as result,
                  t.created_at as createdAt, t.updated_at as updatedAt
           FROM tasks t
           LEFT JOIN projects fp ON fp.id = t.from_project_id
           JOIN projects tp ON tp.id = t.to_project_id
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

    list(limit = 100): Task[] {
      const rows = db
        .prepare(
          `SELECT t.id as id,
                  t.from_project_id as fromProjectId, fp.name as fromProjectName,
                  t.to_project_id as toProjectId, tp.name as toProjectName,
                  t.from_engine as fromEngine, t.to_engine as toEngine,
                  t.description as description, t.status as status, t.result as result,
                  t.created_at as createdAt, t.updated_at as updatedAt
           FROM tasks t
           LEFT JOIN projects fp ON fp.id = t.from_project_id
           JOIN projects tp ON tp.id = t.to_project_id
           ORDER BY t.id DESC
           LIMIT ?`,
        )
        .all(limit) as Task[]
      return rows
    },

    get(id: number): Task | undefined {
      return db
        .prepare(
          `SELECT t.id as id,
                  t.from_project_id as fromProjectId, fp.name as fromProjectName,
                  t.to_project_id as toProjectId, tp.name as toProjectName,
                  t.from_engine as fromEngine, t.to_engine as toEngine,
                  t.description as description, t.status as status, t.result as result,
                  t.created_at as createdAt, t.updated_at as updatedAt
           FROM tasks t
           LEFT JOIN projects fp ON fp.id = t.from_project_id
           JOIN projects tp ON tp.id = t.to_project_id
           WHERE t.id = ?`,
        )
        .get(id) as Task | undefined
    },
  }
}

export type TasksService = ReturnType<typeof createTasksService>
