import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyRequest } from 'fastify'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerFileRoutes } from '../src/routes/files.js'
import type { ProjectsService } from '../src/projects.js'
import type { AuthUser } from '../src/auth/plugin.js'

let base: string
let root: string
let app: ReturnType<typeof Fastify>
let user: AuthUser | undefined
const list = (path = '', extra: Record<string, string> = {}) => app.inject({
  method: 'GET', url: `/api/files/list?${new URLSearchParams({ projectId: '1', path, ...extra })}`,
})
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'file-picker-'))
  root = join(base, 'project')
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'empty'))
  await writeFile(join(root, 'README'), 'not read by listing')
  await writeFile(join(root, '.env'), 'not read by listing')
  await writeFile(join(root, 'docs', 'ação "nova".md'), '# reference')
  await writeFile(join(base, 'secret.txt'), 'outside')
  await symlink(join(root, 'docs'), join(root, 'inside-link'))
  await symlink(base, join(root, 'outside-link'))
  await symlink(join(base, 'secret.txt'), join(root, 'outside.txt'))
  await symlink(join(root, 'missing'), join(root, 'broken-link'))
  user = undefined
  app = Fastify()
  app.addHook('preHandler', async (req: FastifyRequest) => { req.authUser = user })
  registerFileRoutes(app, { projects: { get: (id: number) => id === 1 ? { id, path: root } : null } as ProjectsService })
})
afterEach(async () => { await app.close(); await rm(base, { recursive: true, force: true }) })

describe('listagem de arquivos para @!', () => {
  it('lista a raiz com pastas primeiro, ocultos e arquivos sem extensão, sem conteúdo nem caminho do host', async () => {
    const response = await list()
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ path: '', parent: null, nextOffset: null, entries: [
      { name: 'docs', path: 'docs', isDir: true },
      { name: 'empty', path: 'empty', isDir: true },
      { name: 'inside-link', path: 'inside-link', isDir: true },
      { name: '.env', path: '.env', isDir: false },
      { name: 'README', path: 'README', isDir: false },
    ] })
    expect(response.body).not.toContain(base)
    expect(response.body).not.toContain('not read')
  })
  it('entra na pasta e no link interno preservando nomes com Unicode e aspas', async () => {
    for (const path of ['docs', 'inside-link']) {
      expect((await list(path)).json()).toEqual({ path, parent: '', nextOffset: null,
        entries: [{ name: 'ação "nova".md', path: `${path}/ação "nova".md`, isDir: false }] })
    }
    expect((await list('empty')).json().entries).toEqual([])
    expect((await list('missing')).statusCode).toBe(404)
    expect((await list('README')).statusCode).toBe(404)
  })
  it('filtra por nome sem acentos nem caixa, dentro da pasta atual', async () => {
    const response = await list('docs', { query: 'ACAO nova' })
    expect(response.json().entries).toHaveLength(1)
    expect((await list('', { query: 'ACAO' })).json().entries).toEqual([])
  })
  it('pagina sem truncar o restante e encontra arquivos além da primeira página', async () => {
    await Promise.all(Array.from({ length: 105 }, (_, i) => writeFile(join(root, 'empty', `file-${i}.txt`), '')))
    const first = (await list('empty')).json()
    expect(first.entries).toHaveLength(100)
    expect(first.nextOffset).toBe(100)
    const second = (await list('empty', { offset: '100' })).json()
    expect(second.entries).toHaveLength(5)
    expect(second.nextOffset).toBeNull()
    expect(new Set([...first.entries, ...second.entries].map(e => e.path)).size).toBe(105)
    expect((await list('empty', { query: 'file-104' })).json().entries[0].name).toBe('file-104.txt')
  })
  it('barra traversal, caminhos absolutos e symlinks externos também para admin', async () => {
    for (const path of ['..', '../project-other', base, root, 'outside-link']) {
      expect((await list(path)).statusCode).toBe(403)
    }
  })
  it('respeita a autorização do projeto antes de acessar o disco', async () => {
    user = { kind: 'user', id: 2, username: 'reader', isAdmin: false, projectIds: [1] }
    expect((await list('docs')).statusCode).toBe(200)
    user = { ...user, projectIds: [] }
    expect((await list()).statusCode).toBe(403)
    user = undefined
    expect((await list('', { projectId: '999' })).statusCode).toBe(403)
  })
  it('valida parâmetros sem repassar detalhes internos do filesystem', async () => {
    expect((await list('', { projectId: 'oops' })).statusCode).toBe(400)
    expect((await list('', { offset: '-1' })).statusCode).toBe(400)
    expect((await list('x\0y')).statusCode).toBe(400)
    expect((await list('missing')).body).not.toContain(root)
  })
})
