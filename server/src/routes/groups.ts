import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { createGroupsService, type SidebarEntry } from '../groups.js'
import { createProjectsService } from '../projects.js'
import { canAccessProject, requireAdmin } from '../auth/guards.js'
import { iconValueOf } from '../icons/value.js'

/** Grupos visuais de terminais na sidebar. Mutações admin-only (como projetos);
 *  GET para qualquer autenticado — não-admin só vê grupos com ≥1 terminal acessível. */
export function registerGroupRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const groups = createGroupsService(deps.db)
  const projects = createProjectsService(deps.db)

  const validName = (v: unknown): string | null => {
    if (typeof v !== 'string') return null
    const name = v.trim()
    return name.length >= 1 && name.length <= 60 ? name : null
  }
  // A régua do ícone é uma só, e mora em icons/value.ts: emoji OU token do acervo.
  // Aqui havia um teto de 16 caracteres, de quando ícone era só emoji — com o
  // acervo novo isso virou loteria pelo comprimento do nome do desenho.
  const validIcon = iconValueOf
  const validColor = (v: unknown): string | null =>
    typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null

  app.get('/api/groups', async (req) => {
    const all = groups.list()
    const u = req.authUser
    if (!u || (u.kind === 'user' && u.isAdmin)) return all
    const accessibleGroupIds = new Set(
      projects.list().filter((p) => p.groupId !== null && canAccessProject(u, p.id)).map((p) => p.groupId),
    )
    return all.filter((g) => accessibleGroupIds.has(g.id))
  })

  app.post('/api/groups', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { name?: unknown; icon?: unknown; color?: unknown }
    const name = validName(body?.name)
    if (!name) return reply.code(400).send({ error: 'nome do grupo inválido (1..60 caracteres)' })
    return reply.code(201).send(groups.create(name, validIcon(body?.icon) ?? undefined, validColor(body?.color) ?? undefined))
  })

  app.patch('/api/groups/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { name?: unknown; icon?: unknown; color?: unknown }
    const patch: { name?: string; icon?: string; color?: string } = {}
    if (body?.name !== undefined) {
      const name = validName(body.name)
      if (!name) return reply.code(400).send({ error: 'nome do grupo inválido (1..60 caracteres)' })
      patch.name = name
    }
    if (body?.icon !== undefined) {
      const icon = validIcon(body.icon)
      if (!icon) return reply.code(400).send({ error: 'ícone inválido' })
      patch.icon = icon
    }
    if (body?.color !== undefined) {
      const color = validColor(body.color)
      if (!color) return reply.code(400).send({ error: 'cor inválida (use #rrggbb)' })
      patch.color = color
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nada para atualizar' })
    try { return groups.update(Number((req.params as { id: string }).id), patch) }
    catch (err) { return reply.code(404).send({ error: (err as Error).message }) }
  })

  app.delete('/api/groups/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    groups.remove(Number((req.params as { id: string }).id))
    return reply.code(204).send()
  })

  // Ordem completa da sidebar (drag & drop de grupos E terminais no mesmo espaço).
  // ---- Setores: um nível acima do grupo (grupos E terminais dentro) ----

  /** Não-admin só vê setor que contenha ao menos um terminal acessível — direto
   *  ou dentro de um grupo dele. Sem atravessar os dois níveis, um setor cujos
   *  terminais estão todos agrupados apareceria vazio para quem tem acesso a eles. */
  app.get('/api/sectors', async (req) => {
    const all = groups.listSectors()
    const u = req.authUser
    if (!u || (u.kind === 'user' && u.isAdmin)) return all
    const sectorOfGroup = new Map(groups.list().map((g) => [g.id, g.sectorId]))
    const visible = new Set<number>()
    for (const p of projects.list()) {
      if (!canAccessProject(u, p.id)) continue
      const sid = p.sectorId ?? (p.groupId !== null ? sectorOfGroup.get(p.groupId) ?? null : null)
      if (sid !== null && sid !== undefined) visible.add(sid)
    }
    return all.filter((s) => visible.has(s.id))
  })

  app.post('/api/sectors', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { name?: unknown; icon?: unknown; color?: unknown }
    const name = validName(body?.name)
    if (!name) return reply.code(400).send({ error: 'nome do setor inválido (1..60 caracteres)' })
    return reply.code(201).send(groups.createSector(name, validIcon(body?.icon) ?? undefined, validColor(body?.color) ?? undefined))
  })

  app.patch('/api/sectors/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { name?: unknown; icon?: unknown; color?: unknown }
    const patch: { name?: string; icon?: string; color?: string } = {}
    if (body?.name !== undefined) {
      const name = validName(body.name)
      if (!name) return reply.code(400).send({ error: 'nome do setor inválido (1..60 caracteres)' })
      patch.name = name
    }
    if (body?.icon !== undefined) {
      const icon = validIcon(body.icon)
      if (!icon) return reply.code(400).send({ error: 'ícone inválido' })
      patch.icon = icon
    }
    if (body?.color !== undefined) {
      const color = validColor(body.color)
      if (!color) return reply.code(400).send({ error: 'cor inválida (use #rrggbb)' })
      patch.color = color
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nada para atualizar' })
    try {
      return groups.updateSector(Number((req.params as { id: string }).id), patch)
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/sectors/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as { id: string }).id)
    if (!groups.listSectors().some((s) => s.id === id)) return reply.code(404).send({ error: `setor ${id} não existe` })
    groups.removeSector(id)
    return reply.code(204).send()
  })

  // Mover terminal / grupo para um setor (null = raiz).
  app.patch('/api/projects/:id/sector', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { sectorId?: number | null }
    const sectorId = body?.sectorId === null || body?.sectorId === undefined ? null : Number(body.sectorId)
    try {
      groups.setProjectSector(Number((req.params as { id: string }).id), sectorId)
      return { ok: true }
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })

  app.patch('/api/groups/:id/sector', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { sectorId?: number | null }
    const sectorId = body?.sectorId === null || body?.sectorId === undefined ? null : Number(body.sectorId)
    try {
      groups.setGroupSector(Number((req.params as { id: string }).id), sectorId)
      return { ok: true }
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })

  app.put('/api/sidebar-order', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const raw = (req.body as { entries?: unknown })?.entries
    if (!Array.isArray(raw) || raw.length > 500) return reply.code(400).send({ error: 'entries inválido' })
    // Um grupo válido: id inteiro + filhos que são ids de terminal.
    const asGroup = (e: any) =>
      e?.kind === 'group' && Number.isInteger(e.id) && Array.isArray(e.children) && e.children.every((c: unknown) => Number.isInteger(c))
        ? { kind: 'group' as const, id: e.id as number, children: e.children as number[] }
        : null
    const asProject = (e: any) =>
      e?.kind === 'project' && Number.isInteger(e.id) ? { kind: 'project' as const, id: e.id as number } : null

    const entries: SidebarEntry[] = []
    for (const e of raw) {
      const g = asGroup(e); const p = asProject(e)
      if (g) { entries.push(g); continue }
      if (p) { entries.push(p); continue }
      // Setor: só aceita grupo ou terminal dentro. Setor aninhado em setor é
      // recusado aqui — a profundidade é fixa, e aceitar em silêncio criaria uma
      // árvore que o resto do código não sabe desenhar.
      if (e?.kind === 'sector' && Number.isInteger(e.id) && Array.isArray(e.children)) {
        const children: Array<{ kind: 'group'; id: number; children: number[] } | { kind: 'project'; id: number }> = []
        let ok = true
        for (const c of e.children) {
          const cg = asGroup(c); const cp = asProject(c)
          if (cg) children.push(cg)
          else if (cp) children.push(cp)
          else { ok = false; break }
        }
        if (!ok) return reply.code(400).send({ error: 'entrada inválida' })
        entries.push({ kind: 'sector', id: e.id, children })
        continue
      }
      return reply.code(400).send({ error: 'entrada inválida' })
    }
    groups.applySidebarOrder(entries)
    return { projects: projects.list(), groups: groups.list(), sectors: groups.listSectors() }
  })

  app.patch('/api/projects/:id/group', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = req.body as { groupId?: number | null }
    const groupId = body?.groupId === null || body?.groupId === undefined ? null : Number(body.groupId)
    try {
      groups.setProjectGroup(Number((req.params as { id: string }).id), groupId)
      return { ok: true }
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })
}
