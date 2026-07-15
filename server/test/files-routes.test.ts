import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: Awaited<ReturnType<typeof buildApp>>
let projectId: number
let projectPath: string

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  projectPath = mkdtempSync(join(tmpdir(), 'files-routes-'))
  mkdirSync(join(projectPath, 'sub'))
  writeFileSync(join(projectPath, 'a.txt'), 'conteúdo')
  writeFileSync(join(projectPath, 'sub', 'b.md'), '# oi')
  // PNG mínimo válido (assinatura de 8 bytes) — suficiente pra checar content-type/stream.
  writeFileSync(join(projectPath, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  writeFileSync(join(projectPath, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'x'))
  // SVG com <script> — não pode executar na origem do app (XSS).
  writeFileSync(join(projectPath, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>')
  projectId = createProjectsService(db).create({ name: 'P', path: projectPath }).id
})

describe('POST /api/files/resolve', () => {
  it('path relativo dentro do projeto resolve com inScope:true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/files/resolve',
      payload: { paths: ['a.txt', 'sub/b.md'], projectId },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ path: 'a.txt', exists: true, inScope: true, kind: 'text' })
    // `real` (realpath absoluto no servidor) NUNCA vai pro cliente — vazaria layout
    // de diretório/username. Fica só server-side (a rota content usa internamente).
    expect(body[0].real).toBeUndefined()
    expect(body[1]).toMatchObject({ path: 'sub/b.md', exists: true, inScope: true, kind: 'markdown' })
  })

  it('path relativo sem projeto não resolve (fora de escopo)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/files/resolve',
      payload: { paths: ['a.txt'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual([{ path: 'a.txt', exists: false, inScope: false }])
  })

  it('array vazio retorna []', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/files/resolve',
      payload: { paths: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('projectId inexistente: project vira null, só absolutos resolvem (admin local)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/files/resolve',
      payload: { paths: ['a.txt', join(projectPath, 'a.txt')], projectId: 999999 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0]).toMatchObject({ path: 'a.txt', exists: false, inScope: false })
    expect(body[1]).toMatchObject({ path: join(projectPath, 'a.txt'), exists: true, inScope: true })
  })
})

describe('GET /api/files/content', () => {
  it('texto dentro do projeto → 200, corpo e content-type text/plain', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/content?path=a.txt&projectId=${projectId}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.body).toBe('conteúdo')
  })

  it('imagem .png → 200 e content-type image/png', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/content?path=pic.png&projectId=${projectId}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-disposition']).toContain('inline')
    expect(res.headers['content-disposition']).toContain('pic.png')
  })

  it('inexistente → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/content?path=nao-existe.txt&projectId=${projectId}`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('texto acima do teto (2MB) → 413', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/content?path=big.txt&projectId=${projectId}`,
    })
    expect(res.statusCode).toBe(413)
  })

  it('sem path → 400', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/files/content?projectId=${projectId}` })
    expect(res.statusCode).toBe(400)
  })

  it('SVG servido com headers anti-XSS (nosniff + CSP sandbox)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/files/content?path=evil.svg&projectId=${projectId}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain('sandbox')
  })

  it('texto servido com nosniff (não é re-interpretado como HTML)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/files/content?path=a.txt&projectId=${projectId}` })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain('sandbox')
  })
})

describe('GET /api/files/content — fora de escopo (RBAC)', () => {
  let authApp: Awaited<ReturnType<typeof buildApp>>
  let authDb: Db
  let auth: AuthService
  let anaProjectId: number
  let outsideFile: string
  let anaCookie: Record<string, string>

  const cookieOf = (res: any): Record<string, string> => {
    const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
    return c ? { [COOKIE_NAME]: c.value } : {}
  }

  beforeEach(async () => {
    authDb = openDb(':memory:')
    auth = createAuthService({ db: authDb })
    const manager = createSessionManager({ db: authDb, broadcast: () => {} })
    authApp = await buildApp({ config: loadConfig({}), db: authDb, manager, auth })
    const projects = createProjectsService(authDb)
    // projeto ao qual "ana" TEM acesso — mas ela vai pedir um path absoluto que
    // aponta pra FORA dele, o que deve ser barrado mesmo com projectId válido.
    const anaPath = mkdtempSync(join(tmpdir(), 'files-routes-ana-'))
    anaProjectId = projects.create({ name: 'Ana', path: anaPath }).id
    const outsideDir = mkdtempSync(join(tmpdir(), 'files-routes-outside-'))
    outsideFile = join(outsideDir, 'segredo.txt')
    writeFileSync(outsideFile, 'top secret')
    auth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd', projectIds: [anaProjectId] })
    anaCookie = cookieOf(await authApp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd' } }))
  })

  it('não-admin com path absoluto fora da raiz do projeto → 403 (mesmo com projectId válido)', async () => {
    const res = await authApp.inject({
      method: 'GET',
      url: `/api/files/content?path=${encodeURIComponent(outsideFile)}&projectId=${anaProjectId}`,
      cookies: anaCookie,
    })
    expect(res.statusCode).toBe(403)
  })
})
