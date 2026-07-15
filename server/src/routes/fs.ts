import type { FastifyInstance } from 'fastify'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { requireAdmin } from '../auth/guards.js'

export function registerFsRoutes(app: FastifyInstance): void {
  app.get('/api/fs/list', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const q = (req.query as { path?: string }).path
    const target = q && q.trim() ? resolve(q) : homedir()
    let st
    try {
      st = statSync(target)
    } catch {
      return reply.code(400).send({ error: `diretório não acessível: ${target}` })
    }
    if (!st.isDirectory()) {
      return reply.code(400).send({ error: `não é um diretório: ${target}` })
    }
    let names: string[]
    try {
      names = readdirSync(target)
    } catch {
      return reply.code(400).send({ error: `sem permissão de leitura: ${target}` })
    }
    const insideHidden = /(^|\/)\.[^/]*$/.test(target)
    const entries = names
      .filter((n) => insideHidden || !n.startsWith('.'))
      .map((name) => ({ name, path: join(target, name) }))
      .filter((e) => {
        try { return statSync(e.path).isDirectory() } catch { return false }
      })
      .map((e) => ({ name: e.name, path: e.path, isDir: true as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = target === '/' ? null : dirname(target)
    return { path: target, parent, entries }
  })
}
