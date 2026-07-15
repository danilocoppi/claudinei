import { randomBytes } from 'node:crypto'
import type { Db } from '../db.js'
import { createUsersService } from './users.js'
import { createTokenService, loadOrCreateSecret } from './tokens.js'

/**
 * Agregado de auth: usuários + tokens sobre um segredo persistido.
 * Sem secretPath (testes), o segredo é aleatório em memória.
 */
export function createAuthService(opts: { db: Db; secretPath?: string }) {
  const secret = opts.secretPath ? loadOrCreateSecret(opts.secretPath) : randomBytes(32)
  const users = createUsersService(opts.db)
  const tokens = createTokenService(secret)
  return { users, tokens, configured: () => users.count() > 0 }
}

export type AuthService = ReturnType<typeof createAuthService>
