import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { canAccessProject } from '../auth/guards.js'
import { resolveInScope } from '../files/scope.js'
import type { ProjectsService } from '../projects.js'

const TEXT_CAP = 2 * 1024 * 1024 // 2 MB p/ texto/markdown/código
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
}

// authUser === undefined = auth desativada (modo local single-user) → trata como admin.
function isAdminReq(req: FastifyRequest): boolean {
  const u = req.authUser
  if (!u) return true
  return u.kind === 'user' && u.isAdmin
}

// Projeto acessível pelo usuário, ou null (relativo será ignorado; absoluto só p/ admin).
function projectFor(req: FastifyRequest, projects: ProjectsService, projectId?: number): { id: number; path: string } | null {
  if (!projectId) return null
  if (!canAccessProject(req.authUser, projectId)) return null
  const p = projects.get(projectId)
  return p ? { id: p.id, path: p.path } : null
}

export function registerFileRoutes(app: FastifyInstance, deps: { projects: ProjectsService }): void {
  app.post('/api/files/resolve', async (req) => {
    const body = req.body as { paths?: unknown; projectId?: number }
    const paths = Array.isArray(body?.paths)
      ? body.paths.filter((p): p is string => typeof p === 'string').slice(0, 200)
      : []
    const project = projectFor(req, deps.projects, body?.projectId)
    const admin = isAdminReq(req)
    // `real` (realpath absoluto no servidor) é SÓ para uso server-side (a rota
    // content). Nunca vai pro cliente — vazaria layout de diretório/username do SO.
    return paths.map((raw) => {
      const { real: _real, ...rest } = resolveInScope(raw, project, admin)
      return rest
    })
  })
  app.get('/api/files/content', async (req, reply) => {
    const q = req.query as { path?: string; projectId?: string }
    if (!q?.path) return reply.code(400).send({ error: 'path required' })
    const projectId = q.projectId ? Number(q.projectId) : undefined
    const project = projectFor(req, deps.projects, projectId)
    const r = resolveInScope(q.path, project, isAdminReq(req))
    if (!r.exists) return reply.code(404).send({ error: 'not found' })
    if (!r.inScope) return reply.code(403).send({ error: 'forbidden' })
    const real = r.real!
    const filename = basename(real).replace(/["\\]/g, '\\$&')
    // Segurança: o conteúdo é servido na MESMA origem do app. `nosniff` impede o
    // browser de re-interpretar um texto como HTML; `sandbox` neutraliza scripts se
    // o recurso for renderizado como documento (ex.: um .svg malicioso com <script>
    // aberto direto na URL → XSS que roubaria o cookie de auth). Ver review HIGH.
    reply.header('X-Content-Type-Options', 'nosniff')
    if (r.kind === 'image' || r.kind === 'pdf') {
      const ext = extname(real).toLowerCase()
      reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream')
      reply.header('Content-Disposition', `inline; filename="${filename}"`)
      // SVG pode conter script executável; PDF é renderizado isolado (não vira XSS
      // na origem do app), então o sandbox vai só nas imagens.
      if (r.kind === 'image') reply.header('Content-Security-Policy', 'sandbox')
      return reply.send(createReadStream(real))
    }
    if (r.kind === 'binary') {
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      reply.header('Content-Security-Policy', 'sandbox') // defesa em profundidade (já é attachment)
      return reply.send(createReadStream(real))
    }
    // text/markdown/code: lê com teto
    if ((r.size ?? 0) > TEXT_CAP) return reply.code(413).send({ error: 'file too large' })
    const buf = await readFile(real)
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    reply.header('Content-Security-Policy', 'sandbox')
    return reply.send(buf)
  })
}
