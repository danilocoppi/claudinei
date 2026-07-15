# Autenticação multi-usuário (Sub-projeto 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Login multi-usuário com JWT (cookie httpOnly), RBAC binário por terminal, painel admin, lockout e revogação global — habilitando `--host 0.0.0.0` sem `--insecure`.

**Architecture:** Módulo isolado `server/src/auth/` (passwords scrypt, tokens fast-jwt, users CRUD+lockout, plugin Fastify com hook `onRequest` global "fechado por padrão", guards, rotas `/api/auth/*`). Enforcement nas rotas existentes + WS com broadcast filtrado por projeto. Hermes MCP autentica com token de serviço injetado por env. Frontend ganha um gate de boot (Sign in / Create master) e menu 👤 ao lado do logo.

**Tech Stack:** Fastify 5, `fast-jwt` + `@fastify/cookie` (JS puro — zero nativos novos, compatível com o binário único), `scrypt` do `node:crypto`, better-sqlite3, React 18 + zustand + react-i18next, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-auth-multiuser-design.md`.
- **Zero dependências nativas novas** (o binário único `npm run package` precisa continuar funcionando).
- Hash de senha: `scrypt` (`N=16384, r=8, p=1`, salt 16B, hash 32B), formato `scrypt:<saltB64>:<hashB64>`, comparação com `timingSafeEqual`.
- JWT de usuário: payload `{ sub: String(userId), ver: token_version }`, expira em **7 dias**. JWT de serviço: `{ sub: 'service' }`, exp 30 dias, re-assinado a cada boot.
- Cookie: nome **`claudinei_token`**, `httpOnly`, `sameSite: 'strict'`, `path: '/'`, `maxAge` 7 dias (segundos). Sem `Secure` (TLS é proxy externo, fora de escopo).
- Segredo JWT: 32 bytes aleatórios persistidos em `<dir do dbPath>/jwt-secret` (mode 0600), i.e. `~/.claudinei/jwt-secret`.
- Lockout: **5** falhas → **15 min** (`locked_until` epoch ms persistido; 429 com `retryAfterMs`).
- Com **0 usuários**: requisição **não-loopback** a QUALQUER rota → 403 `setup_required_localhost_only`; loopback tem acesso livre (modo pré-setup = comportamento atual — preserva os testes existentes, que injetam de 127.0.0.1).
- Com ≥1 usuário: **tudo** `/api/*` e `/ws*` exige JWT válido (cookie ou `Authorization: Bearer`), inclusive de localhost. Públicos: `POST /api/auth/login`, `POST /api/auth/setup`, `POST /api/auth/logout`, `GET /api/auth/me`, e todo caminho não-API (assets do SPA).
- Token de serviço só passa em `/api/hermes/*` **e `/api/orchestrator/*`** (correção sobre o spec: o hermes MCP chama `dispatch_task`/`list_tasks` em `/api/orchestrator/*` — restringir só a `/api/hermes/*` quebraria as tools).
- Admin-only: escrita de projetos (POST/PATCH/DELETE/order), `/api/fs/*`, `/api/usage`, `/api/auth/users*`, `/api/auth/revoke-all`. Não-admin: vê/opera só projetos da sua lista. Uploads e `/api/transcribe`: qualquer autenticado.
- Erros de auth usam slugs estáveis: `unauthorized`, `invalid_credentials`, `locked`, `admin_only`, `forbidden_project`, `service_token_scope`, `setup_required_localhost_only`, `last_admin`.
- Nomenclatura de UI em inglês; strings via i18n (en, pt-BR, es).
- Server: ESM/TS strict, imports relativos com `.js`. Web: sem extensão. Commits com trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Rodar testes: `cd server && npm test` / `cd web && npm test`; um arquivo: `npx vitest run test/<arquivo> --root server` (ou `cd server && npx vitest run test/<arquivo>`).

---

### Task 1: Fundações — deps, `passwords.ts`, `tokens.ts`

**Files:**
- Modify: `server/package.json` (deps novas via npm install)
- Create: `server/src/auth/passwords.ts`
- Create: `server/src/auth/tokens.ts`
- Test: `server/test/auth-passwords.test.ts`, `server/test/auth-tokens.test.ts`

**Interfaces:**
- Consumes: nada (folha).
- Produces: `hashPassword(plain: string): string`; `verifyPassword(plain: string, stored: string): boolean`; `loadOrCreateSecret(path: string): Buffer`; `createTokenService(secret: Buffer)` → `{ signUser(userId: number, tokenVersion: number): string; signService(): string; verify(token: string): { sub: string; ver?: number } | null }`.

- [ ] **Step 1: Instalar dependências**

```bash
cd /home/coppi/Projects/Termaster/server
npm install fast-jwt @fastify/cookie
```

Expected: ambas entram em `dependencies` do `server/package.json`; nenhuma é nativa (instalação sem node-gyp).

- [ ] **Step 2: Escrever os testes que falham**

`server/test/auth-passwords.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/passwords.js'

describe('passwords (scrypt)', () => {
  it('hash e verify fecham o ciclo', () => {
    const stored = hashPassword('s3nha!')
    expect(stored.startsWith('scrypt:')).toBe(true)
    expect(verifyPassword('s3nha!', stored)).toBe(true)
    expect(verifyPassword('errada', stored)).toBe(false)
  })

  it('salts aleatórios: mesmo plaintext gera hashes diferentes', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })

  it('formato inválido nunca verifica (nem lança)', () => {
    expect(verifyPassword('x', 'lixo')).toBe(false)
    expect(verifyPassword('x', 'scrypt:aa')).toBe(false)
    expect(verifyPassword('x', 'bcrypt:aaaa:bbbb')).toBe(false)
    expect(verifyPassword('x', 'scrypt:!!!:???')).toBe(false)
  })
})
```

`server/test/auth-tokens.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createTokenService, loadOrCreateSecret } from '../src/auth/tokens.js'

describe('loadOrCreateSecret', () => {
  it('cria 32 bytes com mode 0600 e reusa na segunda chamada', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'auth-')), 'jwt-secret')
    const s1 = loadOrCreateSecret(p)
    expect(s1.length).toBe(32)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(loadOrCreateSecret(p).equals(s1)).toBe(true)
    expect(readFileSync(p).equals(s1)).toBe(true)
  })
})

describe('tokens (fast-jwt)', () => {
  const svc = createTokenService(randomBytes(32))

  it('assina e verifica token de usuário com sub/ver', () => {
    const t = svc.signUser(7, 3)
    const p = svc.verify(t)
    expect(p).toMatchObject({ sub: '7', ver: 3 })
  })

  it('assina e verifica token de serviço', () => {
    expect(svc.verify(svc.signService())).toMatchObject({ sub: 'service' })
  })

  it('rejeita token adulterado e de outro segredo (null, sem lançar)', () => {
    expect(svc.verify(svc.signUser(1, 0) + 'x')).toBeNull()
    const outro = createTokenService(randomBytes(32))
    expect(svc.verify(outro.signUser(1, 0))).toBeNull()
    expect(svc.verify('nem-é-jwt')).toBeNull()
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd server && npx vitest run test/auth-passwords.test.ts test/auth-tokens.test.ts`
Expected: FAIL — `Cannot find module '../src/auth/passwords.js'`.

- [ ] **Step 4: Implementar**

`server/src/auth/passwords.ts`:

```typescript
// Hash de senha com scrypt do node:crypto — zero dependências nativas novas
// (restrição do binário único). Formato armazenado: scrypt:<saltB64>:<hashB64>.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

const SCRYPT = { N: 16384, r: 8, p: 1 } as const
const KEYLEN = 32

export function hashPassword(plain: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(plain, salt, KEYLEN, SCRYPT)
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64')
    const expected = Buffer.from(parts[2], 'base64')
    if (expected.length !== KEYLEN) return false
    return timingSafeEqual(scryptSync(plain, salt, KEYLEN, SCRYPT), expected)
  } catch {
    return false
  }
}
```

`server/src/auth/tokens.ts`:

```typescript
// JWTs de usuário e de serviço (fast-jwt, HS256 com segredo local persistido).
// verify() devolve null em QUALQUER token inválido — o chamador nunca precisa
// de try/catch.
import { createSigner, createVerifier } from 'fast-jwt'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const USER_TTL_MS = 7 * 24 * 3600 * 1000
const SERVICE_TTL_MS = 30 * 24 * 3600 * 1000

export interface TokenPayload {
  sub: string // String(userId) ou 'service'
  ver?: number // token_version do usuário na emissão (ausente no serviço)
}

export function loadOrCreateSecret(path: string): Buffer {
  if (existsSync(path)) return readFileSync(path)
  const secret = randomBytes(32)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, secret, { mode: 0o600 })
  return secret
}

export function createTokenService(secret: Buffer) {
  const signUser = createSigner({ key: secret, expiresIn: USER_TTL_MS })
  const signService = createSigner({ key: secret, expiresIn: SERVICE_TTL_MS })
  const verifier = createVerifier({ key: secret })
  return {
    signUser: (userId: number, tokenVersion: number): string =>
      signUser({ sub: String(userId), ver: tokenVersion }),
    signService: (): string => signService({ sub: 'service' }),
    verify(token: string): TokenPayload | null {
      try {
        return verifier(token) as TokenPayload
      } catch {
        return null
      }
    },
  }
}

export type TokenService = ReturnType<typeof createTokenService>
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd server && npx vitest run test/auth-passwords.test.ts test/auth-tokens.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 6: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/package.json server/package-lock.json server/src/auth server/test/auth-passwords.test.ts server/test/auth-tokens.test.ts
git commit -m "feat(auth): passwords scrypt + tokens JWT (fast-jwt) com segredo persistido

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Schema + `users.ts` (CRUD, lockout, tokenVersion)

**Files:**
- Modify: `server/src/db.ts` (novas tabelas no `SCHEMA`)
- Create: `server/src/auth/users.ts`
- Test: `server/test/auth-users.test.ts`

**Interfaces:**
- Consumes: `hashPassword`/`verifyPassword` de `./passwords.js` (Task 1); `openDb` de `../db.js`.
- Produces: `createUsersService(db: Db, now?: () => number)` →
  `{ count(): number; create(input: { username: string; password: string; isAdmin?: boolean; projectIds?: number[] }): PublicUser; list(): PublicUser[]; get(id: number): PublicUser | undefined; getByUsername(username: string): AuthRow | undefined; update(id: number, patch: { password?: string; isAdmin?: boolean; projectIds?: number[] }): PublicUser; remove(id: number): void; isLocked(id: number): number; registerFailure(id: number): void; clearFailures(id: number): void; tokenVersion(id: number): number | undefined; bumpTokenVersion(id: number): void; revokeAll(): void }`.
  `PublicUser = { id: number; username: string; isAdmin: boolean; projectIds: number[]; createdAt: string }`; `AuthRow = { id: number; username: string; passwordHash: string; isAdmin: boolean; tokenVersion: number }`.

- [ ] **Step 1: Escrever os testes que falham**

`server/test/auth-users.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createUsersService } from '../src/auth/users.js'
import { verifyPassword } from '../src/auth/passwords.js'

let db: Db
beforeEach(() => { db = openDb(':memory:') })

describe('users: CRUD', () => {
  it('create/list/get sem expor hash; count reflete', () => {
    const svc = createUsersService(db)
    expect(svc.count()).toBe(0)
    const u = svc.create({ username: 'master', password: 'abcd', isAdmin: true })
    expect(u).toMatchObject({ username: 'master', isAdmin: true, projectIds: [] })
    expect('passwordHash' in u).toBe(false)
    expect(svc.count()).toBe(1)
    expect(svc.list()[0].username).toBe('master')
    expect(svc.get(u.id)?.id).toBe(u.id)
  })

  it('getByUsername devolve hash verificável e tokenVersion', () => {
    const svc = createUsersService(db)
    const u = svc.create({ username: 'ana', password: 'segredo' })
    const row = svc.getByUsername('ana')!
    expect(verifyPassword('segredo', row.passwordHash)).toBe(true)
    expect(row.tokenVersion).toBe(0)
    expect(row.id).toBe(u.id)
    expect(svc.getByUsername('ninguem')).toBeUndefined()
  })

  it('username duplicado e senha curta rejeitam', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'ana', password: 'abcd' })
    expect(() => svc.create({ username: 'ana', password: 'abcd' })).toThrow()
    expect(() => svc.create({ username: 'bia', password: 'abc' })).toThrow('password_too_short')
    expect(() => svc.create({ username: '  ', password: 'abcd' })).toThrow('username_required')
  })

  it('update troca projetos, admin e senha (senha bumpa tokenVersion)', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    const u = svc.create({ username: 'ana', password: 'abcd', projectIds: [1, 2] })
    expect(svc.get(u.id)?.projectIds).toEqual([1, 2])
    svc.update(u.id, { projectIds: [3], isAdmin: false })
    expect(svc.get(u.id)?.projectIds).toEqual([3])
    svc.update(u.id, { password: 'nova!' })
    expect(verifyPassword('nova!', svc.getByUsername('ana')!.passwordHash)).toBe(true)
    expect(svc.tokenVersion(u.id)).toBe(1)
  })

  it('remove apaga user e vínculos', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    const u = svc.create({ username: 'ana', password: 'abcd', projectIds: [1] })
    svc.remove(u.id)
    expect(svc.get(u.id)).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) c FROM user_projects').get() as any).c).toBe(0)
  })

  it('último admin não pode ser removido nem des-adminado', () => {
    const svc = createUsersService(db)
    const root = svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    expect(() => svc.remove(root.id)).toThrow('last_admin')
    expect(() => svc.update(root.id, { isAdmin: false })).toThrow('last_admin')
    svc.create({ username: 'root2', password: 'abcd', isAdmin: true })
    svc.remove(root.id) // agora pode
    expect(svc.count()).toBe(1)
  })
})

describe('users: lockout (clock injetado)', () => {
  it('5ª falha tranca por 15 min; sucesso pós-expiração destrava', () => {
    let clock = 1_000_000
    const svc = createUsersService(db, () => clock)
    const u = svc.create({ username: 'ana', password: 'abcd' })
    for (let i = 0; i < 4; i++) svc.registerFailure(u.id)
    expect(svc.isLocked(u.id)).toBe(0)
    svc.registerFailure(u.id) // 5ª
    expect(svc.isLocked(u.id)).toBe(15 * 60_000)
    clock += 10 * 60_000
    expect(svc.isLocked(u.id)).toBe(5 * 60_000)
    clock += 6 * 60_000
    expect(svc.isLocked(u.id)).toBe(0)
    svc.clearFailures(u.id)
    svc.registerFailure(u.id) // contador zerou: 1ª falha de novo
    expect(svc.isLocked(u.id)).toBe(0)
  })
})

describe('users: revogação', () => {
  it('bumpTokenVersion incrementa um; revokeAll incrementa todos', () => {
    const svc = createUsersService(db)
    const a = svc.create({ username: 'a', password: 'abcd', isAdmin: true })
    const b = svc.create({ username: 'b', password: 'abcd' })
    svc.bumpTokenVersion(a.id)
    expect(svc.tokenVersion(a.id)).toBe(1)
    expect(svc.tokenVersion(b.id)).toBe(0)
    svc.revokeAll()
    expect(svc.tokenVersion(a.id)).toBe(2)
    expect(svc.tokenVersion(b.id)).toBe(1)
    expect(svc.tokenVersion(999)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/auth-users.test.ts`
Expected: FAIL — módulo `users.js` não existe.

- [ ] **Step 3: Migração no `db.ts`**

Em `server/src/db.ts`, acrescentar ao final da const `SCHEMA` (antes do fecha-crase):

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_projects (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);
```

(`CREATE TABLE IF NOT EXISTS` é a migração — mesmo padrão das tabelas existentes. O `ON DELETE CASCADE` em `project_id` limpa a lista quando um projeto é excluído — borda do spec.)

- [ ] **Step 4: Implementar `server/src/auth/users.ts`**

```typescript
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
      const r = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?,?,?)')
        .run(username, hashPassword(input.password), input.isAdmin ? 1 : 0)
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
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd server && npx vitest run test/auth-users.test.ts test/db.test.ts`
Expected: PASS (novos + db.test.ts continua verde).

- [ ] **Step 6: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/db.ts server/src/auth/users.ts server/test/auth-users.test.ts
git commit -m "feat(auth): tabelas users/user_projects + serviço de usuários com lockout e tokenVersion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `createAuthService` + plugin (hook global) + guards

**Files:**
- Create: `server/src/auth/index.ts`
- Create: `server/src/auth/plugin.ts`
- Create: `server/src/auth/guards.ts`
- Modify: `server/src/app.ts` (deps.auth opcional + registro do plugin ANTES das rotas)
- Test: `server/test/auth-plugin.test.ts`

**Interfaces:**
- Consumes: `createUsersService` (Task 2), `createTokenService`/`loadOrCreateSecret` (Task 1).
- Produces:
  - `createAuthService(opts: { db: Db; secretPath?: string }): AuthService` — `{ users: UsersService; tokens: TokenService; configured(): boolean }`. Sem `secretPath` → segredo aleatório em memória (testes).
  - `registerAuth(app: FastifyInstance, deps: { auth: AuthService })` — registra `@fastify/cookie` + hook global; decora `req.authUser?: AuthUser`.
  - `type AuthUser = { kind: 'user'; id: number; username: string; isAdmin: boolean; projectIds: number[] } | { kind: 'service' }`.
  - `COOKIE_NAME = 'claudinei_token'`; `isLoopbackIp(ip: string): boolean`.
  - `canAccessProject(user: AuthUser | undefined, projectId: number): boolean`; `requireAdmin(req, reply): boolean`; `requireProjectAccess(req, reply, projectId: number): boolean` (respondem 403 e devolvem false).
  - `AppDeps.auth?: AuthService` em `app.ts` — quando ausente (testes existentes), nada de auth é registrado e `req.authUser` fica `undefined` (guards liberam: semântica de "auth desativada" = pré-setup loopback).

- [ ] **Step 1: Escrever os testes que falham**

`server/test/auth-plugin.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager, auth })
})

const login = async (username: string, password: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
  const cookie = res.cookies.find((c) => c.name === COOKIE_NAME)
  return { res, cookie: cookie ? { [COOKIE_NAME]: cookie.value } : {} }
}

describe('pré-setup (0 usuários)', () => {
  it('loopback tem acesso livre (comportamento atual preservado)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(200)
  })

  it('não-loopback leva 403 setup_required_localhost_only em QUALQUER rota', async () => {
    for (const url of ['/api/projects', '/api/health', '/qualquer-asset.js']) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: '192.168.1.50' })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toBe('setup_required_localhost_only')
    }
  })
})

describe('configurado (≥1 usuário)', () => {
  beforeEach(() => { auth.users.create({ username: 'root', password: 'abcd', isAdmin: true }) })

  it('sem token: /api/* → 401; assets do SPA passam; login é público', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401)
    // rota inexistente fora de /api não é barrada pelo hook (404 do fastify, não 401)
    expect((await app.inject({ method: 'GET', url: '/assets/x.js' })).statusCode).toBe(404)
    const { res } = await login('root', 'abcd')
    expect(res.statusCode).toBe(200)
  })

  it('cookie válido passa; token com ver antigo (revogado) → 401', async () => {
    const { cookie } = await login('root', 'abcd')
    expect((await app.inject({ method: 'GET', url: '/api/projects', cookies: cookie })).statusCode).toBe(200)
    auth.users.revokeAll()
    expect((await app.inject({ method: 'GET', url: '/api/projects', cookies: cookie })).statusCode).toBe(401)
  })

  it('token de usuário excluído → 401', async () => {
    const u = auth.users.create({ username: 'ana', password: 'abcd' })
    const { cookie } = await login('ana', 'abcd')
    auth.users.remove(u.id)
    expect((await app.inject({ method: 'GET', url: '/api/sessions', cookies: cookie })).statusCode).toBe(401)
  })

  it('bearer de serviço passa em hermes/orchestrator e 403 no resto', async () => {
    const h = { authorization: `Bearer ${auth.tokens.signService()}` }
    expect((await app.inject({ method: 'GET', url: '/api/hermes/projects', headers: h })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/orchestrator/tasks', headers: h })).statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: h })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('service_token_scope')
  })
})
```

(Este teste usa `POST /api/auth/login` da Task 4 — os dois testes de "configurado" que dependem de login vão falhar até a Task 4; implementar aqui só o que o plugin cobre e marcar a suíte inteira verde AO FIM da Task 4 é aceitável. Alternativa preferida: implementar Tasks 3 e 4 na ordem e rodar esta suíte completa na Task 4. Para a Task 3 valem os testes de pré-setup + o de serviço, que não usam login: rode-os com `-t 'pré-setup' -t 'serviço'`.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/auth-plugin.test.ts`
Expected: FAIL — `createAuthService` não existe.

- [ ] **Step 3: Implementar**

`server/src/auth/guards.ts`:

```typescript
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
```

`server/src/auth/plugin.ts`:

```typescript
// Hook global de autenticação: com usuários cadastrados, TODA rota /api|/ws
// exige JWT (cookie do navegador ou bearer do hermes) — rota nova nasce
// fechada. Com 0 usuários (pré-setup) só loopback entra, sem credenciais.
import cookie from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'
import type { AuthService } from './index.js'

export type AuthUser =
  | { kind: 'user'; id: number; username: string; isAdmin: boolean; projectIds: number[] }
  | { kind: 'service' }

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser
  }
}

export const COOKIE_NAME = 'claudinei_token'

// Rotas alcançáveis sem token quando a auth está ativa (o /me resolve o token
// se houver, mas responde 401 amigável em vez de ser barrado no hook).
const PUBLIC = new Set([
  'POST /api/auth/login',
  'POST /api/auth/setup',
  'POST /api/auth/logout',
  'GET /api/auth/me',
])

// Escopo do token de serviço: só as APIs que o hermes MCP consome
// (list/ask/board em /api/hermes/*; dispatch/list_tasks em /api/orchestrator/*).
const SERVICE_PREFIXES = ['/api/hermes/', '/api/orchestrator/']

export function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')
}

export async function registerAuth(app: FastifyInstance, deps: { auth: AuthService }): Promise<void> {
  await app.register(cookie)
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    const guarded = path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/')

    if (deps.auth.users.count() === 0) {
      // Pré-setup: sem credenciais no mundo — só o próprio computador entra.
      if (!isLoopbackIp(req.ip)) {
        return reply.code(403).send({ error: 'setup_required_localhost_only' })
      }
      return
    }

    // Resolve o token mesmo em rota pública (o /me usa req.authUser se houver).
    const authz = req.headers.authorization
    const bearer = authz?.startsWith('Bearer ') ? authz.slice(7) : undefined
    const token = req.cookies?.[COOKIE_NAME] ?? bearer
    const payload = token ? deps.auth.tokens.verify(token) : null
    if (payload) {
      if (payload.sub === 'service') {
        req.authUser = { kind: 'service' }
      } else {
        const id = Number(payload.sub)
        // ver ≠ token_version atual = token revogado (revoke-all / senha trocada)
        if (deps.auth.users.tokenVersion(id) === payload.ver) {
          const u = deps.auth.users.get(id)
          if (u) req.authUser = { kind: 'user', id: u.id, username: u.username, isAdmin: u.isAdmin, projectIds: u.projectIds }
        }
      }
    }

    if (!guarded || PUBLIC.has(`${req.method} ${path}`)) return
    if (!req.authUser) return reply.code(401).send({ error: 'unauthorized' })
    if (req.authUser.kind === 'service' && !SERVICE_PREFIXES.some((p) => path.startsWith(p))) {
      return reply.code(403).send({ error: 'service_token_scope' })
    }
  })
}
```

`server/src/auth/index.ts`:

```typescript
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
```

`server/src/app.ts` — acrescentar ao `AppDeps`:

```typescript
import type { AuthService } from './auth/index.js'
import { registerAuth } from './auth/plugin.js'
```

```typescript
  /** Auth multi-usuário. Ausente (testes legados) = sem auth: comportamento aberto de sempre. */
  auth?: AuthService
```

E em `buildApp`, logo após `await app.register(websocket)` (o hook precisa existir ANTES de qualquer rota):

```typescript
  if (deps.auth) await registerAuth(app, { auth: deps.auth })
```

- [ ] **Step 4: Rodar (parcial) e ver passar**

Run: `cd server && npx vitest run test/auth-plugin.test.ts -t 'pré-setup' && npx vitest run test/auth-plugin.test.ts -t 'serviço'`
Expected: PASS nos casos de pré-setup e de token de serviço (os de login completam na Task 4).

- [ ] **Step 5: Suíte inteira (regressão) + tsc + commit**

Run: `cd server && npm test` — os testes existentes constroem `buildApp` SEM `auth` e continuam verdes.

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/auth server/src/app.ts server/test/auth-plugin.test.ts
git commit -m "feat(auth): plugin com hook global (fechado por padrão), guards RBAC e createAuthService

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Rotas `/api/auth/*` (setup, login, me, password, users CRUD, revoke-all)

**Files:**
- Create: `server/src/auth/routes.ts`
- Modify: `server/src/app.ts` (registrar rotas junto do plugin)
- Test: `server/test/auth-routes.test.ts` (+ `auth-plugin.test.ts` inteiro fica verde)

**Interfaces:**
- Consumes: `AuthService`, `COOKIE_NAME`, `isLoopbackIp`, `requireAdmin`, `verifyPassword`.
- Produces: `registerAuthRoutes(app, deps: { auth: AuthService; onRevokeAll?: () => void; onUserInvalidated?: (userId: number) => void })`. Rotas: `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password`, `GET|POST /api/auth/users`, `PATCH|DELETE /api/auth/users/:id`, `POST /api/auth/revoke-all`. Shape de "me": `{ setupRequired: boolean, id?, username?, isAdmin?, projectIds? }`.

- [ ] **Step 1: Escrever os testes que falham**

`server/test/auth-routes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService
const onRevokeAll = vi.fn()

beforeEach(async () => {
  onRevokeAll.mockClear()
  db = openDb(':memory:')
  auth = createAuthService({ db })
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager, auth, onRevokeAll })
})

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}
const login = (username: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })

describe('setup do master', () => {
  it('me devolve setupRequired com 0 usuários', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.json()).toEqual({ setupRequired: true })
  })

  it('setup cria o admin, seta cookie httpOnly/strict e só funciona uma vez', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'root', password: 'abcd' } })
    expect(res.statusCode).toBe(201)
    const raw = res.cookies.find((c: any) => c.name === COOKIE_NAME) as any
    expect(raw.httpOnly).toBe(true)
    expect(String(raw.sameSite).toLowerCase()).toBe('strict')
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: cookieOf(res) })
    expect(me.json()).toMatchObject({ setupRequired: false, username: 'root', isAdmin: true })
    // segunda vez: já configurado → 403
    const again = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'x', password: 'abcd' } })
    expect(again.statusCode).toBe(403)
  })

  it('setup de fora do loopback é recusado (o hook já barra com 403)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'x', password: 'abcd' }, remoteAddress: '10.0.0.9' })
    expect(res.statusCode).toBe(403)
  })
})

describe('login/logout/lockout', () => {
  beforeEach(() => { auth.users.create({ username: 'root', password: 'abcd', isAdmin: true }) })

  it('credencial errada → 401 genérico; certa → cookie', async () => {
    expect((await login('root', 'errada')).statusCode).toBe(401)
    expect((await login('fantasma', 'x')).statusCode).toBe(401)
    const ok = await login('root', 'abcd')
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ username: 'root', isAdmin: true })
    expect(cookieOf(ok)[COOKIE_NAME]).toBeTruthy()
  })

  it('5 falhas → 429 com retryAfterMs', async () => {
    for (let i = 0; i < 5; i++) await login('root', 'errada')
    const res = await login('root', 'abcd') // senha certa, mas trancado
    expect(res.statusCode).toBe(429)
    expect(res.json().retryAfterMs).toBeGreaterThan(0)
  })

  it('logout limpa o cookie', async () => {
    const ok = await login('root', 'abcd')
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: cookieOf(ok) })
    const cleared = out.cookies.find((c: any) => c.name === COOKIE_NAME) as any
    expect(cleared.value).toBe('')
  })
})

describe('troca de senha', () => {
  beforeEach(() => { auth.users.create({ username: 'root', password: 'abcd', isAdmin: true }) })

  it('senha atual errada → 400; certa troca, re-emite cookie e mata o token antigo', async () => {
    const c1 = cookieOf(await login('root', 'abcd'))
    const bad = await app.inject({ method: 'POST', url: '/api/auth/password', cookies: c1, payload: { currentPassword: 'x', newPassword: 'nova1' } })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({ method: 'POST', url: '/api/auth/password', cookies: c1, payload: { currentPassword: 'abcd', newPassword: 'nova1' } })
    expect(ok.statusCode).toBe(200)
    const c2 = cookieOf(ok)
    expect((await app.inject({ method: 'GET', url: '/api/projects', cookies: c1 })).statusCode).toBe(401) // ver antigo
    expect((await app.inject({ method: 'GET', url: '/api/projects', cookies: c2 })).statusCode).toBe(200)
    expect((await login('root', 'nova1')).statusCode).toBe(200)
  })
})

describe('admin: users CRUD + revoke-all', () => {
  let adminCookie: Record<string, string>
  beforeEach(async () => {
    auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
    adminCookie = cookieOf(await login('root', 'abcd'))
  })

  it('CRUD completo com cookie de admin', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/auth/users', cookies: adminCookie, payload: { username: 'ana', password: 'abcd', projectIds: [1] } })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    const list = await app.inject({ method: 'GET', url: '/api/auth/users', cookies: adminCookie })
    expect(list.json().map((u: any) => u.username)).toEqual(['root', 'ana'])
    const patched = await app.inject({ method: 'PATCH', url: `/api/auth/users/${id}`, cookies: adminCookie, payload: { projectIds: [2, 3] } })
    expect(patched.json().projectIds).toEqual([2, 3])
    expect((await app.inject({ method: 'DELETE', url: `/api/auth/users/${id}`, cookies: adminCookie })).statusCode).toBe(204)
  })

  it('não-admin leva 403 no CRUD e no revoke-all', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/users', cookies: adminCookie, payload: { username: 'ana', password: 'abcd' } })
    const anaCookie = cookieOf(await login('ana', 'abcd'))
    expect((await app.inject({ method: 'GET', url: '/api/auth/users', cookies: anaCookie })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/auth/revoke-all', cookies: anaCookie })).statusCode).toBe(403)
  })

  it('excluir o último admin → 400 last_admin', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: adminCookie })
    const res = await app.inject({ method: 'DELETE', url: `/api/auth/users/${me.json().id}`, cookies: adminCookie })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('last_admin')
  })

  it('revoke-all: 204, chama onRevokeAll e o próprio cookie morre', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/revoke-all', cookies: adminCookie })
    expect(res.statusCode).toBe(204)
    expect(onRevokeAll).toHaveBeenCalledOnce()
    expect((await app.inject({ method: 'GET', url: '/api/projects', cookies: adminCookie })).statusCode).toBe(401)
  })

  it('editar um usuário derruba os sockets dele (onUserInvalidated)', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/auth/users', cookies: adminCookie, payload: { username: 'ana', password: 'abcd' } })
    // onUserInvalidated é coberto via spy no buildApp da Task 6 (wsHub.closeUser);
    // aqui só garante que o PATCH funciona sem o callback (opcional).
    const res = await app.inject({ method: 'PATCH', url: `/api/auth/users/${created.json().id}`, cookies: adminCookie, payload: { isAdmin: true } })
    expect(res.statusCode).toBe(200)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/auth-routes.test.ts`
Expected: FAIL — 404 nas rotas `/api/auth/*` (não existem) e `buildApp` não aceita `onRevokeAll`.

- [ ] **Step 3: Implementar `server/src/auth/routes.ts`**

```typescript
// Rotas de autenticação e administração de usuários.
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AuthService } from './index.js'
import { COOKIE_NAME, isLoopbackIp } from './plugin.js'
import { requireAdmin } from './guards.js'
import { verifyPassword } from './passwords.js'

const COOKIE_OPTS = { httpOnly: true, sameSite: 'strict' as const, path: '/', maxAge: 7 * 24 * 3600 }

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
    // resposta idêntica para "user não existe" e "senha errada" — não vaza usernames
    if (!row) return reply.code(401).send({ error: 'invalid_credentials' })
    const lockedMs = auth.users.isLocked(row.id)
    if (lockedMs > 0) return reply.code(429).send({ error: 'locked', retryAfterMs: lockedMs })
    if (!verifyPassword(body.password, row.passwordHash)) {
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
```

- [ ] **Step 4: Wiring no `app.ts`**

Em `AppDeps`, junto do `auth`:

```typescript
  /** Pós revoke-all: derruba todos os WS. */
  onRevokeAll?: () => void
  /** Tokens/permissões de um usuário mudaram: derruba os WS dele. */
  onUserInvalidated?: (userId: number) => void
```

E no `buildApp` (substituindo a linha da Task 3):

```typescript
  if (deps.auth) {
    await registerAuth(app, { auth: deps.auth })
    registerAuthRoutes(app, { auth: deps.auth, onRevokeAll: deps.onRevokeAll, onUserInvalidated: deps.onUserInvalidated })
  }
```

(import: `import { registerAuthRoutes } from './auth/routes.js'`.)

- [ ] **Step 5: Rodar e ver passar**

Run: `cd server && npx vitest run test/auth-routes.test.ts test/auth-plugin.test.ts`
Expected: PASS — inclusive os casos de login da Task 3 que estavam pendentes.

- [ ] **Step 6: Suíte + tsc + commit**

```bash
cd server && npm test && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/auth/routes.ts server/src/app.ts server/test/auth-routes.test.ts
git commit -m "feat(auth): rotas /api/auth (setup loopback-only, login+lockout, me, password, users CRUD, revoke-all)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Enforcement RBAC nas rotas HTTP existentes

**Files:**
- Modify: `server/src/routes/projects.ts` (writes admin-only; GET filtrado)
- Modify: `server/src/routes/sessions.ts` (acesso por projeto; GET filtrado)
- Modify: `server/src/routes/terminal.ts` (POST/DELETE por projeto)
- Modify: `server/src/routes/fs.ts` (admin-only)
- Modify: `server/src/routes/usage.ts` (admin-only)
- Modify: `server/src/routes/hermes.ts` (board filtrado p/ não-admin)
- Modify: `server/src/routes/orchestrator.ts` (tasks filtradas p/ não-admin)
- Modify: `server/src/app.ts` (passar `manager` ao terminal deps se ainda não passa — já passa)
- Test: `server/test/auth-rbac.test.ts`

**Interfaces:**
- Consumes: `requireAdmin`, `requireProjectAccess`, `canAccessProject` de `../auth/guards.js`; `req.authUser` (plugin); `deps.manager.get(localId)` → `{ projectId } | undefined`.
- Produces: nenhum símbolo novo — só guards dentro dos handlers. Regra uniforme para rotas por `localId`: sessão inexistente → 404 `{ error: 'sessão não existe' }` ANTES do guard (não vaza existência? ordem inversa vazaria menos, mas 404-primeiro é o padrão atual do arquivo — manter); sessão de projeto fora da lista → 403 `forbidden_project`.

- [ ] **Step 1: Escrever os testes que falham**

`server/test/auth-rbac.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService
let manager: ReturnType<typeof createSessionManager>
let p1: { id: number }, p2: { id: number }
let adminCookie: Record<string, string>
let anaCookie: Record<string, string>

const cookieOf = (res: any): Record<string, string> => {
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
  return c ? { [COOKIE_NAME]: c.value } : {}
}

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: fakeFactory })
  app = await buildApp({ config: loadConfig({}), db, manager, auth })
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'p1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'p2-')) })
  auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd', projectIds: [p1.id] })
  adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd' } }))
  anaCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd' } }))
})

describe('projetos', () => {
  it('GET filtrado para não-admin; completo para admin', async () => {
    const admin = await app.inject({ method: 'GET', url: '/api/projects', cookies: adminCookie })
    expect(admin.json().map((p: any) => p.name).sort()).toEqual(['Alfa', 'Beta'])
    const ana = await app.inject({ method: 'GET', url: '/api/projects', cookies: anaCookie })
    expect(ana.json().map((p: any) => p.name)).toEqual(['Alfa'])
  })

  it('escrita de projeto é admin-only (403 p/ ana, ok p/ root)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3-'))
    expect((await app.inject({ method: 'POST', url: '/api/projects', cookies: anaCookie, payload: { name: 'X', path: dir } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${p1.id}`, cookies: anaCookie, payload: { name: 'Y' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p2.id}`, cookies: anaCookie })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: '/api/projects/order', cookies: anaCookie, payload: { ids: [p2.id, p1.id] } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/projects', cookies: adminCookie, payload: { name: 'X', path: dir } })).statusCode).toBe(201)
  })
})

describe('sessões', () => {
  it('ana cria sessão no projeto dela, mas não no alheio', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p1.id}/sessions`, cookies: anaCookie, payload: {} })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${p2.id}/sessions`, cookies: anaCookie, payload: {} })).statusCode).toBe(403)
  })

  it('GET /api/sessions filtrado; operações por localId de projeto alheio → 403', async () => {
    const s2 = (await app.inject({ method: 'POST', url: `/api/projects/${p2.id}/sessions`, cookies: adminCookie, payload: {} })).json()
    const list = await app.inject({ method: 'GET', url: '/api/sessions', cookies: anaCookie })
    expect(list.json()).toEqual([])
    for (const [method, url] of [
      ['GET', `/api/sessions/${s2.localId}/history`],
      ['POST', `/api/sessions/${s2.localId}/stop`],
      ['POST', `/api/sessions/${s2.localId}/revive`],
      ['PATCH', `/api/sessions/${s2.localId}/options`],
      ['POST', `/api/sessions/${s2.localId}/terminal`],
      ['DELETE', `/api/sessions/${s2.localId}/terminal`],
    ] as const) {
      const res = await app.inject({ method, url, cookies: anaCookie, ...(method === 'PATCH' ? { payload: {} } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })
})

describe('admin-only diversos', () => {
  it('fs e usage: 403 p/ ana', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/fs/list', cookies: anaCookie })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/usage', cookies: anaCookie })).statusCode).toBe(403)
  })
})

describe('board/tasks filtrados', () => {
  it('não-admin só vê posts/tasks dos projetos dele', async () => {
    await app.inject({ method: 'POST', url: '/api/hermes/board', cookies: adminCookie, payload: { projectId: p1.id, title: 'A', content: 'a' } })
    await app.inject({ method: 'POST', url: '/api/hermes/board', cookies: adminCookie, payload: { projectId: p2.id, title: 'B', content: 'b' } })
    const board = await app.inject({ method: 'GET', url: '/api/hermes/board', cookies: anaCookie })
    expect(board.json().map((p: any) => p.title)).toEqual(['A'])
    const admin = await app.inject({ method: 'GET', url: '/api/hermes/board', cookies: adminCookie })
    expect(admin.json().length).toBe(2)
  })
})
```

Nota: `/api/usage` só existe quando `deps.usage` é passado — incluir no `buildApp` deste teste `usage: { getLimits: async () => ({ limits: [] }) }` se o 403 vier antes do handler (o guard é no handler, então precisa da rota registrada; adicione o stub). O mesmo para o teste de fs (fs sempre registra).

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/auth-rbac.test.ts`
Expected: FAIL — filtros/403 não existem (listas completas, 200/201 onde deveria ser 403).

- [ ] **Step 3: Implementar os guards nas rotas**

`server/src/routes/projects.ts` — import + mudanças:

```typescript
import { canAccessProject, requireAdmin } from '../auth/guards.js'
```

```typescript
  app.get('/api/projects', async (req) =>
    svc.list().filter((p) => canAccessProject(req.authUser, p.id)))
```

Nos handlers `POST /api/projects`, `PUT /api/projects/order`, `PATCH /api/projects/:id`, `DELETE /api/projects/:id`, primeira linha:

```typescript
    if (!requireAdmin(req, reply)) return
```

`server/src/routes/sessions.ts` — import + helper local + mudanças:

```typescript
import { canAccessProject, requireProjectAccess } from '../auth/guards.js'
```

```typescript
  // Resolve a sessão e barra acesso a projeto fora da lista do usuário.
  const guardSession = (req: any, reply: any, localId: string) => {
    const info = deps.manager.get(localId)
    if (!info) { reply.code(404).send({ error: 'sessão não existe' }); return undefined }
    if (!requireProjectAccess(req, reply, info.projectId)) return undefined
    return info
  }
```

- `GET /api/sessions`: `async (req) => deps.manager.list().filter((s) => canAccessProject(req.authUser, s.projectId))`
- `POST /api/projects/:id/sessions`: após o 404 do projeto: `if (!requireProjectAccess(req, reply, project.id)) return`
- `PATCH /api/sessions/:localId/options`, `POST .../stop`, `POST .../revive`: primeira linha `if (!guardSession(req, reply, localId)) return` (no stop/revive extrair `const { localId } = req.params as { localId: string }` antes).
- `GET .../history`: já resolve `info` — adicionar após o 404: `if (!requireProjectAccess(req, reply, info.projectId)) return`

`server/src/routes/terminal.ts` — deps ganham `get`:

```typescript
  manager: Pick<SessionManager, 'openInTerminal' | 'get'>
```

```typescript
import { requireProjectAccess } from '../auth/guards.js'
```

No `POST /api/sessions/:localId/terminal` e no `DELETE`, após extrair `localId`:

```typescript
    const info = deps.manager.get(localId)
    if (!info) return reply.code(404).send({ error: 'sessão não existe' })
    if (!requireProjectAccess(req, reply, info.projectId)) return
```

(Atenção: hoje o DELETE não devolve 404 para sessão inexistente — vira 404; ajustar o teste existente `terminal-routes.test.ts` SE ele cobrir esse caso com sessão inexistente esperando 204.)

`server/src/routes/fs.ts` e `server/src/routes/usage.ts` — em cada handler, primeira linha:

```typescript
    if (!requireAdmin(req, reply)) return
```

(com `import { requireAdmin } from '../auth/guards.js'`; nos handlers sem `req`/`reply` nomeados, nomeá-los.)

`server/src/routes/hermes.ts`:

```typescript
import { canAccessProject } from '../auth/guards.js'
```

- `GET /api/hermes/projects`: filtrar `projects.list().filter((p) => canAccessProject(req.authUser, p.id))` (handler ganha `req`).
- `GET /api/hermes/board`: filtrar o retorno: `return board.list(...).filter((post) => canAccessProject(req.authUser, post.projectId))`.
- `POST /api/hermes/ask`: após resolver `target`: `if (!requireProjectAccess(req, reply, target.id)) return` (import junto).

`server/src/routes/orchestrator.ts`:

- `GET /api/orchestrator/tasks`: filtrar `.filter((t) => canAccessProject(req.authUser, t.toProjectId))`.
- `POST /api/orchestrator/dispatch`: após resolver o projeto destino: `if (!requireProjectAccess(req, reply, target.id)) return` (usar o nome real da variável no arquivo).

- [ ] **Step 4: Rodar e ver passar + regressão**

Run: `cd server && npx vitest run test/auth-rbac.test.ts && npm test`
Expected: PASS novo e suíte inteira verde (testes legados sem `auth` → `req.authUser` undefined → guards liberam).

- [ ] **Step 5: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/routes server/test/auth-rbac.test.ts
git commit -m "feat(auth): RBAC nas rotas — writes/fs/usage admin-only, sessões e board/tasks filtrados por projeto

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: WebSocket — handshake autenticado, broadcast filtrado, revogação derruba sockets

**Files:**
- Modify: `server/src/routes/ws.ts` (hub com user por socket + filtro + closeAll/closeUser)
- Modify: `server/src/routes/terminal.ts` (origin same-host em vez de loopback-only)
- Modify: `server/src/app.ts` / `server/src/index.ts` (ligar onRevokeAll/onUserInvalidated ao hub)
- Test: `server/test/auth-ws.test.ts`; Modify: `server/test/terminal-routes.test.ts` (origin)

**Interfaces:**
- Consumes: `req.authUser`, `canAccessProject`, `manager.get(localId)`, `manager.list()`.
- Produces: `WsHub` ganha `closeAll(): void` e `closeUser(userId: number): void`. `register(app, deps)` inalterado na assinatura. `isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean` exportado de `terminal.ts` (substitui `isLoopbackOrigin` nos usos; loopback continua aceito).
- Regra de filtro do broadcast: evento com `projectId` numérico → visível se `canAccessProject`; senão, com `localId` string → resolve `manager.get(localId)?.projectId`; sem projeto resolvível → só admin (e conexões sem auth). `sessions_snapshot` filtrado igual.

- [ ] **Step 1: Escrever os testes que falham**

`server/test/auth-ws.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createWsHub } from '../src/routes/ws.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService
let hub: ReturnType<typeof createWsHub>
let baseUrl: string
let p1: { id: number }, p2: { id: number }

const loginCookie = async (username: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd' } })
  const c = res.cookies.find((x: any) => x.name === COOKIE_NAME) as any
  return `${COOKIE_NAME}=${c.value}`
}

const openWs = (cookie?: string) =>
  new WebSocket(`${baseUrl}/ws`, cookie ? { headers: { cookie } } : {})

const nextMsg = (ws: WebSocket, ms = 3000): Promise<any> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    ws.once('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())) })
  })

const opened = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  hub = createWsHub()
  const manager = createSessionManager({ db, broadcast: (m) => hub.broadcast(m), sessionFactory: fakeFactory })
  app = await buildApp({
    config: loadConfig({}), db, manager, auth, wsHub: hub,
    onRevokeAll: () => hub.closeAll(), onUserInvalidated: (id) => hub.closeUser(id),
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as { port: number }
  baseUrl = `ws://127.0.0.1:${addr.port}`
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'p1-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'p2-')) })
  auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd', projectIds: [p1.id] })
})

afterEach(async () => { await app.close() })

describe('handshake', () => {
  it('sem cookie → conexão rejeitada (401 no upgrade)', async () => {
    const ws = openWs()
    await expect(opened(ws)).rejects.toThrow()
  })

  it('com cookie → conecta e recebe snapshot filtrado', async () => {
    const ws = openWs(await loginCookie('ana'))
    await opened(ws)
    const snap = await nextMsg(ws)
    expect(snap.type).toBe('sessions_snapshot')
    ws.close()
  })
})

describe('broadcast filtrado', () => {
  it('evento de projeto alheio não chega ao não-admin; chega ao admin', async () => {
    const anaWs = openWs(await loginCookie('ana'))
    const rootWs = openWs(await loginCookie('root'))
    await Promise.all([opened(anaWs), opened(rootWs)])
    await Promise.all([nextMsg(anaWs), nextMsg(rootWs)]) // snapshots
    const rootPromise = nextMsg(rootWs)
    const anaPromise = nextMsg(anaWs, 500)
    hub.broadcast({ type: 'board_post', projectId: p2.id, title: 'secreto' })
    await expect(rootPromise).resolves.toMatchObject({ title: 'secreto' })
    await expect(anaPromise).rejects.toThrow('timeout') // ana não recebe
    anaWs.close(); rootWs.close()
  })

  it('evento sem projeto resolvível é admin-only', async () => {
    const anaWs = openWs(await loginCookie('ana'))
    await opened(anaWs); await nextMsg(anaWs)
    const anaPromise = nextMsg(anaWs, 500)
    hub.broadcast({ type: 'global_thing' })
    await expect(anaPromise).rejects.toThrow('timeout')
    anaWs.close()
  })
})

describe('revogação derruba sockets', () => {
  it('revoke-all fecha todas as conexões', async () => {
    const cookie = await loginCookie('root')
    const ws = openWs(cookie)
    await opened(ws); await nextMsg(ws)
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    await app.inject({ method: 'POST', url: '/api/auth/revoke-all', headers: { cookie } })
    expect(await closed).toBe(1008)
  })

  it('PATCH num usuário fecha só os sockets dele', async () => {
    const rootCookie = await loginCookie('root')
    const anaId = auth.users.getByUsername('ana')!.id
    const anaWs = openWs(await loginCookie('ana'))
    const rootWs = openWs(rootCookie)
    await Promise.all([opened(anaWs), opened(rootWs)])
    await Promise.all([nextMsg(anaWs), nextMsg(rootWs)])
    const anaClosed = new Promise<number>((r) => anaWs.once('close', (code) => r(code)))
    await app.inject({ method: 'PATCH', url: `/api/auth/users/${anaId}`, headers: { cookie: rootCookie }, payload: { projectIds: [] } })
    expect(await anaClosed).toBe(1008)
    expect(rootWs.readyState).toBe(rootWs.OPEN)
    rootWs.close()
  })
})

describe('comandos do WS respeitam RBAC', () => {
  it('send_message em sessão de projeto alheio → erro forbidden', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/projects/${p2.id}/sessions`, headers: { cookie: await loginCookie('root') }, payload: {} })
    const localId = start.json().localId
    const anaWs = openWs(await loginCookie('ana'))
    await opened(anaWs); await nextMsg(anaWs)
    const err = nextMsg(anaWs)
    anaWs.send(JSON.stringify({ type: 'send_message', localId, text: 'oi' }))
    await expect(err).resolves.toMatchObject({ type: 'error', message: 'forbidden' })
    anaWs.close()
  })
})
```

Modify `server/test/terminal-routes.test.ts`: onde houver teste de `isLoopbackOrigin`, trocar pela nova `isAllowedOrigin` com casos:

```typescript
import { isAllowedOrigin } from '../src/routes/terminal.js'

describe('isAllowedOrigin', () => {
  it('loopback sempre passa', () => {
    expect(isAllowedOrigin('http://localhost:9100', '127.0.0.1:9105')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:9105', undefined)).toBe(true)
  })
  it('mesmo host:porta da requisição passa (LAN)', () => {
    expect(isAllowedOrigin('http://192.168.0.10:9105', '192.168.0.10:9105')).toBe(true)
  })
  it('host diferente é bloqueado; origin ausente passa (clientes não-browser)', () => {
    expect(isAllowedOrigin('http://evil.tld', '192.168.0.10:9105')).toBe(false)
    expect(isAllowedOrigin(undefined, 'x')).toBe(true)
    expect(isAllowedOrigin('lixo-não-url', 'x')).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/auth-ws.test.ts`
Expected: FAIL — handshake sem cookie conecta (hook cobre, mas closeAll/closeUser/filtros não existem → TypeError/timeout).

- [ ] **Step 3: Reescrever `server/src/routes/ws.ts`**

```typescript
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { SessionManager } from '../claude/manager.js'
import type { AuthUser } from '../auth/plugin.js'
import { canAccessProject } from '../auth/guards.js'

interface Client {
  ws: WebSocket
  /** undefined = auth desativada (pré-setup): vê tudo, como sempre foi. */
  user?: AuthUser
}

export function createWsHub() {
  const clients = new Set<Client>()
  // O manager chega no register(); broadcast antes disso (não ocorre em produção)
  // cai no comportamento sem filtro por localId.
  let mgr: SessionManager | undefined

  const canSee = (user: AuthUser | undefined, msg: any): boolean => {
    if (!user || user.kind === 'service' || user.isAdmin) return true
    const projectId: number | undefined =
      typeof msg.projectId === 'number'
        ? msg.projectId
        : typeof msg.localId === 'string'
          ? mgr?.get(msg.localId)?.projectId
          : undefined
    // Sem projeto resolvível (ex.: evento global) → admin-only.
    return projectId !== undefined && canAccessProject(user, projectId)
  }

  return {
    broadcast(msg: object): void {
      const data = JSON.stringify(msg)
      for (const c of clients) {
        if (c.ws.readyState === c.ws.OPEN && canSee(c.user, msg)) c.ws.send(data)
      }
    },

    closeAll(): void {
      for (const c of clients) c.ws.close(1008, 'revoked')
    },

    closeUser(userId: number): void {
      for (const c of clients) {
        if (c.user?.kind === 'user' && c.user.id === userId) c.ws.close(1008, 'revoked')
      }
    },

    register(app: FastifyInstance, deps: { manager: SessionManager }): void {
      mgr = deps.manager
      app.get('/ws', { websocket: true }, (socket, req) => {
        // A autenticação aconteceu no hook onRequest (401 aborta o upgrade);
        // aqui só capturamos QUEM conectou para filtrar broadcasts.
        const client: Client = { ws: socket, user: req.authUser }
        clients.add(client)
        const sessions = deps.manager.list().filter((s) =>
          !client.user || client.user.kind !== 'user' || canAccessProject(client.user, s.projectId))
        socket.send(JSON.stringify({ type: 'sessions_snapshot', sessions }))
        socket.on('close', () => clients.delete(client))
        socket.on('message', (data) => {
          let msg: any
          try { msg = JSON.parse(data.toString()) } catch { return }
          const u = client.user
          if (u && u.kind === 'user' && !u.isAdmin) {
            const info = deps.manager.get(msg.localId)
            if (!info || !u.projectIds.includes(info.projectId)) {
              socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: 'forbidden' }))
              return
            }
          }
          try {
            if (msg.type === 'send_message') deps.manager.send(msg.localId, msg.text)
            else if (msg.type === 'mark_read') deps.manager.markRead(msg.localId)
            else if (msg.type === 'interrupt') void deps.manager.interrupt(msg.localId).catch((err) => socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: (err as Error).message })))
          } catch (err) {
            socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: (err as Error).message }))
          }
        })
      })
    },
  }
}

export type WsHub = ReturnType<typeof createWsHub>
```

- [ ] **Step 4: Origin do terminal (`terminal.ts`)**

Substituir `isLoopbackOrigin` por:

```typescript
/**
 * Origin permitido no WS do terminal: loopback (dev/vite) ou o MESMO host:porta
 * da requisição (acesso via LAN autenticado). Bloqueia sites de terceiros
 * tentando cross-site WebSocket hijacking.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) return true
    return host !== undefined && u.host === host
  } catch {
    return false
  }
}
```

E no handler `GET /ws/terminal/:localId`, trocar:

```typescript
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) { socket.close(1008, 'origin'); return }
```

(remover a função e usos antigos de `isLoopbackOrigin`).

- [ ] **Step 5: Wiring do `index.ts`**

No `index.ts` (modo servidor), passar os callbacks ao `buildApp` (o `auth` real entra na Task 7; aqui apenas garantir que quando `auth` existir os callbacks liguem no hub — deixar pronto):

```typescript
    onRevokeAll: () => wsHub.closeAll(),
    onUserInvalidated: (id) => wsHub.closeUser(id),
```

- [ ] **Step 6: Rodar e ver passar + regressão**

Run: `cd server && npx vitest run test/auth-ws.test.ts test/terminal-routes.test.ts test/ws.test.ts && npm test`
Expected: PASS (ws.test.ts legado sem auth continua verde — user undefined vê tudo).

- [ ] **Step 7: tsc + commit**

```bash
cd server && npx tsc --noEmit
cd /home/coppi/Projects/Termaster
git add server/src/routes/ws.ts server/src/routes/terminal.ts server/src/index.ts server/test/auth-ws.test.ts server/test/terminal-routes.test.ts
git commit -m "feat(auth): WS autenticado no handshake, broadcast filtrado por projeto, revogação derruba sockets, origin same-host no terminal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Token de serviço no hermes + wiring final do `index.ts`

**Files:**
- Modify: `server/src/index.ts` (createAuthService real, `authConfigured`, service token)
- Modify: `server/src/claude/manager.ts` (tipo `hermes` ganha `serviceToken?`)
- Modify: `server/src/claude/session.ts` (env `CLAUDINEI_SERVICE_TOKEN` no mcp-config)
- Modify: `server/src/hermes/run-hermes.ts` (`Authorization: Bearer`)
- Test: `server/test/auth-hermes-token.test.ts`; Modify: `server/test/session.test.ts` se asserção de env do mcp-config existir

**Interfaces:**
- Consumes: `createAuthService`, `auth.tokens.signService()`, `assertExposureAllowed`.
- Produces: `runHermes(opts: { api: string; projectId: number; serviceToken?: string })`; `hermes?: { command: string; args: string[]; apiUrl: string; serviceToken?: string }` no manager; env `CLAUDINEI_SERVICE_TOKEN` dentro do `--mcp-config` da sessão.

- [ ] **Step 1: Escrever os testes que falham**

`server/test/auth-hermes-token.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildSessionArgs, type SessionOptions } from '../src/claude/session.js'

// buildSessionArgs é o construtor de argv da sessão; se o nome real do helper
// exportado for outro (ver session.ts), usar o existente — o que importa é o
// conteúdo do --mcp-config.
describe('service token no mcp-config do hermes', () => {
  const base: Partial<SessionOptions> = {
    hermes: { command: '/bin/claudinei', args: ['--hermes'], apiUrl: 'http://127.0.0.1:9105', projectId: 3, serviceToken: 'TOK123' },
  }

  it('injeta CLAUDINEI_SERVICE_TOKEN no env do server MCP', () => {
    const args = buildSessionArgs(base as SessionOptions)
    const mcpIdx = args.indexOf('--mcp-config')
    const cfg = JSON.parse(args[mcpIdx + 1])
    expect(cfg.mcpServers.hermes.env.CLAUDINEI_SERVICE_TOKEN).toBe('TOK123')
    expect(cfg.mcpServers.hermes.env.CLAUDINEI_API).toBe('http://127.0.0.1:9105')
  })

  it('sem serviceToken o env não ganha a chave', () => {
    const args = buildSessionArgs({ ...base, hermes: { ...base.hermes!, serviceToken: undefined } } as SessionOptions)
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    expect('CLAUDINEI_SERVICE_TOKEN' in cfg.mcpServers.hermes.env).toBe(false)
  })
})
```

(Se `session.ts` não exporta o builder de args, exportá-lo — os testes existentes `session.test.ts` mostram o padrão usado; seguir o mecanismo que eles já usam para inspecionar args.)

E o fio de ponta a ponta no HTTP (append em `test/auth-plugin.test.ts` — já coberto pelo caso "bearer de serviço" da Task 3; nada novo aqui).

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd server && npx vitest run test/auth-hermes-token.test.ts`
Expected: FAIL — `serviceToken` não existe no tipo.

- [ ] **Step 3: Implementar**

`server/src/claude/manager.ts` — tipo:

```typescript
  hermes?: { command: string; args: string[]; apiUrl: string; serviceToken?: string }
```

(o spread `{ ...deps.hermes, projectId }` já repassa o campo.)

`server/src/claude/session.ts` — no objeto `env` do mcp-config:

```typescript
          env: {
            CLAUDINEI_API: opts.hermes.apiUrl,
            CLAUDINEI_PROJECT_ID: String(opts.hermes.projectId),
            ...(opts.hermes.serviceToken ? { CLAUDINEI_SERVICE_TOKEN: opts.hermes.serviceToken } : {}),
          },
```

(e o tipo `hermes` da `SessionOptions` ganha `serviceToken?: string`.)

`server/src/hermes/run-hermes.ts`:

```typescript
export async function runHermes(opts: { api: string; projectId: number; serviceToken?: string }): Promise<void> {
  const { api: API, projectId: PROJECT_ID, serviceToken } = opts

  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${API}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
      },
      ...init,
    })
```

(resto igual; atenção: o `...init` não pode sobrescrever os headers — como os callers deste arquivo só passam `method`/`body`, manter como está.)

`server/src/index.ts` — no dispatch `--hermes`:

```typescript
  await runHermes({
    api: process.env.CLAUDINEI_API || 'http://127.0.0.1:9105',
    projectId: Number(process.env.CLAUDINEI_PROJECT_ID || '0'),
    serviceToken: process.env.CLAUDINEI_SERVICE_TOKEN,
  })
```

E no modo servidor (a ordem muda: o guard de exposição passa a rodar DEPOIS do `openDb`, porque precisa saber se há usuários):

```typescript
  const { createAuthService } = await import('./auth/index.js')
  // ... após `const config = loadConfig()` e cálculo de host/port:
  const db = openDb(config.dbPath)
  const auth = createAuthService({ db, secretPath: join(dirname(config.dbPath), 'jwt-secret') })
  try {
    assertExposureAllowed(host, { insecure: !!cli.insecure, authConfigured: auth.configured() })
  } catch (err) {
    console.error(String((err as Error).message))
    process.exit(1)
  }
  const serviceToken = auth.tokens.signService()
```

(import `dirname` de `node:path` junto do `join` existente. Remover o bloco antigo do `assertExposureAllowed` que rodava antes do `openDb`.)

No `createSessionManager`:

```typescript
    hermes: { command: config.hermesCommand, args: config.hermesArgs, apiUrl: config.selfUrl, serviceToken },
```

No `buildApp`:

```typescript
    config, db, manager, wsHub, terminalManager, speech, usage, auth,
    onRevokeAll: () => wsHub.closeAll(),
    onUserInvalidated: (id) => wsHub.closeUser(id),
```

- [ ] **Step 4: Rodar e ver passar + regressão total**

Run: `cd server && npx vitest run test/auth-hermes-token.test.ts test/session.test.ts && npm test && npx tsc --noEmit`
Expected: PASS geral. (`hermes-mode.test.ts` continua verde: sem env de token, `serviceToken` é `undefined` e nada muda.)

- [ ] **Step 5: Commit**

```bash
cd /home/coppi/Projects/Termaster
git add server/src/index.ts server/src/claude server/src/hermes/run-hermes.ts server/test/auth-hermes-token.test.ts
git commit -m "feat(auth): token de serviço JWT no hermes (env no mcp-config + bearer) e authConfigured real no expose-guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — gate de boot (Sign in / Create master) + api + store

**Files:**
- Modify: `web/src/api.ts` (funções de auth + evento global de 401)
- Modify: `web/src/store.ts` (slice de auth)
- Create: `web/src/components/AuthScreen.tsx`
- Modify: `web/src/App.tsx` (gate; efeitos só quando `ready`)
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/pt-BR.ts`, `web/src/i18n/es.ts`
- Test: `web/src/test/auth-screen.test.tsx`, `web/src/test/api-auth.test.ts`

**Interfaces:**
- Consumes: rotas `/api/auth/*` (Task 4). Shape: `Me = { setupRequired: boolean; id?: number; username?: string; isAdmin?: boolean; projectIds?: number[] }`.
- Produces (para a Task 9): `api.ts`: `fetchMe(): Promise<Me>`, `login(username, password): Promise<Me>`, `setupMaster(username, password): Promise<Me>`, `logout(): Promise<void>`, `changePassword(currentPassword, newPassword): Promise<void>`, `fetchUsers(): Promise<AdminUser[]>`, `createUser(input): Promise<AdminUser>`, `updateUser(id, patch): Promise<AdminUser>`, `deleteUser(id): Promise<void>`, `revokeAllSessions(): Promise<void>`; `AdminUser = { id: number; username: string; isAdmin: boolean; projectIds: number[]; createdAt: string }`. Store: `authStatus: 'loading' | 'setup' | 'login' | 'ready'`, `me: Me | null`, `setAuth(status, me?)`. Evento global: `window.dispatchEvent(new Event('claudinei:unauthorized'))` disparado pelo `req()` em 401 fora de `/api/auth/`.

- [ ] **Step 1: Escrever os testes que falham**

`web/src/test/api-auth.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchMe, login } from '../api'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('api de auth', () => {
  it('fetchMe devolve setupRequired', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: true }))
    await expect(fetchMe()).resolves.toEqual({ setupRequired: true })
  })

  it('login POSTa credenciais', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: false, username: 'root' }))
    await login('root', 's')
    expect(spy.mock.calls[0][0]).toBe('/api/auth/login')
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ username: 'root', password: 's' })
  })

  it('401 fora de /api/auth dispara claudinei:unauthorized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'unauthorized' }, 401))
    const handler = vi.fn()
    window.addEventListener('claudinei:unauthorized', handler)
    const { fetchProjects } = await import('../api')
    await expect(fetchProjects()).rejects.toThrow()
    expect(handler).toHaveBeenCalledOnce()
    window.removeEventListener('claudinei:unauthorized', handler)
  })

  it('401 do próprio login NÃO dispara o evento (senão loop)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'invalid_credentials' }, 401))
    const handler = vi.fn()
    window.addEventListener('claudinei:unauthorized', handler)
    await expect(login('root', 'errada')).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
    window.removeEventListener('claudinei:unauthorized', handler)
  })
})
```

`web/src/test/auth-screen.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuthScreen } from '../components/AuthScreen'
import '../i18n'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('AuthScreen', () => {
  it('modo login: submete credenciais e chama onDone com o me', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: false, username: 'root', isAdmin: true }))
    const onDone = vi.fn()
    render(<AuthScreen mode="login" onDone={onDone} />)
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'root' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 's3nha' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ username: 'root' })))
  })

  it('modo setup: exige confirmação igual antes de enviar', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ setupRequired: false, username: 'root' }, 201))
    render(<AuthScreen mode="setup" onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'root' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'abcd' } })
    fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: 'DIFERENTE' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(spy).not.toHaveBeenCalled()
    expect(await screen.findByText(/match/i)).toBeTruthy()
  })

  it('mostra erro de lockout com minutos restantes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'locked', retryAfterMs: 14 * 60_000 }, 429))
    render(<AuthScreen mode="login" onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'root' } })
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/14/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd web && npx vitest run src/test/api-auth.test.ts src/test/auth-screen.test.tsx`
Expected: FAIL — `fetchMe` e `AuthScreen` não existem.

- [ ] **Step 3: Implementar**

`web/src/api.ts` — o `req()` ganha o disparo de 401 (substituir o corpo do if `!res.ok`):

```typescript
async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'Content-Type': 'application/json' } : undefined
  const res = await fetch(url, { headers, ...init })
  if (!res.ok) {
    // Sessão expirada/revogada em qualquer chamada de app → volta à tela de
    // login (o App escuta). As rotas /api/auth tratam o próprio 401 (form).
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('claudinei:unauthorized'))
    }
    const body = await res.json().catch(() => ({ error: res.statusText }))
    const err = new Error(body.error ?? res.statusText) as Error & { status?: number; retryAfterMs?: number }
    err.status = res.status
    if (typeof body.retryAfterMs === 'number') err.retryAfterMs = body.retryAfterMs
    throw err
  }
  return res.status === 204 ? (undefined as T) : res.json()
}
```

E as funções novas (fim do arquivo):

```typescript
export interface Me {
  setupRequired: boolean
  id?: number
  username?: string
  isAdmin?: boolean
  projectIds?: number[]
}
export interface AdminUser { id: number; username: string; isAdmin: boolean; projectIds: number[]; createdAt: string }

export const fetchMe = () => req<Me>('/api/auth/me')
export const login = (username: string, password: string) =>
  req<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
export const setupMaster = (username: string, password: string) =>
  req<Me>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) })
export const logout = () => req<void>('/api/auth/logout', { method: 'POST' })
export const changePassword = (currentPassword: string, newPassword: string) =>
  req<void>('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })
export const fetchUsers = () => req<AdminUser[]>('/api/auth/users')
export const createUser = (input: { username: string; password: string; isAdmin?: boolean; projectIds?: number[] }) =>
  req<AdminUser>('/api/auth/users', { method: 'POST', body: JSON.stringify(input) })
export const updateUser = (id: number, patch: { password?: string; isAdmin?: boolean; projectIds?: number[] }) =>
  req<AdminUser>(`/api/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteUser = (id: number) => req<void>(`/api/auth/users/${id}`, { method: 'DELETE' })
export const revokeAllSessions = () => req<void>('/api/auth/revoke-all', { method: 'POST' })
```

`web/src/store.ts` — no `interface State` e no `create`:

```typescript
  authStatus: 'loading' | 'setup' | 'login' | 'ready'
  me: import('./api').Me | null
  setAuth(status: 'loading' | 'setup' | 'login' | 'ready', me?: import('./api').Me | null): void
```

```typescript
  authStatus: 'loading',
  me: null,
  setAuth: (authStatus, me) => set((s) => ({ authStatus, me: me === undefined ? s.me : me })),
```

`web/src/components/AuthScreen.tsx`:

```tsx
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { login, setupMaster, type Me } from '../api'

/** Tela de login OU de criação do master (1º acesso). Padrão Glass, centrada. */
export function AuthScreen({ mode, onDone }: { mode: 'login' | 'setup'; onDone: (me: Me) => void }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'setup' && password !== confirm) {
      setError(t('auth.passwordsDontMatch'))
      return
    }
    setBusy(true)
    try {
      const me = mode === 'setup' ? await setupMaster(username, password) : await login(username, password)
      onDone(me)
    } catch (err) {
      const e2 = err as Error & { retryAfterMs?: number }
      if (e2.message === 'locked' && e2.retryAfterMs) {
        setError(t('auth.locked', { minutes: Math.ceil(e2.retryAfterMs / 60_000) }))
      } else if (e2.message === 'invalid_credentials') {
        setError(t('auth.invalidCredentials'))
      } else {
        setError(e2.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-card__logo"><span className="sidebar__logo-star">✳</span> Claudinei</div>
        <h1>{mode === 'setup' ? t('auth.setupTitle') : t('auth.signInTitle')}</h1>
        {mode === 'setup' && <p className="auth-card__hint">{t('auth.setupHint')}</p>}
        <label>
          {t('auth.username')}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          {t('auth.password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} />
        </label>
        {mode === 'setup' && (
          <label>
            {t('auth.confirmPassword')}
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {error && <div className="auth-card__error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {mode === 'setup' ? t('auth.createMaster') : t('auth.signIn')}
        </button>
      </form>
    </div>
  )
}
```

`web/src/App.tsx` — gate (substituir o corpo):

```tsx
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { fetchMe, fetchProjects, fetchSlashCommands } from './api'
import { connectWs } from './ws'
import { WsContext } from './wsContext'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './components/Dashboard'
import { ChatView } from './components/ChatView'
import { BoardPanel } from './components/BoardPanel'
import { TasksPanel } from './components/TasksPanel'
import { TerminalView } from './components/TerminalView'
import { AuthScreen } from './components/AuthScreen'
import { initNotifications } from './notifications'

export default function App() {
  const view = useStore((s) => s.view)
  const setProjects = useStore((s) => s.setProjects)
  const authStatus = useStore((s) => s.authStatus)
  const setAuth = useStore((s) => s.setAuth)

  // Gate de boot: /me decide setup (0 usuários) × login × app liberado.
  useEffect(() => {
    fetchMe()
      .then((me) => setAuth(me.setupRequired ? 'setup' : 'ready', me.setupRequired ? null : me))
      .catch(() => setAuth('login'))
  }, [])

  // Sessão expirou/revogada no meio do uso → volta ao login.
  useEffect(() => {
    const onUnauthorized = () => setAuth('login', null)
    window.addEventListener('claudinei:unauthorized', onUnauthorized)
    return () => window.removeEventListener('claudinei:unauthorized', onUnauthorized)
  }, [])

  // O WS é criado DENTRO do efeito (não no inicializador do useState): assim o
  // ciclo mount→cleanup→mount do StrictMode cria→fecha→cria UMA única conexão
  // viva. Criá-lo no useState fazia o cleanup fechar o socket usado para ENVIAR
  // enquanto um socket órfão seguia recebendo — o chat recebia mas não enviava.
  // Só conecta quando autenticado ('ready'): antes disso o handshake levaria 401.
  const [ws, setWs] = useState<ReturnType<typeof connectWs>>()
  useEffect(() => {
    if (authStatus !== 'ready') return
    const client = connectWs((msg) => useStore.getState().applyWsMessage(msg))
    setWs(client)
    return () => { client.close(); setWs(undefined) }
  }, [authStatus])

  useEffect(() => {
    if (authStatus !== 'ready') return
    fetchProjects().then(setProjects).catch(() => {})
    // Pré-carrega a lista de slash commands (persistida no backend) para o
    // autocomplete do chat mostrar tudo já no primeiro `/`, sem esperar a 1ª msg.
    fetchSlashCommands().then((cmds) => useStore.getState().setSlashCommands(cmds)).catch(() => {})
  }, [authStatus])

  useEffect(() => {
    const once = () => { initNotifications(); window.removeEventListener('click', once) }
    window.addEventListener('click', once)
    return () => window.removeEventListener('click', once)
  }, [])

  const totalUnread = useStore((s) => Object.values(s.unread).reduce((a, b) => a + b, 0))
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Claudinei` : 'Claudinei'
  }, [totalUnread])

  if (authStatus === 'loading') return null
  if (authStatus === 'setup' || authStatus === 'login') {
    return <AuthScreen mode={authStatus} onDone={(me) => setAuth('ready', me)} />
  }

  return (
    <WsContext.Provider value={ws ?? null}>
      <div className="app">
        <Sidebar />
        <div className="main">
          {view === 'dashboard' && <Dashboard />}
          {view === 'chat' && <ChatView />}
          {view === 'board' && <BoardPanel />}
          {view === 'tasks' && <TasksPanel />}
          {view === 'terminal' && <TerminalView />}
        </div>
      </div>
    </WsContext.Provider>
  )
}
```

i18n — `web/src/i18n/en.ts` (bloco novo `auth`, mesmo shape traduzido em pt-BR/es):

```typescript
  auth: {
    signInTitle: 'Sign in', signIn: 'Sign in',
    setupTitle: 'Create master account',
    setupHint: 'First access: create the administrator account. This can only be done from this machine (localhost).',
    createMaster: 'Create account',
    username: 'Username', password: 'Password', confirmPassword: 'Confirm password',
    passwordsDontMatch: 'Passwords do not match',
    invalidCredentials: 'Invalid username or password',
    locked: 'Too many attempts. Try again in {{minutes}} min.',
  },
```

pt-BR:

```typescript
  auth: {
    signInTitle: 'Entrar', signIn: 'Entrar',
    setupTitle: 'Criar conta master',
    setupHint: 'Primeiro acesso: crie a conta de administrador. Isso só pode ser feito desta máquina (localhost).',
    createMaster: 'Criar conta',
    username: 'Usuário', password: 'Senha', confirmPassword: 'Confirmar senha',
    passwordsDontMatch: 'As senhas não coincidem',
    invalidCredentials: 'Usuário ou senha inválidos',
    locked: 'Muitas tentativas. Tente de novo em {{minutes}} min.',
  },
```

es:

```typescript
  auth: {
    signInTitle: 'Iniciar sesión', signIn: 'Iniciar sesión',
    setupTitle: 'Crear cuenta maestra',
    setupHint: 'Primer acceso: crea la cuenta de administrador. Solo puede hacerse desde esta máquina (localhost).',
    createMaster: 'Crear cuenta',
    username: 'Usuario', password: 'Contraseña', confirmPassword: 'Confirmar contraseña',
    passwordsDontMatch: 'Las contraseñas no coinciden',
    invalidCredentials: 'Usuario o contraseña inválidos',
    locked: 'Demasiados intentos. Prueba de nuevo en {{minutes}} min.',
  },
```

CSS — append em `web/src/styles.css` (padrão Glass do app):

```css
/* ---- auth ---- */
.auth-screen { display: flex; align-items: center; justify-content: center; height: 100vh; }
.auth-card {
  display: flex; flex-direction: column; gap: 14px; width: 320px; padding: 28px;
  background: var(--panel, rgba(255,255,255,.04)); border: 1px solid var(--border, rgba(255,255,255,.08));
  border-radius: 16px; backdrop-filter: blur(12px);
}
.auth-card__logo { font-size: 18px; font-weight: 600; text-align: center; }
.auth-card h1 { font-size: 15px; margin: 0; text-align: center; font-weight: 500; }
.auth-card__hint { font-size: 12px; opacity: .7; margin: 0; }
.auth-card label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; opacity: .9; }
.auth-card input {
  padding: 9px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(255,255,255,.1));
  background: rgba(0,0,0,.2); color: inherit; font-size: 14px;
}
.auth-card__error { color: #ff7b7b; font-size: 12px; }
.auth-card button[type='submit'] {
  margin-top: 4px; padding: 10px; border-radius: 10px; border: none; cursor: pointer;
  background: var(--accent, #7c5cff); color: #fff; font-size: 14px;
}
.auth-card button[type='submit']:disabled { opacity: .5; cursor: default; }
```

(Antes de estilizar, olhar `styles.css` para os nomes reais das variáveis de tema — usar as existentes no lugar dos fallbacks acima.)

- [ ] **Step 4: Rodar e ver passar + regressão web**

Run: `cd web && npx vitest run src/test/api-auth.test.ts src/test/auth-screen.test.tsx && npm test && npx tsc --noEmit`
Expected: PASS. Atenção: testes existentes que rendem `App` podem depender do estado `ready` — se algum quebrar por `authStatus: 'loading'`, no setup do teste chamar `useStore.setState({ authStatus: 'ready' })` (padrão já usado para outros slices).

- [ ] **Step 5: Commit**

```bash
cd /home/coppi/Projects/Termaster
git add web/src/api.ts web/src/store.ts web/src/components/AuthScreen.tsx web/src/App.tsx web/src/i18n web/src/styles.css web/src/test/api-auth.test.ts web/src/test/auth-screen.test.tsx
git commit -m "feat(auth): gate de boot no SPA — Sign in / Create master, 401 global volta ao login, WS só após auth

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Frontend — menu 👤 (Change password, Manage users, Revoke all, Sign out) + admin-only na UI

**Files:**
- Create: `web/src/components/UserMenu.tsx`
- Create: `web/src/components/ChangePasswordModal.tsx`
- Create: `web/src/components/ManageUsersModal.tsx`
- Modify: `web/src/components/Sidebar.tsx` (menu ao lado do logo; esconder + Terminal/Usage/⚙ p/ não-admin)
- Modify: `web/src/components/Dashboard.tsx` (esconder criação p/ não-admin, se existir botão lá)
- Modify: `web/src/i18n/en.ts`, `pt-BR.ts`, `es.ts`
- Modify: `web/src/styles.css`
- Test: `web/src/test/user-menu.test.tsx`, `web/src/test/manage-users.test.tsx`

**Interfaces:**
- Consumes: `logout`, `changePassword`, `fetchUsers`, `createUser`, `updateUser`, `deleteUser`, `revokeAllSessions`, `Me`/`AdminUser` (Task 8); `useStore` `me`/`setAuth`/`projects`; `ConfirmDialog` existente (`web/src/components/ConfirmDialog.tsx` — ver props reais antes de usar).
- Produces: `<UserMenu />` (autocontido, renderizado no header da sidebar).

- [ ] **Step 1: Escrever os testes que falham**

`web/src/test/user-menu.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UserMenu } from '../components/UserMenu'
import { useStore } from '../store'
import '../i18n'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  useStore.setState({ authStatus: 'ready', me: { setupRequired: false, id: 1, username: 'root', isAdmin: true, projectIds: [] } })
})

describe('UserMenu', () => {
  it('abre com o username e mostra Manage users só para admin', () => {
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /root/i }))
    expect(screen.getByText(/manage users/i)).toBeTruthy()
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false, projectIds: [1] } })
  })

  it('não-admin não vê Manage users', () => {
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false, projectIds: [1] } })
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /ana/i }))
    expect(screen.queryByText(/manage users/i)).toBeNull()
    expect(screen.getByText(/change password/i)).toBeTruthy()
  })

  it('Sign out chama logout e volta ao login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    render(<UserMenu />)
    fireEvent.click(screen.getByRole('button', { name: /root/i }))
    fireEvent.click(screen.getByText(/sign out/i))
    await waitFor(() => expect(useStore.getState().authStatus).toBe('login'))
  })
})
```

`web/src/test/manage-users.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ManageUsersModal } from '../components/ManageUsersModal'
import { useStore } from '../store'
import '../i18n'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('ManageUsersModal', () => {
  it('lista usuários com badge de admin e os terminais', async () => {
    useStore.setState({ projects: [{ id: 1, name: 'Alfa', path: '/a', color: '#fff', icon: '📁' } as any] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([
      { id: 1, username: 'root', isAdmin: true, projectIds: [], createdAt: '' },
      { id: 2, username: 'ana', isAdmin: false, projectIds: [1], createdAt: '' },
    ]))
    render(<ManageUsersModal onClose={vi.fn()} />)
    expect(await screen.findByText('root')).toBeTruthy()
    expect(await screen.findByText('ana')).toBeTruthy()
  })

  it('Revoke all pede confirmação e chama a API', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson([]))                     // fetchUsers
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // revoke
    render(<ManageUsersModal onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke all/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^ok$/i })) // ConfirmDialog usa OK
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/auth/revoke-all', expect.objectContaining({ method: 'POST' })))
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd web && npx vitest run src/test/user-menu.test.tsx src/test/manage-users.test.tsx`
Expected: FAIL — componentes não existem.

- [ ] **Step 3: Implementar**

`web/src/components/UserMenu.tsx` (seguir o padrão de popover-portal já usado pelo ⚙ do card em `Sidebar.tsx` — reusar as classes/estrutura de menu existentes):

```tsx
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { logout } from '../api'
import { ChangePasswordModal } from './ChangePasswordModal'
import { ManageUsersModal } from './ManageUsersModal'

/** Menu 👤 ao lado do logo: Change password, Manage users (admin), Sign out. */
export function UserMenu() {
  const { t } = useTranslation()
  const me = useStore((s) => s.me)
  const setAuth = useStore((s) => s.setAuth)
  const [open, setOpen] = useState(false)
  const [modal, setModal] = useState<'password' | 'users' | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (!me?.username) return null // auth desativada (pré-setup): sem menu

  const signOut = async () => {
    try { await logout() } catch { /* cookie some de qualquer jeito */ }
    setAuth('login', null)
  }

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-menu__btn" onClick={() => setOpen((v) => !v)} title={me.username}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
        </svg>
        <span className="user-menu__name">{me.username}</span>
      </button>
      {open && (
        <div className="user-menu__popover">
          <button onClick={() => { setModal('password'); setOpen(false) }}>{t('auth.changePassword')}</button>
          {me.isAdmin && <button onClick={() => { setModal('users'); setOpen(false) }}>{t('auth.manageUsers')}</button>}
          <button onClick={signOut}>{t('auth.signOut')}</button>
        </div>
      )}
      {modal === 'password' && <ChangePasswordModal onClose={() => setModal(null)} />}
      {modal === 'users' && <ManageUsersModal onClose={() => setModal(null)} />}
    </div>
  )
}
```

`web/src/components/ChangePasswordModal.tsx` (seguir a estrutura de modal existente — ver `NewProjectModal.tsx` para as classes reais de overlay/modal do app e usá-las):

```tsx
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { changePassword } from '../api'

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (next !== confirm) { setError(t('auth.passwordsDontMatch')); return }
    try {
      await changePassword(current, next)
      setDone(true)
      setTimeout(onClose, 900)
    } catch (err) {
      setError((err as Error).message === 'wrong_current_password' ? t('auth.wrongCurrentPassword') : (err as Error).message)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{t('auth.changePassword')}</h2>
        <label>{t('auth.currentPassword')}<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></label>
        <label>{t('auth.newPassword')}<input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label>{t('auth.confirmPassword')}<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {error && <div className="auth-card__error">{error}</div>}
        {done && <div className="auth-card__ok">{t('auth.passwordChanged')}</div>}
        <div className="modal__actions">
          <button type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" disabled={!current || !next}>{t('common.save')}</button>
        </div>
      </form>
    </div>
  )
}
```

`web/src/components/ManageUsersModal.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { createUser, deleteUser, fetchUsers, revokeAllSessions, updateUser, type AdminUser } from '../api'
import { ConfirmDialog } from './ConfirmDialog'

interface Draft { id?: number; username: string; password: string; isAdmin: boolean; projectIds: number[] }
const EMPTY: Draft = { username: '', password: '', isAdmin: false, projectIds: [] }

export function ManageUsersModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const projects = useStore((s) => s.projects)
  const setAuth = useStore((s) => s.setAuth)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirm, setConfirm] = useState<'revoke' | AdminUser | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = () => fetchUsers().then(setUsers).catch((e) => setError(e.message))
  useEffect(() => { reload() }, [])

  const save = async () => {
    if (!draft) return
    setError(null)
    try {
      if (draft.id) {
        await updateUser(draft.id, {
          ...(draft.password ? { password: draft.password } : {}),
          isAdmin: draft.isAdmin, projectIds: draft.projectIds,
        })
      } else {
        await createUser(draft)
      }
      setDraft(null); reload()
    } catch (e) { setError((e as Error).message) }
  }

  const toggleProject = (pid: number) =>
    setDraft((d) => d && ({ ...d, projectIds: d.projectIds.includes(pid) ? d.projectIds.filter((x) => x !== pid) : [...d.projectIds, pid] }))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <h2>{t('auth.manageUsers')}</h2>
        <ul className="users-list">
          {users.map((u) => (
            <li key={u.id}>
              <span className="users-list__name">{u.username}</span>
              {u.isAdmin
                ? <span className="users-list__badge">{t('auth.adminBadge')}</span>
                : <span className="users-list__projects">{u.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? `#${id}`).join(', ') || t('auth.noTerminals')}</span>}
              <span className="users-list__actions">
                <button onClick={() => setDraft({ id: u.id, username: u.username, password: '', isAdmin: u.isAdmin, projectIds: u.projectIds })}>{t('common.edit')}</button>
                <button onClick={() => setConfirm(u)}>{t('common.delete')}</button>
              </span>
            </li>
          ))}
        </ul>
        {draft ? (
          <div className="users-form">
            {!draft.id && <label>{t('auth.username')}<input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></label>}
            <label>{draft.id ? t('auth.newPasswordOptional') : t('auth.password')}
              <input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </label>
            <label className="users-form__check">
              <input type="checkbox" checked={draft.isAdmin} onChange={(e) => setDraft({ ...draft, isAdmin: e.target.checked })} />
              {t('auth.adminBadge')}
            </label>
            {!draft.isAdmin && (
              <fieldset className="users-form__projects">
                <legend>{t('auth.allowedTerminals')}</legend>
                {projects.map((p) => (
                  <label key={p.id}><input type="checkbox" checked={draft.projectIds.includes(p.id)} onChange={() => toggleProject(p.id)} /> {p.name}</label>
                ))}
              </fieldset>
            )}
            <div className="modal__actions">
              <button onClick={() => setDraft(null)}>{t('common.cancel')}</button>
              <button onClick={save} disabled={(!draft.id && (!draft.username || !draft.password))}>{t('common.save')}</button>
            </div>
          </div>
        ) : (
          <button className="users-add" onClick={() => setDraft(EMPTY)}>{t('auth.addUser')}</button>
        )}
        {error && <div className="auth-card__error">{error}</div>}
        <div className="modal__actions modal__actions--split">
          <button className="users-revoke" onClick={() => setConfirm('revoke')}>{t('auth.revokeAll')}</button>
          <button onClick={onClose}>{t('common.ok')}</button>
        </div>
      </div>
      {confirm === 'revoke' && (
        <ConfirmDialog
          title={t('auth.revokeAll')}
          message={t('auth.revokeAllConfirm')}
          onConfirm={async () => { await revokeAllSessions().catch(() => {}); setAuth('login', null) }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm && confirm !== 'revoke' && (
        <ConfirmDialog
          title={t('auth.deleteUser', { name: confirm.username })}
          message={t('auth.deleteUserConfirm')}
          onConfirm={async () => { await deleteUser(confirm.id).catch((e) => setError(e.message)); setConfirm(null); reload() }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
```

(**Ver as props reais de `ConfirmDialog.tsx`** antes — se o nome/formato for outro, adaptar mantendo a UX: confirmação antes de revoke/delete.)

`web/src/components/Sidebar.tsx`:
- Header: renderizar `<UserMenu />` entre o logo e o `<LanguageSwitcher />`.
- `const me = useStore((s) => s.me)` e `const isAdmin = !me || me.isAdmin !== false` (sem auth = tudo liberado).
- Esconder quando `!isAdmin`: botão "+ Terminal", `<UsageCard />`, e o ⚙ (editar/excluir) dos cards de terminal.

`web/src/components/Dashboard.tsx`: se houver botão de criar projeto, envolver com o mesmo `isAdmin`.

i18n — append no bloco `auth` (en; traduzir igual em pt-BR/es):

```typescript
    changePassword: 'Change password', manageUsers: 'Manage users', signOut: 'Sign out',
    currentPassword: 'Current password', newPassword: 'New password',
    newPasswordOptional: 'New password (leave empty to keep)',
    wrongCurrentPassword: 'Current password is wrong', passwordChanged: 'Password changed',
    addUser: '+ User', adminBadge: 'admin', allowedTerminals: 'Allowed terminals',
    noTerminals: 'no terminals', deleteUser: 'Delete {{name}}?',
    deleteUserConfirm: 'The user loses access immediately.',
    revokeAll: 'Revoke all sessions',
    revokeAllConfirm: 'Every signed-in browser (including this one) will need to sign in again.',
```

pt-BR:

```typescript
    changePassword: 'Trocar senha', manageUsers: 'Gerenciar usuários', signOut: 'Sair',
    currentPassword: 'Senha atual', newPassword: 'Nova senha',
    newPasswordOptional: 'Nova senha (vazio mantém a atual)',
    wrongCurrentPassword: 'A senha atual está errada', passwordChanged: 'Senha alterada',
    addUser: '+ Usuário', adminBadge: 'admin', allowedTerminals: 'Terminais permitidos',
    noTerminals: 'nenhum terminal', deleteUser: 'Excluir {{name}}?',
    deleteUserConfirm: 'O usuário perde o acesso imediatamente.',
    revokeAll: 'Revogar todas as sessões',
    revokeAllConfirm: 'Todos os navegadores logados (inclusive este) terão que entrar de novo.',
```

es:

```typescript
    changePassword: 'Cambiar contraseña', manageUsers: 'Gestionar usuarios', signOut: 'Salir',
    currentPassword: 'Contraseña actual', newPassword: 'Nueva contraseña',
    newPasswordOptional: 'Nueva contraseña (vacío mantiene la actual)',
    wrongCurrentPassword: 'La contraseña actual es incorrecta', passwordChanged: 'Contraseña cambiada',
    addUser: '+ Usuario', adminBadge: 'admin', allowedTerminals: 'Terminales permitidos',
    noTerminals: 'sin terminales', deleteUser: '¿Eliminar {{name}}?',
    deleteUserConfirm: 'El usuario pierde el acceso inmediatamente.',
    revokeAll: 'Revocar todas las sesiones',
    revokeAllConfirm: 'Todos los navegadores conectados (incluido este) deberán iniciar sesión de nuevo.',
```

CSS — append em `web/src/styles.css` (alinhar com as classes reais do header):

```css
.user-menu { position: relative; }
.user-menu__btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px;
  border: none; background: transparent; color: inherit; cursor: pointer; font-size: 12px; opacity: .85;
}
.user-menu__btn:hover { background: rgba(255,255,255,.06); opacity: 1; }
.user-menu__name { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-menu__popover {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 50; min-width: 170px;
  display: flex; flex-direction: column; padding: 6px; border-radius: 10px;
  background: var(--panel, #1d1d2b); border: 1px solid var(--border, rgba(255,255,255,.08));
  box-shadow: 0 8px 30px rgba(0,0,0,.4);
}
.user-menu__popover button {
  text-align: left; padding: 8px 10px; border: none; background: transparent; color: inherit;
  border-radius: 6px; cursor: pointer; font-size: 13px;
}
.user-menu__popover button:hover { background: rgba(255,255,255,.07); }
.users-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.users-list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: rgba(255,255,255,.03); }
.users-list__badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--accent, #7c5cff); color: #fff; }
.users-list__projects { font-size: 11px; opacity: .6; flex: 1; }
.users-list__name { font-weight: 500; }
.users-list__actions { margin-left: auto; display: flex; gap: 4px; }
.users-form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
.users-form__projects { display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border, rgba(255,255,255,.08)); border-radius: 8px; padding: 8px; }
.users-revoke { color: #ff7b7b; }
.modal__actions--split { justify-content: space-between; }
```

- [ ] **Step 4: Rodar e ver passar + regressão web**

Run: `cd web && npx vitest run src/test/user-menu.test.tsx src/test/manage-users.test.tsx && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/coppi/Projects/Termaster
git add web/src/components web/src/i18n web/src/styles.css web/src/test/user-menu.test.tsx web/src/test/manage-users.test.tsx
git commit -m "feat(auth): menu de usuário (trocar senha, gerenciar usuários, revoke all, sair) e UI admin-only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: README + build de produção

**Files:**
- Modify: `README.md` (seção "Multi-user authentication" + atualizar a menção ao `--insecure`)
- Verify: `npm run build -w web` e suítes completas

- [ ] **Step 1: Escrever a seção no README (em inglês, como o resto)**

Inserir uma seção `## Multi-user authentication` após a seção de execução/exposição existente cobrindo:
- Primeiro acesso via `http://127.0.0.1:9105` → tela **Create master account** (só funciona de localhost).
- Depois disso todo acesso (inclusive localhost) exige login; cookie dura 7 dias.
- Expor na rede: `--host 0.0.0.0` agora funciona **sem** `--insecure` quando há usuários; `--insecure` continua existindo para pular auth conscientemente.
- Admin: menu 👤 → Manage users (per-terminal access, admin flag), Revoke all sessions; lockout automático (5 tentativas → 15 min).
- Senha esquecida do master: parar o servidor e rodar `sqlite3 ~/.claudinei/claudinei.db "DELETE FROM users;"` → o próximo acesso via localhost refaz o setup.
- Aviso: sem TLS a senha viaja em claro na LAN — para exposição séria, usar um reverse proxy com HTTPS (fora do escopo do app).

- [ ] **Step 2: Verificação final**

```bash
cd /home/coppi/Projects/Termaster/server && npm test && npx tsc --noEmit
cd ../web && npm test && npx tsc --noEmit && npm run build
```

Expected: tudo verde; build de produção ok.

- [ ] **Step 3: Commit**

```bash
cd /home/coppi/Projects/Termaster
git add README.md
git commit -m "docs: seção de autenticação multi-usuário no README (setup master, expor sem --insecure, reset)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Smoke real (fora do plano, máquina do usuário)

1. `npm start` → localhost mostra **Create master account**; criar e navegar normal.
2. Reiniciar o servidor: continua logado (cookie + segredo persistido).
3. `--host 0.0.0.0` SEM `--insecure`: sobe (auth configurada); de outro dispositivo, login funciona; usuário não-admin vê só os terminais permitidos e não vê +Terminal/Usage/fs.
4. Errar a senha 5× → mensagem de lockout com minutos.
5. Revoke all → todos os navegadores voltam ao login.
6. Voz (🎤) e hermes (Board/Tasks/ask_agent) continuam funcionando com auth ativa (token de serviço).
7. `npm run package` → binário continua subindo e o hermes empacotado funciona autenticado.
