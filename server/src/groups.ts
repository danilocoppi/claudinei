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

export interface Sector {
  id: number
  name: string
  icon: string
  color: string
  sortOrder: number
}

/**
 * Uma entrada da sidebar na ordem visual. Três níveis: setor (com grupos e
 * terminais dentro), grupo (com terminais) ou terminal solto. Setor não aninha em
 * setor e grupo não aninha em grupo — a profundidade é fixa por construção, então
 * não há ciclo possível.
 */
export type SidebarEntry =
  | { kind: 'sector'; id: number; children: Array<{ kind: 'group'; id: number; children: number[] } | { kind: 'project'; id: number }> }
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
    /**
     * Apagar grupo nunca apaga terminal. Se o grupo vive num SETOR, os terminais
     * ficam nele — mandá-los para a raiz faria o operador perder a organização
     * que acabou de montar.
     */
    remove(id: number): void {
      const g = db.prepare(`SELECT sector_id FROM project_groups WHERE id=?`).get(id) as any
      db.prepare(`UPDATE projects SET group_id=NULL, sector_id=? WHERE group_id=?`).run(g?.sector_id ?? null, id)
      db.prepare(`DELETE FROM project_groups WHERE id=?`).run(id)
    },

    // ---- Setores: um nível acima do grupo, aceitando grupos E terminais ----

    listSectors(): Sector[] {
      return (db.prepare(`SELECT id, name, icon, color, sort_order FROM sectors ORDER BY sort_order ASC, id ASC`).all() as any[])
        .map((r) => ({ id: r.id, name: r.name, icon: r.icon ?? '🏢', color: r.color ?? '#58c4dc', sortOrder: r.sort_order }))
    },

    createSector(name: string, icon = '🏢', color = '#58c4dc'): Sector {
      const nextOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM sectors`).get() as any).n
      const info = db.prepare(`INSERT INTO sectors (name, icon, color, sort_order) VALUES (?, ?, ?, ?)`).run(name, icon, color, nextOrder)
      return { id: Number(info.lastInsertRowid), name, icon, color, sortOrder: nextOrder }
    },

    updateSector(id: number, patch: { name?: string; icon?: string; color?: string }): Sector {
      const cur = db.prepare(`SELECT id, name, icon, color, sort_order FROM sectors WHERE id=?`).get(id) as any
      if (!cur) throw new Error(`setor ${id} não existe`)
      const next = { name: patch.name ?? cur.name, icon: patch.icon ?? cur.icon, color: patch.color ?? cur.color }
      db.prepare(`UPDATE sectors SET name=?, icon=?, color=? WHERE id=?`).run(next.name, next.icon, next.color, id)
      return { id, ...next, sortOrder: cur.sort_order }
    },

    /** Apagar setor promove grupos e terminais à raiz — nada é apagado. */
    removeSector(id: number): void {
      db.prepare(`UPDATE project_groups SET sector_id=NULL WHERE sector_id=?`).run(id)
      db.prepare(`UPDATE projects SET sector_id=NULL WHERE sector_id=?`).run(id)
      db.prepare(`DELETE FROM sectors WHERE id=?`).run(id)
    },

    /**
     * Move um terminal para um setor (ou null = raiz). Limpa o group_id: o
     * pertencimento é único — group_id XOR sector_id —, e deixar os dois
     * preenchidos criaria um estado que só aparece errado na tela, tarde.
     */
    setProjectSector(projectId: number, sectorId: number | null): void {
      if (sectorId !== null && !db.prepare(`SELECT 1 FROM sectors WHERE id=?`).get(sectorId)) {
        throw new Error(`setor ${sectorId} não existe`)
      }
      const r = db.prepare(`UPDATE projects SET sector_id=?, group_id=NULL WHERE id=?`).run(sectorId, projectId)
      if (r.changes === 0) throw new Error(`projeto ${projectId} não existe`)
    },

    /** Move um GRUPO para um setor (ou null = raiz). */
    setGroupSector(groupId: number, sectorId: number | null): void {
      if (sectorId !== null && !db.prepare(`SELECT 1 FROM sectors WHERE id=?`).get(sectorId)) {
        throw new Error(`setor ${sectorId} não existe`)
      }
      const r = db.prepare(`UPDATE project_groups SET sector_id=? WHERE id=?`).run(sectorId, groupId)
      if (r.changes === 0) throw new Error(`grupo ${groupId} não existe`)
    },
    /** Move um terminal para o grupo (ou null = raiz). Valida que o grupo existe. */
    setProjectGroup(projectId: number, groupId: number | null): void {
      if (groupId !== null && !db.prepare(`SELECT 1 FROM project_groups WHERE id=?`).get(groupId)) {
        throw new Error(`grupo ${groupId} não existe`)
      }
      // Limpa o sector_id: o pertencimento é único (ver setProjectSector).
      const r = db.prepare(`UPDATE projects SET group_id=?, sector_id=NULL WHERE id=?`).run(groupId, projectId)
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
        // Travessia em PROFUNDIDADE: o contêiner recebe o seq antes dos filhos, e
        // cada nível fica ordenado entre si na leitura. `sectorId` desce na
        // recursão porque é a estrutura — não o payload — que define onde cada
        // item mora: um grupo fora de setor recebe null e volta para a raiz.
        const putGroup = (id: number, children: number[], sectorId: number | null) => {
          db.prepare(`UPDATE project_groups SET sort_order=?, sector_id=? WHERE id=?`).run(seq++, sectorId, id)
          for (const pid of children) {
            db.prepare(`UPDATE projects SET group_id=?, sector_id=NULL, sort_order=? WHERE id=?`).run(id, seq++, pid)
          }
        }
        const putProject = (id: number, sectorId: number | null) => {
          db.prepare(`UPDATE projects SET group_id=NULL, sector_id=?, sort_order=? WHERE id=?`).run(sectorId, seq++, id)
        }

        for (const e of entries) {
          if (e.kind === 'sector') {
            db.prepare(`UPDATE sectors SET sort_order=? WHERE id=?`).run(seq++, e.id)
            for (const child of e.children) {
              if (child.kind === 'group') putGroup(child.id, child.children, e.id)
              else putProject(child.id, e.id)
            }
          } else if (e.kind === 'group') {
            putGroup(e.id, e.children, null)
          } else {
            putProject(e.id, null)
          }
        }
      })
      tx()
    },
  }
}

export type GroupsService = ReturnType<typeof createGroupsService>
