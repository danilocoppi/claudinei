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

  it('username inexistente e senha errada devolvem o mesmo status+corpo (não vaza enumeração)', async () => {
    const ghost = await login('fantasma', 'qualquer')
    const wrongPass = await login('root', 'errada')
    expect(ghost.statusCode).toBe(401)
    expect(wrongPass.statusCode).toBe(401)
    expect(ghost.json()).toEqual({ error: 'invalid_credentials' })
    expect(ghost.json()).toEqual(wrongPass.json())
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
    // projectIds referenciam projects(id) via FK (ON DELETE CASCADE, foreign_keys=ON) —
    // precisa existir a linha ou o INSERT em user_projects estoura constraint.
    const ins = db.prepare(`INSERT INTO projects (id, name, path) VALUES (?, ?, ?)`)
    ins.run(1, 'p1', '/tmp/p1')
    ins.run(2, 'p2', '/tmp/p2')
    ins.run(3, 'p3', '/tmp/p3')
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

  it('excluir id inexistente → 400 user_not_found', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/auth/users/999999', cookies: adminCookie })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('user_not_found')
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
