import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'
import { createProjectsService } from '../src/projects.js'
import { hashContent } from '../src/files/hash.js'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, chmodSync, statSync, readdirSync } from 'node:fs'
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

describe('POST /api/files/write — recusas', () => {
  it('arquivo inexistente → 404 (a rota não cria arquivo)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'novo.md', projectId, content: 'oi', baseHash: hashContent('') },
    })
    expect(res.statusCode).toBe(404)
  })

  it('arquivo binário → 415 e nada é gravado', async () => {
    const png = join(projectPath, 'pic.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(png, bytes)
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'pic.png', projectId, content: 'texto', baseHash: hashDe(png) },
    })
    expect(res.statusCode).toBe(415)
    expect(readFileSync(png)).toEqual(bytes)
  })

  it('conteúdo acima do teto de 2 MB → 413 nosso (não o genérico do Fastify) e nada é gravado', async () => {
    const alvo = join(projectPath, 'doc.md')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'x'.repeat(2 * 1024 * 1024 + 1), baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ error: 'too_large' })
    expect(readFileSync(alvo, 'utf8')).toBe('# antes\n')
  })

  // O limite de corpo padrão do Fastify é 1 MiB: sem afrouxá-lo nesta rota, um
  // documento que a LEITURA entrega (teto de 2 MB) não poderia ser salvo de
  // volta, e o operador veria só um erro sem explicação.
  it('arquivo grande, mas dentro do teto de leitura, é gravado', async () => {
    const alvo = join(projectPath, 'doc.md')
    const grande = 'x'.repeat(1_500_000)
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: grande, baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(alvo, 'utf8')).toBe(grande)
  })
})

describe('POST /api/files/write — o agente mexeu no arquivo', () => {
  it('baseHash velho → 409 e o arquivo continua como o agente deixou', async () => {
    const alvo = join(projectPath, 'doc.md')
    const velho = hashDe(alvo)
    writeFileSync(alvo, '# o agente reescreveu\n')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: '# minha versão\n', baseHash: velho },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'stale' })
    expect(readFileSync(alvo, 'utf8')).toBe('# o agente reescreveu\n')
  })

  it('o hash devolvido serve de baseHash para a gravação seguinte', async () => {
    const alvo = join(projectPath, 'doc.md')
    const primeira = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'um\n', baseHash: hashDe(alvo) },
    })
    expect(primeira.statusCode).toBe(200)
    const segunda = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'dois\n', baseHash: primeira.json().hash },
    })
    expect(segunda.statusCode).toBe(200)
    expect(readFileSync(alvo, 'utf8')).toBe('dois\n')
  })
})

describe('POST /api/files/write — fidelidade ao arquivo', () => {
  it('preserva as permissões do arquivo original', async () => {
    const alvo = join(projectPath, 'doc.md')
    chmodSync(alvo, 0o640)
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'novo\n', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(200)
    expect(statSync(alvo).mode & 0o777).toBe(0o640)
  })

  it('arquivo CRLF continua CRLF depois de salvo', async () => {
    const alvo = join(projectPath, 'win.md')
    writeFileSync(alvo, 'linha1\r\nlinha2\r\n')
    const res = await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'win.md', projectId, content: 'linha1\nlinha2\nlinha3\n', baseHash: hashDe(alvo) },
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(alvo, 'utf8')).toBe('linha1\r\nlinha2\r\nlinha3\r\n')
  })

  it('arquivo LF continua LF (não ganha \\r por engano)', async () => {
    const alvo = join(projectPath, 'doc.md')
    await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'a\nb\n', baseHash: hashDe(alvo) },
    })
    expect(readFileSync(alvo, 'utf8')).toBe('a\nb\n')
  })

  it('não deixa arquivo temporário para trás', async () => {
    const alvo = join(projectPath, 'doc.md')
    await app.inject({
      method: 'POST', url: '/api/files/write',
      payload: { path: 'doc.md', projectId, content: 'novo\n', baseHash: hashDe(alvo) },
    })
    expect(readdirSync(projectPath).filter((n) => n.includes('claudinei-tmp'))).toEqual([])
  })
})
