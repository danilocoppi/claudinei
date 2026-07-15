// CRUD de usuários + lockout + token_version. Regra dura: o último admin não
// pode ser removido nem rebaixado (senão ninguém mais administra o sistema).
import type { Db } from '../db.js'
import { hashPassword } from './passwords.js'

export interface PublicUser {
  id: number
  username: string
  isAdmin: boolean
  projectIds: number[]
  createdAt: string
}

export interface AuthRow {
  id: number
  username: string
  passwordHash: string
  isAdmin: boolean
  tokenVersion: number
}

const MAX_FAILURES = 5
const LOCK_MS = 15 * 60_000
const MIN_PASSWORD = 4

export function createUsersService(db: Db, now: () => number = Date.now) {
  const projectIdsOf = (userId: number): number[] =>
    (db.prepare('SELECT project_id FROM user_projects WHERE user_id=? ORDER BY project_id').all(userId) as Array<{ project_id: number }>)
      .map((r) => r.project_id)

  const toPublic = (row: any): PublicUser => ({
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    projectIds: projectIdsOf(row.id),
    createdAt: row.created_at,
  })

  const setProjects = (userId: number, ids: number[]): void => {
    db.prepare('DELETE FROM user_projects WHERE user_id=?').run(userId)
    const ins = db.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) VALUES (?,?)')
    for (const pid of ids) ins.run(userId, pid)
  }

  const getRaw = (id: number) => db.prepare('SELECT * FROM users WHERE id=?').get(id) as any
  const adminCount = () => (db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin=1').get() as any).c as number
  const assertNotLastAdmin = (id: number) => {
    const row = getRaw(id)
    if (row?.is_admin && adminCount() === 1) throw new Error('last_admin')
  }

  return {
    count: () => (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c as number,

    create(input: { username: string; password: string; isAdmin?: boolean; projectIds?: number[] }): PublicUser {
      const username = input.username?.trim()
      if (!username) throw new Error('username_required')
      if (!input.password || input.password.length < MIN_PASSWORD) throw new Error('password_too_short')
      let r
      try {
        r = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?,?,?)')
          .run(username, hashPassword(input.password), input.isAdmin ? 1 : 0)
      } catch (err) {
        const code = (err as { code?: string })?.code
        if (code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE')) throw new Error('username_taken')
        throw err
      }
      const id = Number(r.lastInsertRowid)
      setProjects(id, input.projectIds ?? [])
      return toPublic(getRaw(id))
    },

    list: (): PublicUser[] =>
      (db.prepare('SELECT * FROM users ORDER BY id').all() as any[]).map(toPublic),

    get(id: number): PublicUser | undefined {
      const row = getRaw(id)
      return row ? toPublic(row) : undefined
    },

    getByUsername(username: string): AuthRow | undefined {
      const row = db.prepare('SELECT * FROM users WHERE username=?').get(username) as any
      if (!row) return undefined
      return { id: row.id, username: row.username, passwordHash: row.password_hash, isAdmin: !!row.is_admin, tokenVersion: row.token_version }
    },

    update(id: number, patch: { password?: string; isAdmin?: boolean; projectIds?: number[] }): PublicUser {
      const row = getRaw(id)
      if (!row) throw new Error('user_not_found')
      if (patch.isAdmin === false) assertNotLastAdmin(id)
      if (patch.password !== undefined) {
        if (patch.password.length < MIN_PASSWORD) throw new Error('password_too_short')
        // senha nova mata os JWTs antigos deste usuário (ver = token_version)
        db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?')
          .run(hashPassword(patch.password), id)
      }
      if (patch.isAdmin !== undefined) db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(patch.isAdmin ? 1 : 0, id)
      if (patch.projectIds !== undefined) setProjects(id, patch.projectIds)
      return toPublic(getRaw(id))
    },

    remove(id: number): void {
      const row = getRaw(id)
      if (!row) throw new Error('user_not_found')
      assertNotLastAdmin(id)
      db.prepare('DELETE FROM users WHERE id=?').run(id)
    },

    /** ms restantes de bloqueio; 0 = livre. */
    isLocked(id: number): number {
      const row = getRaw(id)
      if (!row?.locked_until) return 0
      const rem = row.locked_until - now()
      return rem > 0 ? rem : 0
    },

    registerFailure(id: number): void {
      const row = getRaw(id)
      if (!row) return
      const fails = row.failed_logins + 1
      if (fails >= MAX_FAILURES) {
        db.prepare('UPDATE users SET failed_logins=0, locked_until=? WHERE id=?').run(now() + LOCK_MS, id)
      } else {
        db.prepare('UPDATE users SET failed_logins=? WHERE id=?').run(fails, id)
      }
    },

    clearFailures(id: number): void {
      db.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?').run(id)
    },

    tokenVersion(id: number): number | undefined {
      return (getRaw(id) as any)?.token_version
    },

    bumpTokenVersion(id: number): void {
      db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(id)
    },

    revokeAll(): void {
      db.prepare('UPDATE users SET token_version=token_version+1').run()
    },
  }
}

export type UsersService = ReturnType<typeof createUsersService>
