import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { createGroupsService, type SidebarEntry } from '../groups.js'
import { createProjectsService } from '../projects.js'
import { canAccessProject, requireAdmin } from '../auth/guards.js'

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
  const validIcon = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 16 ? v.trim() : null
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
  app.put('/api/sidebar-order', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const raw = (req.body as { entries?: unknown })?.entries
    if (!Array.isArray(raw) || raw.length > 500) return reply.code(400).send({ error: 'entries inválido' })
    const entries: SidebarEntry[] = []
    for (const e of raw) {
      if (e?.kind === 'group' && Number.isInteger(e.id) && Array.isArray(e.children) && e.children.every((c: unknown) => Number.isInteger(c))) {
        entries.push({ kind: 'group', id: e.id, children: e.children })
      } else if (e?.kind === 'project' && Number.isInteger(e.id)) {
        entries.push({ kind: 'project', id: e.id })
      } else {
        return reply.code(400).send({ error: 'entrada inválida' })
      }
    }
    groups.applySidebarOrder(entries)
    return { projects: projects.list(), groups: groups.list() }
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
