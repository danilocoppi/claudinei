import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createUsersService } from '../src/auth/users.js'
import { verifyPassword } from '../src/auth/passwords.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db
let p1: Project
let p2: Project
let p3: Project
beforeEach(() => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'P1', path: mkdtempSync(join(tmpdir(), 'claudinei-auth-p1-')) })
  p2 = projects.create({ name: 'P2', path: mkdtempSync(join(tmpdir(), 'claudinei-auth-p2-')) })
  p3 = projects.create({ name: 'P3', path: mkdtempSync(join(tmpdir(), 'claudinei-auth-p3-')) })
})

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
    expect(() => svc.create({ username: 'ana', password: 'abcd' })).toThrow('username_taken')
    expect(() => svc.create({ username: 'bia', password: 'abc' })).toThrow('password_too_short')
    expect(() => svc.create({ username: '  ', password: 'abcd' })).toThrow('username_required')
  })

  it('update troca projetos, admin e senha (senha bumpa tokenVersion)', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    const u = svc.create({ username: 'ana', password: 'abcd', projectIds: [p1.id, p2.id] })
    expect(svc.get(u.id)?.projectIds).toEqual([p1.id, p2.id])
    svc.update(u.id, { projectIds: [p3.id], isAdmin: false })
    expect(svc.get(u.id)?.projectIds).toEqual([p3.id])
    svc.update(u.id, { password: 'nova!' })
    expect(verifyPassword('nova!', svc.getByUsername('ana')!.passwordHash)).toBe(true)
    expect(svc.tokenVersion(u.id)).toBe(1)
  })

  it('remove apaga user e vínculos', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    const u = svc.create({ username: 'ana', password: 'abcd', projectIds: [p1.id] })
    svc.remove(u.id)
    expect(svc.get(u.id)).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) c FROM user_projects').get() as any).c).toBe(0)
  })

  it('apagar o projeto remove o vínculo em user_projects (FK CASCADE) e projectIds do usuário zera', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    const u = svc.create({ username: 'ana', password: 'abcd', projectIds: [p1.id] })
    expect(svc.get(u.id)?.projectIds).toEqual([p1.id])
    db.prepare('DELETE FROM projects WHERE id=?').run(p1.id)
    expect((db.prepare('SELECT COUNT(*) c FROM user_projects').get() as any).c).toBe(0)
    expect(svc.get(u.id)?.projectIds).toEqual([])
  })

  it('projectId inexistente na criação viola FK e lança', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    expect(() => svc.create({ username: 'x', password: 'abcd', projectIds: [9999] })).toThrow()
  })

  it('remove de id inexistente lança user_not_found', () => {
    const svc = createUsersService(db)
    svc.create({ username: 'root', password: 'abcd', isAdmin: true })
    expect(() => svc.remove(999999)).toThrow('user_not_found')
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
