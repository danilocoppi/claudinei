// Guards de RBAC. authUser === undefined significa "auth desativada" (modo
// pré-setup em loopback, ou app de teste sem deps.auth) — libera, porque nesse
// modo o hook global já barrou qualquer origem não-loopback.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUser } from './plugin.js'

export function canAccessProject(user: AuthUser | undefined, projectId: number): boolean {
  if (!user) return true
  if (user.kind === 'service') return true
  return user.isAdmin || user.projectIds.includes(projectId)
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const u = req.authUser
  if (!u || (u.kind === 'user' && u.isAdmin)) return true
  reply.code(403).send({ error: 'admin_only' })
  return false
}

export function requireProjectAccess(req: FastifyRequest, reply: FastifyReply, projectId: number): boolean {
  if (canAccessProject(req.authUser, projectId)) return true
  reply.code(403).send({ error: 'forbidden_project' })
  return false
}
