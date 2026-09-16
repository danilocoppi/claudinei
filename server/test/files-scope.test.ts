import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveInScope, kindOf } from '../src/files/scope.js'

let root: string, proj: { id: number; path: string }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fv-'))
  proj = { id: 1, path: join(root, 'proj') }
  mkdirSync(proj.path, { recursive: true })
  writeFileSync(join(proj.path, 'a.txt'), 'hello')
  mkdirSync(join(root, 'secret'), { recursive: true })
  writeFileSync(join(root, 'secret', 'k.txt'), 'top')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('kindOf', () => {
  it('mapeia por extensão', () => {
    expect(kindOf('/x/a.png')).toBe('image'); expect(kindOf('/x/a.pdf')).toBe('pdf')
    expect(kindOf('/x/a.md')).toBe('markdown'); expect(kindOf('/x/a.ts')).toBe('code')
    expect(kindOf('/x/a.txt')).toBe('text'); expect(kindOf('/x/a.bin')).toBe('binary')
    expect(kindOf('/x/README')).toBe('text') // sem extensão → text
  })
})

describe('resolveInScope', () => {
  it('arquivo dentro do projeto (não-admin) → exists+inScope', () => {
    const r = resolveInScope(join(proj.path, 'a.txt'), proj, false)
    expect(r).toMatchObject({ exists: true, inScope: true, kind: 'text', size: 5 })
    expect(r.real).toBe(realpathSync(join(proj.path, 'a.txt')))
  })
  it('relativo resolve contra project.path', () => {
    const r = resolveInScope('a.txt', proj, false)
    expect(r).toMatchObject({ exists: true, inScope: true })
    expect(r.real).toBe(realpathSync(join(proj.path, 'a.txt')))
  })
  it.each(['proj/a.txt', './proj/a.txt'])('remove a base repetida em %s quando o original não existe', (path) => {
    expect(resolveInScope(path, proj, false)).toEqual({
      path, exists: true, inScope: true, kind: 'text', size: 5,
      real: realpathSync(join(proj.path, 'a.txt')),
    })
  })
  it('reconhece vários componentes completos da base, incluindo projeto em subpasta', () => {
    const backend = { id: 2, path: join(proj.path, 'backend') }
    mkdirSync(join(backend.path, 'docs'), { recursive: true })
    const file = join(backend.path, 'docs', 'plano.md')
    writeFileSync(file, '# Plano')
    for (const path of ['backend/docs/plano.md', 'proj/backend/docs/plano.md', `${basename(root)}/proj/backend/docs/plano.md`]) {
      expect(resolveInScope(path, backend, false)).toMatchObject({
        path, exists: true, inScope: true, kind: 'markdown', real: realpathSync(file),
      })
    }
  })
  it('mantém prioridade do caminho original quando a pasta repetida realmente existe', () => {
    mkdirSync(join(proj.path, 'proj'))
    const original = join(proj.path, 'proj', 'a.txt')
    writeFileSync(original, 'outro arquivo')
    expect(resolveInScope('proj/a.txt', proj, false).real).toBe(realpathSync(original))
  })
  it('não troca um diretório existente por um arquivo ao remover a base', () => {
    mkdirSync(join(proj.path, 'proj', 'a.txt'), { recursive: true })
    expect(resolveInScope('proj/a.txt', proj, false)).toEqual({ path: 'proj/a.txt', exists: false, inScope: false })
  })
  it.each(['roj/a.txt', 'proj-extra/a.txt', 'alheio/proj/a.txt', 'proj/nope.txt', 'proj/../proj/a.txt'])('não adivinha outro arquivo para %s', (path) => {
    expect(resolveInScope(path, proj, false)).toEqual({ path, exists: false, inScope: false })
  })
  it('não reinterpreta caminhos absolutos como relativos', () => {
    const path = join(proj.path, 'proj', 'a.txt')
    expect(resolveInScope(path, proj, true)).toEqual({ path, exists: false, inScope: false })
  })
  it('base repetida sem projeto não resolve, mesmo para admin', () => {
    expect(resolveInScope('proj/a.txt', null, true)).toEqual({ path: 'proj/a.txt', exists: false, inScope: false })
  })
  it.each([false, true])('a alternativa não segue symlink para fora da base (admin=%s)', (admin) => {
    symlinkSync(join(root, 'secret', 'k.txt'), join(proj.path, 'link.txt'))
    expect(resolveInScope('proj/link.txt', proj, admin)).toEqual({ path: 'proj/link.txt', exists: false, inScope: false })
  })
  it('permite symlink da alternativa que continua dentro da raiz real do projeto', () => {
    symlinkSync(join(proj.path, 'a.txt'), join(proj.path, 'link.txt'))
    const alias = join(root, 'alias')
    symlinkSync(proj.path, alias)
    expect(resolveInScope('alias/link.txt', { id: 1, path: alias }, false).real).toBe(realpathSync(join(proj.path, 'a.txt')))
  })
  it('não tenta a alternativa quando o original existe, mas está fora do escopo', () => {
    symlinkSync(join(root, 'secret'), join(proj.path, 'proj'))
    writeFileSync(join(proj.path, 'k.txt'), 'interno')
    expect(resolveInScope('proj/k.txt', proj, false)).toEqual({ path: 'proj/k.txt', exists: false, inScope: false })
  })
  it('fora do projeto (não-admin) → responde como inexistente (sem oráculo de existência)', () => {
    const r = resolveInScope(join(root, 'secret', 'k.txt'), proj, false)
    expect(r).toMatchObject({ exists: false, inScope: false })
    expect(r.real).toBeUndefined()
  })
  it('admin → inScope mesmo fora do projeto', () => {
    const r = resolveInScope(join(root, 'secret', 'k.txt'), proj, true)
    expect(r).toMatchObject({ exists: true, inScope: true })
    expect(r.real).toBe(realpathSync(join(root, 'secret', 'k.txt')))
  })
  it('traversal ../.. barrado (não-admin)', () => {
    const r = resolveInScope(join(proj.path, '..', 'secret', 'k.txt'), proj, false)
    expect(r.inScope).toBe(false)
    expect(r.real).toBeUndefined()
  })
  it('symlink de dentro→fora barrado (não-admin)', () => {
    symlinkSync(join(root, 'secret', 'k.txt'), join(proj.path, 'link.txt'))
    const r = resolveInScope(join(proj.path, 'link.txt'), proj, false)
    expect(r.inScope).toBe(false)
    expect(r.real).toBeUndefined()
  })
  it('diretório (não-admin) → responde como inexistente (não é arquivo)', () => {
    const r = resolveInScope(proj.path, proj, false)
    expect(r).toMatchObject({ exists: false, inScope: false })
    expect(r.real).toBeUndefined()
  })
  it('inexistente → exists:false', () => {
    expect(resolveInScope(join(proj.path, 'nope.txt'), proj, false)).toMatchObject({ exists: false, inScope: false })
  })
  it('relativo sem projeto → não resolve', () => {
    expect(resolveInScope('a.txt', null, false)).toMatchObject({ exists: false, inScope: false })
  })
  it('admin com absoluto e project=null → inScope', () => {
    const r = resolveInScope(join(root, 'secret', 'k.txt'), null, true)
    expect(r).toMatchObject({ exists: true, inScope: true })
    expect(r.real).toBe(realpathSync(join(root, 'secret', 'k.txt')))
  })

  // Lacunas apontadas na revisão de segurança — regressão dos vetores clássicos de scope-check.
  it('traversal com "../.." literal (string crua) barrado', () => {
    expect(resolveInScope(`${proj.path}/../secret/k.txt`, proj, false).inScope).toBe(false)
    expect(resolveInScope(`${proj.path}/sub/../../secret/k.txt`, proj, false).inScope).toBe(false)
  })
  it('prefixo enganoso (proj-evil) NÃO passa como se fosse o projeto', () => {
    const evil = `${proj.path}-evil`
    mkdirSync(evil, { recursive: true }); writeFileSync(join(evil, 'x.txt'), 'nope')
    expect(resolveInScope(join(evil, 'x.txt'), proj, false).inScope).toBe(false)
  })
  it('admin + inexistente → exists:false (não devolve inScope pra arquivo que não existe)', () => {
    expect(resolveInScope('/nao/existe/mesmo.txt', proj, true)).toMatchObject({ exists: false, inScope: false })
  })
  it('admin + diretório → inScope:false (não serve dir nem pra admin)', () => {
    expect(resolveInScope(proj.path, proj, true)).toMatchObject({ exists: true, inScope: false })
  })
})
