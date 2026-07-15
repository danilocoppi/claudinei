import { existsSync, statSync } from 'node:fs'
import type { Db } from './db.js'

export interface Project {
  id: number
  name: string
  path: string
  color: string
  icon: string
  /** Grupo visual na sidebar (null = solto na raiz). */
  groupId: number | null
  /** Posição no espaço unificado da sidebar (compartilhado com project_groups.sort_order). */
  sortOrder: number
}

export type ProjectsService = ReturnType<typeof createProjectsService>

export function createProjectsService(db: Db) {
  const rowToProject = (r: any): Project => ({
    id: r.id, name: r.name, path: r.path, color: r.color, icon: r.icon, groupId: r.group_id ?? null, sortOrder: r.sort_order ?? 0,
  })

  return {
    list(): Project[] {
      return db.prepare(`SELECT * FROM projects ORDER BY sort_order ASC, id ASC`).all().map(rowToProject)
    },
    get(id: number): Project | undefined {
      const r = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id)
      return r ? rowToProject(r) : undefined
    },
    create(input: { name: string; path: string; color?: string; icon?: string }): Project {
      if (!existsSync(input.path) || !statSync(input.path).isDirectory()) {
        throw new Error(`diretório não existe: ${input.path}`)
      }
      const nextOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM projects`).get() as any).n
      const info = db
        .prepare(`INSERT INTO projects (name, path, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)`)
        .run(input.name, input.path, input.color ?? '#7c5cff', input.icon ?? '📁', nextOrder)
      return this.get(Number(info.lastInsertRowid))!
    },
    update(id: number, patch: Partial<Omit<Project, 'id'>>): Project {
      const cur = this.get(id)
      if (!cur) throw new Error(`projeto ${id} não existe`)
      const next = { ...cur, ...patch }
      db.prepare(`UPDATE projects SET name=?, path=?, color=?, icon=? WHERE id=?`)
        .run(next.name, next.path, next.color, next.icon, id)
      return next
    },
    /** Persiste a ordem dada (índice = posição). Ids desconhecidos são no-op; o front envia a lista completa. */
    reorder(ids: number[]): Project[] {
      const upd = db.prepare(`UPDATE projects SET sort_order = ? WHERE id = ?`)
      const tx = db.transaction((list: number[]) => {
        list.forEach((id, i) => upd.run(i + 1, id))
      })
      tx(ids)
      return this.list()
    },
    remove(id: number): void {
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    },
  }
}
