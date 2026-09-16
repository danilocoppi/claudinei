import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { createAuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createProjectsService } from '../src/projects.js'
import { loadConfig } from '../src/config.js'

let dir: string, now: number, userId: number, projectId: number
let db: ReturnType<typeof openDb>, auth: ReturnType<typeof createAuthService>, app: Awaited<ReturnType<typeof buildApp>>
const policy = { timeZone: 'UTC', windows: [{ days: [1], start: '09:00', end: '10:00' }] }
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'access-preview-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Private preview</title>')
  writeFileSync(join(dir, 'style.css'), 'body { color: red; }')
  now = Date.parse('2026-09-07T09:59:58Z')
  db = openDb(':memory:'); auth = createAuthService({ db, now: () => now })
  projectId = createProjectsService(db).create({ name: 'Allowed', path: dir }).id
  auth.users.create({ username: 'admin', password: 'password1', isAdmin: true })
  userId = auth.users.create({ username: 'limited', password: 'password1', projectIds: [projectId], accessHours: policy }).id
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager, auth })
})
afterEach(async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('preview capabilities keep the issuing user access restrictions', () => {
  it.each(['cutoff', 'policy change', 'token revocation', 'user deletion'])('denies existing cookie-free HTML and subresources after %s', async reason => {
    const issued = await app.inject({ method: 'POST', url: '/api/files/preview',
      cookies: { [COOKIE_NAME]: auth.tokens.signUser(userId, auth.users.tokenVersion(userId)!) },
      payload: { path: 'index.html', projectId } })
    expect(issued.statusCode).toBe(200)
    const url = issued.json().url as string, css = url.replace(/index\.html$/, 'style.css')
    // A sandbox iframe sends no cookie. The grant must remember its issuer.
    expect((await app.inject({ url })).statusCode).toBe(200)
    expect((await app.inject({ url: css })).statusCode).toBe(200)
    if (reason === 'cutoff') now = Date.parse('2026-09-07T10:00:00Z')
    else if (reason === 'policy change') auth.users.update(userId, { accessHours: { ...policy, windows: [{ days: [2], start: '09:00', end: '10:00' }] } })
    else if (reason === 'token revocation') auth.users.bumpTokenVersion(userId)
    else auth.users.remove(userId)
    expect((await app.inject({ url })).statusCode).toBe(404)
    expect((await app.inject({ url: css })).statusCode).toBe(404)
  })
})
