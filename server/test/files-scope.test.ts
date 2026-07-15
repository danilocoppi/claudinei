import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
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
  it('fora do projeto (não-admin) → inScope:false', () => {
    const r = resolveInScope(join(root, 'secret', 'k.txt'), proj, false)
    expect(r).toMatchObject({ exists: true, inScope: false })
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
  it('diretório → exists mas inScope:false (não é arquivo)', () => {
    const r = resolveInScope(proj.path, proj, false)
    expect(r).toMatchObject({ exists: true, inScope: false })
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
