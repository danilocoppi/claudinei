import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { isPackaged, cacheRoot, extractTree, buildIdOf, ensureNativeCache } from '../src/pkg-runtime.js'

describe('isPackaged', () => {
  it('false fora do binário pkg', () => { expect(isPackaged()).toBe(false) })
})

describe('cacheRoot', () => {
  it('respeita XDG_CACHE_HOME e versiona', () => {
    const r = cacheRoot('9', { XDG_CACHE_HOME: '/x/cache' } as never)
    expect(r).toBe('/x/cache/claudinei/native-9')
  })
  it('sem XDG cai em ~/.cache (spec XDG), não em /tmp', () => {
    expect(cacheRoot('9', {} as never)).toBe(join(homedir(), '.cache', 'claudinei', 'native-9'))
  })
})

describe('extractTree', () => {
  it('copia a árvore recursivamente e pula arquivos já presentes', () => {
    const src = mkdtempSync(join(tmpdir(), 'src-'))
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'A')
    writeFileSync(join(src, 'sub', 'b.txt'), 'B')
    const dst = mkdtempSync(join(tmpdir(), 'dst-'))
    extractTree(src, dst)
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('B')
    // idempotente: a fonte muda, mas re-extrair NÃO sobrescreve quem já existe no destino
    writeFileSync(join(src, 'a.txt'), 'MUDOU')
    extractTree(src, dst) // mesma fonte alterada → destino intacto (pula existentes)
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('A')
    // arquivo NOVO na fonte é copiado numa re-extração
    writeFileSync(join(src, 'c.txt'), 'C')
    extractTree(src, dst)
    expect(readFileSync(join(dst, 'c.txt'), 'utf8')).toBe('C')
    // escrita atômica: nenhum .tmp- sobra no destino
    expect(readdirSync(dst).filter((n) => n.includes('.tmp-'))).toEqual([])
    rmSync(src, { recursive: true }); rmSync(dst, { recursive: true })
  })
})

describe('buildIdOf', () => {
  it('lê assets/build-id sanitizado; ausente → null', () => {
    const assets = mkdtempSync(join(tmpdir(), 'assets-'))
    expect(buildIdOf(assets)).toBeNull()
    writeFileSync(join(assets, 'build-id'), '  abc123-99/../evil \n')
    expect(buildIdOf(assets)).toBe('abc123-99..evil') // sem separadores/espacos
    rmSync(assets, { recursive: true })
  })
})

describe('ensureNativeCache chaveado por build-id (rebuild atualiza a UI)', () => {
  const prevXdg = process.env.XDG_CACHE_HOME
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = prevXdg
  })

  const mkAssets = (buildId: string, html: string): string => {
    const assets = mkdtempSync(join(tmpdir(), 'snap-'))
    mkdirSync(join(assets, 'native'), { recursive: true })
    writeFileSync(join(assets, 'native', 'x.node'), 'bin')
    mkdirSync(join(assets, 'web'), { recursive: true })
    writeFileSync(join(assets, 'web', 'index.html'), html)
    writeFileSync(join(assets, 'build-id'), buildId)
    return assets
  }

  it('build novo (build-id novo) → dir novo, index.html NOVO servido; cache recente NÃO é podado', () => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'cache-'))
    // build A
    const a = ensureNativeCache({ snapshotAssets: mkAssets('buildA', '<html>A</html>'), version: 'v1' })
    expect(readFileSync(join(a.webDir, 'index.html'), 'utf8')).toBe('<html>A</html>')
    // rebuild (sem bump de versão) → build-id diferente → NÃO reusa o dir antigo
    const b = ensureNativeCache({ snapshotAssets: mkAssets('buildB', '<html>B</html>'), version: 'v1' })
    expect(b.webDir).not.toBe(a.webDir)
    expect(readFileSync(join(b.webDir, 'index.html'), 'utf8')).toBe('<html>B</html>')
    // o cache de A é recente: uma instância antiga ainda rodando pode precisar dele
    expect(existsSync(a.webDir)).toBe(true)
  })

  it('poda só caches com mais de 7 dias (instância antiga rodando não perde os nativos)', () => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'cache-'))
    const a = ensureNativeCache({ snapshotAssets: mkAssets('buildA', '<html>A</html>'), version: 'v1' })
    const b = ensureNativeCache({ snapshotAssets: mkAssets('buildB', '<html>B</html>'), version: 'v1' })
    // envelhece o cache de A (mtime > 7 dias) e roda um build novo → A é podado, B (recente) fica
    const oldSec = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(dirname(a.webDir), oldSec, oldSec)
    ensureNativeCache({ snapshotAssets: mkAssets('buildC', '<html>C</html>'), version: 'v1' })
    expect(existsSync(a.webDir)).toBe(false)
    expect(existsSync(b.webDir)).toBe(true)
  })

  it('sem build-id no snapshot cai na version (compat com binário antigo)', () => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'cache-'))
    const assets = mkAssets('x', '<html>V</html>')
    rmSync(join(assets, 'build-id'))
    const r = ensureNativeCache({ snapshotAssets: assets, version: 'v7' })
    expect(r.webDir).toContain('native-v7')
    expect(readFileSync(join(r.webDir, 'index.html'), 'utf8')).toBe('<html>V</html>')
  })
})
