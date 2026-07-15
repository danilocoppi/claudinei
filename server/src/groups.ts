import type { Db } from './db.js'

export interface ProjectGroup {
  id: number
  name: string
  /** Ícone e cor do grupo — mesmo padrão visual dos terminais. */
  icon: string
  color: string
  /** Posição no espaço unificado da sidebar (compartilhado com projects.sort_order). */
  sortOrder: number
}

/** Uma entrada da sidebar na ordem visual: um grupo (com os filhos na ordem) ou um terminal solto. */
export type SidebarEntry =
  | { kind: 'group'; id: number; children: number[] }
  | { kind: 'project'; id: number }

/** Grupos visuais de terminais na sidebar. Excluir um grupo NÃO exclui terminais — solta-os na raiz. */
export function createGroupsService(db: Db) {
  return {
    list(): ProjectGroup[] {
      return (db.prepare(`SELECT id, name, icon, color, sort_order FROM project_groups ORDER BY sort_order ASC, id ASC`).all() as any[])
        .map((r) => ({ id: r.id, name: r.name, icon: r.icon ?? '🗂️', color: r.color ?? '#7c5cff', sortOrder: r.sort_order }))
    },
    create(name: string, icon = '🗂️', color = '#7c5cff'): ProjectGroup {
      const nextOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM project_groups`).get() as any).n
      const info = db.prepare(`INSERT INTO project_groups (name, icon, color, sort_order) VALUES (?, ?, ?, ?)`).run(name, icon, color, nextOrder)
      return { id: Number(info.lastInsertRowid), name, icon, color, sortOrder: nextOrder }
    },

    /** Atualiza nome/ícone/cor (subset). */
    update(id: number, patch: { name?: string; icon?: string; color?: string }): ProjectGroup {
      const cur = (db.prepare(`SELECT id, name, icon, color, sort_order FROM project_groups WHERE id=?`).get(id) as any)
      if (!cur) throw new Error(`grupo ${id} não existe`)
      const next = { name: patch.name ?? cur.name, icon: patch.icon ?? cur.icon, color: patch.color ?? cur.color }
      db.prepare(`UPDATE project_groups SET name=?, icon=?, color=? WHERE id=?`).run(next.name, next.icon, next.color, id)
      return { id, ...next, sortOrder: cur.sort_order }
    },
    rename(id: number, name: string): ProjectGroup {
      return this.update(id, { name })
    },
    remove(id: number): void {
      db.prepare(`UPDATE projects SET group_id=NULL WHERE group_id=?`).run(id)
      db.prepare(`DELETE FROM project_groups WHERE id=?`).run(id)
    },
    /** Move um terminal para o grupo (ou null = raiz). Valida que o grupo existe. */
    setProjectGroup(projectId: number, groupId: number | null): void {
      if (groupId !== null && !db.prepare(`SELECT 1 FROM project_groups WHERE id=?`).get(groupId)) {
        throw new Error(`grupo ${groupId} não existe`)
      }
      const r = db.prepare(`UPDATE projects SET group_id=? WHERE id=?`).run(groupId, projectId)
      if (r.changes === 0) throw new Error(`projeto ${projectId} não existe`)
    },
    /**
     * Persiste a ORDEM COMPLETA da sidebar numa passada atômica: cada entrada (grupo
     * com filhos, ou terminal solto) recebe sort_order sequencial no MESMO espaço, e
     * a estrutura define o pertencimento (filho de grupo → group_id; solto → NULL).
     * Ids desconhecidos são ignorados; itens não mencionados ficam como estão.
     */
    applySidebarOrder(entries: SidebarEntry[]): void {
      const tx = db.transaction(() => {
        let seq = 0
        for (const e of entries) {
          if (e.kind === 'group') {
            db.prepare(`UPDATE project_groups SET sort_order=? WHERE id=?`).run(seq++, e.id)
            for (const pid of e.children) {
              db.prepare(`UPDATE projects SET group_id=?, sort_order=? WHERE id=?`).run(e.id, seq++, pid)
            }
          } else {
            db.prepare(`UPDATE projects SET group_id=NULL, sort_order=? WHERE id=?`).run(seq++, e.id)
          }
        }
      })
      tx()
    },
  }
}

export type GroupsService = ReturnType<typeof createGroupsService>
