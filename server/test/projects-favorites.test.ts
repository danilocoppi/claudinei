import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createAuthService } from '../src/auth/index.js'
import { createSessionManager } from '../src/claude/manager.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'

let db: Db
let app: Awaited<ReturnType<typeof buildApp>>
let ownId: number
let otherId: number

const login = async (username: string) => {
  const result = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } })
  expect(result.statusCode).toBe(200)
  const cookie = result.cookies.find((c) => c.name === COOKIE_NAME)
  return { [COOKIE_NAME]: cookie!.value }
}

beforeEach(async () => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  ownId = projects.create({ name: 'A', path: mkdtempSync(join(tmpdir(), 'fav-')) }).id
  otherId = projects.create({ name: 'B', path: mkdtempSync(join(tmpdir(), 'fav-')) }).id
  const auth = createAuthService({ db })
  auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [ownId] })
  app = await buildApp({ config: loadConfig({}), db, manager: createSessionManager({ db, broadcast: () => {} }), auth })
})

afterEach(async () => { await app.close(); db.close() })

describe('favoritos de terminais', () => {
  it('a ⭐ fixa e desafixa só para quem clicou; a coluna global não muda', async () => {
    const ana = await login('ana')
    const root = await login('root')
    const mark = await app.inject({ method: 'PATCH', url: `/api/projects/${ownId}/favorite`, payload: { favorite: true }, cookies: ana })
    expect(mark.statusCode).toBe(200)
    expect(mark.json()).toMatchObject({ id: ownId, favorite: true })
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: ana })).json()).toMatchObject([{ projectId: ownId, pinned: true }])
    // O admin tem a sua própria triagem: a ⭐ de ana não aparece para ele.
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: root })).json()).toEqual([])
    expect(createProjectsService(db).get(ownId)?.favorite).toBe(false)
    const clear = await app.inject({ method: 'PATCH', url: `/api/projects/${ownId}/favorite`, payload: { favorite: false }, cookies: ana })
    expect(clear.json().favorite).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: ana })).json()).toEqual([])
  })

  it('rejeita terminal fora do acesso, valor inválido e id inexistente', async () => {
    const ana = await login('ana')
    const root = await login('root')
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${otherId}/favorite`, payload: { favorite: true }, cookies: ana })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${ownId}/favorite`, payload: { favorite: 'sim' }, cookies: ana })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/api/projects/99999/favorite', payload: { favorite: true }, cookies: root })).statusCode).toBe(404)
    expect(createProjectsService(db).get(otherId)?.favorite).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/triage', cookies: ana })).json()).toEqual([])
  })
})
