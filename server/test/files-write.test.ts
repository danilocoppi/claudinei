import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { hashContent } from '../src/files/hash.js'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: Awaited<ReturnType<typeof buildApp>>
let projectId: number
let projectPath: string
let foraPath: string

const hashDe = (arquivo: string) => hashContent(readFileSync(arquivo))

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  projectPath = mkdtempSync(join(tmpdir(), 'files-write-'))
  writeFileSync(join(projectPath, 'doc.md'), '# antes\n')
  foraPath = mkdtempSync(join(tmpdir(), 'files-write-fora-'))
  writeFileSync(join(foraPath, 'segredo.txt'), 'não me toque')
  projectId = createProjectsService(db).create({ name: 'P', path: projectPath }).id
})

describe('POST /api/files/write — grava dentro do projeto', () => {
  it('grava o conteúdo enviado e o disco reflete', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: '# depois\n\ntexto novo\n', baseHash: hashDe(join(projectPath, 'doc.md')) },
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(join(projectPath, 'doc.md'), 'utf8')).toBe('# depois\n\ntexto novo\n')
  })

  it('sem projectId → 403 e nada é gravado', async () => {
    const alvo = join(projectPath, 'doc.md')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: alvo, content: 'invadido', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(alvo, 'utf8')).toBe('# antes\n')
  })

  it('caminho absoluto FORA do projeto → 403 mesmo como admin local', async () => {
    const alvo = join(foraPath, 'segredo.txt')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: alvo, projectId, content: 'invadido', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(alvo, 'utf8')).toBe('não me toque')
  })

  it('symlink dentro do projeto apontando pra fora → 403', async () => {
    const alvo = join(foraPath, 'segredo.txt')
    symlinkSync(alvo, join(projectPath, 'atalho.txt'))
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'atalho.txt', projectId, content: 'invadido', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(alvo, 'utf8')).toBe('não me toque')
  })
})

describe('POST /api/files/write — RBAC', () => {
  it('usuário sem acesso ao projeto → 403 e nada é gravado', async () => {
    const authDb: Db = openDb(':memory:')
    const auth: AuthService = createAuthService({ db: authDb })
    const manager = createSessionManager({ db: authDb, broadcast: () => {} })
    const authApp = await buildApp({ config: loadConfig({}), db: authDb, manager, auth })
    const projects = createProjectsService(authDb)
    const alheio = mkdtempSync(join(tmpdir(), 'files-write-alheio-'))
    writeFileSync(join(alheio, 'doc.md'), '# alheio\n')
    const alheioId = projects.create({ name: 'Alheio', path: alheio }).id
    const dela = mkdtempSync(join(tmpdir(), 'files-write-dela-'))
    const delaId = projects.create({ name: 'Dela', path: dela }).id
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [delaId] })
    const login = await authApp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } })
    const c = login.cookies.find((x: { name: string; value: string }) => x.name === COOKIE_NAME)
    const res = await authApp.inject({
      method: 'POST', url: '/api/files/write',
      cookies: c ? { [COOKIE_NAME]: c.value } : {},
      payload: { path: 'doc.md', projectId: alheioId, content: 'invadido', baseHash: hashDe(join(alheio, 'doc.md')) },
    })
    expect(res.statusCode).toBe(403)
    expect(readFileSync(join(alheio, 'doc.md'), 'utf8')).toBe('# alheio\n')
  })
})
