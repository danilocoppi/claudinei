// Rotas de autenticação e administração de usuários.
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AuthService } from './index.js'
import { COOKIE_NAME, COOKIE_OPTS, isLoopbackIp } from './plugin.js'
import { requireAdmin } from './guards.js'
import { verifyPassword, verifyPasswordAsync, fakeVerifyAsync } from './passwords.js'

export interface AuthRouteDeps {
  auth: AuthService
  /** Chamado após revoke-all (derruba todos os WS). */
  onRevokeAll?: () => void
  /** Chamado quando os tokens/permissões de UM usuário mudam (derruba os WS dele). */
  onUserInvalidated?: (userId: number) => void
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { auth } = deps
  const setAuthCookie = (reply: FastifyReply, userId: number): void => {
    const ver = auth.users.tokenVersion(userId) ?? 0
    reply.setCookie(COOKIE_NAME, auth.tokens.signUser(userId, ver), COOKIE_OPTS)
  }

  app.post('/api/auth/setup', async (req, reply) => {
    if (auth.users.count() > 0) return reply.code(403).send({ error: 'already_configured' })
    // defesa em profundidade: o hook global já barra não-loopback no pré-setup
    if (!isLoopbackIp(req.ip)) return reply.code(403).send({ error: 'setup_required_localhost_only' })
    const body = (req.body ?? {}) as { username?: string; password?: string }
    if (!body.username || !body.password) return reply.code(400).send({ error: 'username_and_password_required' })
    try {
      const user = auth.users.create({ username: body.username, password: body.password, isAdmin: true })
      setAuthCookie(reply, user.id)
      return reply.code(201).send(user)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string }
    if (!body.username || !body.password) return reply.code(400).send({ error: 'username_and_password_required' })
    const row = auth.users.getByUsername(body.username)
    // resposta idêntica para "user não existe" e "senha errada" — não vaza usernames.
    // Também equalizamos o TEMPO: sem usuário, ainda rodamos um scrypt "dummy"
    // antes de responder, pra não dar ~30x menos latência que o caminho de
    // senha errada (que rodaria scrypt de verdade) — isso vazaria por timing
    // quais usernames existem. Resíduo aceito: a transição 401→429 (lockout)
    // ainda distingue username real de fantasma; é inerente ao lockout
    // por-usuário e aceitável numa ferramenta local-first.
    if (!row) {
      await fakeVerifyAsync(body.password)
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
    const lockedMs = auth.users.isLocked(row.id)
    if (lockedMs > 0) return reply.code(429).send({ error: 'locked', retryAfterMs: lockedMs })
    if (!(await verifyPasswordAsync(body.password, row.passwordHash))) {
      auth.users.registerFailure(row.id)
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
    auth.users.clearFailures(row.id)
    setAuthCookie(reply, row.id)
    return auth.users.get(row.id)
  })

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/auth/me', async (req, reply) => {
    if (auth.users.count() === 0) return { setupRequired: true }
    const u = req.authUser
    if (!u || u.kind !== 'user') return reply.code(401).send({ error: 'unauthorized' })
    return { setupRequired: false, id: u.id, username: u.username, isAdmin: u.isAdmin, projectIds: u.projectIds }
  })

  app.post('/api/auth/password', async (req, reply) => {
    const u = req.authUser
    if (!u || u.kind !== 'user') return reply.code(401).send({ error: 'unauthorized' })
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string }
    if (!body.currentPassword || !body.newPassword) return reply.code(400).send({ error: 'passwords_required' })
    const row = auth.users.getByUsername(u.username)!
    if (!verifyPassword(body.currentPassword, row.passwordHash)) {
      return reply.code(400).send({ error: 'wrong_current_password' })
    }
    try {
      auth.users.update(u.id, { password: body.newPassword }) // bumpa token_version
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
    deps.onUserInvalidated?.(u.id)
    setAuthCookie(reply, u.id) // re-loga ESTE navegador com o ver novo
    return { ok: true }
  })

  // ---- admin ----

  app.get('/api/auth/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return auth.users.list()
  })

  app.post('/api/auth/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const body = (req.body ?? {}) as { username?: string; password?: string; isAdmin?: boolean; projectIds?: number[] }
    if (!body.username || !body.password) return reply.code(400).send({ error: 'username_and_password_required' })
    try {
      return reply.code(201).send(auth.users.create({
        username: body.username, password: body.password,
        isAdmin: !!body.isAdmin, projectIds: body.projectIds ?? [],
      }))
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.patch('/api/auth/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as { password?: string; isAdmin?: boolean; projectIds?: number[] }
    try {
      const user = auth.users.update(id, body)
      deps.onUserInvalidated?.(id) // WS dele reconecta com as permissões novas
      return user
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/auth/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const id = Number((req.params as { id: string }).id)
    try {
      auth.users.remove(id)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
    deps.onUserInvalidated?.(id)
    return reply.code(204).send()
  })

  app.post('/api/auth/revoke-all', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    auth.users.revokeAll()
    deps.onRevokeAll?.()
    return reply.code(204).send()
  })
}
