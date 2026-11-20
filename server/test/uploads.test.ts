import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeName, saveUpload, rotateUploads, missingUploads } from '../src/uploads.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'up-'))

describe('sanitizeName', () => {
  it('remove path traversal e metachars', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etc_passwd')
    expect(sanitizeName('foto legal (1).png')).toBe('foto_legal__1_.png')
    expect(sanitizeName('a;rm -rf.txt')).toBe('a_rm_-rf.txt')
  })
  it('vazio (ou só lixo) vira "arquivo"', () => {
    expect(sanitizeName('')).toBe('arquivo')
    expect(sanitizeName('///')).toBe('arquivo')
  })
  it('trunca a 80 chars preservando a extensão no fim', () => {
    const long = 'x'.repeat(200) + '.png'
    const out = sanitizeName(long)
    expect(out.length).toBeLessThanOrEqual(80)
    expect(out.endsWith('.png')).toBe(true)
  })
})

describe('saveUpload', () => {
  it('grava como <data-hora>-<4 hex>-nome; o mesmo nome nunca colide', async () => {
    const dir = tmp()
    const r1 = await saveUpload(dir, 'foto.png', Readable.from('AAA'))
    expect(r1.name).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}-foto\.png$/)
    expect(r1.path).toBe(join(dir, r1.name))
    expect(readFileSync(r1.path, 'utf8')).toBe('AAA')
    const r2 = await saveUpload(dir, 'foto.png', Readable.from('BBB'))
    expect(r2.name).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}-foto\.png$/)
    expect(r2.name).not.toBe(r1.name)
  })

  it('a data-hora do nome é a do relógio local, no formato AAAAMMDD-HHMMSS', async () => {
    const r = await saveUpload(tmp(), 'a.txt', Readable.from('x'), { now: new Date(2026, 10, 20, 9, 5, 7) })
    expect(r.name).toMatch(/^20261120-090507-[0-9a-f]{4}-a\.txt$/)
  })

  it('pasta esvaziada (tudo expirou): os novos nomes nunca repetem um apagado', async () => {
    const dir = tmp()
    const antes = [
      await saveUpload(dir, 'print.png', Readable.from('A')),
      await saveUpload(dir, 'print.png', Readable.from('B')),
    ].map((r) => r.name)
    // A rotação por idade apagou tudo (o contador antigo voltaria a 001).
    rmSync(dir, { recursive: true, force: true })
    const depois = [
      await saveUpload(dir, 'print.png', Readable.from('C')),
      await saveUpload(dir, 'print.png', Readable.from('D')),
    ].map((r) => r.name)
    expect(new Set([...antes, ...depois]).size).toBe(4)
    for (const n of depois) expect(antes).not.toContain(n)
  })

  it('arquivos antigos no formato NNN- seguem onde estão e continuam achados', async () => {
    const dir = tmp()
    writeFileSync(join(dir, '007-antigo.txt'), 'x')
    await saveUpload(dir, 'novo.txt', Readable.from('y'))
    expect(readFileSync(join(dir, '007-antigo.txt'), 'utf8')).toBe('x')
    expect(missingUploads(dir, [join(dir, '007-antigo.txt')])).toEqual([])
  })
  it('cria a pasta se não existir', async () => {
    const dir = join(tmp(), 'sub', 'dir')
    const r = await saveUpload(dir, 'a.txt', Readable.from('x'))
    expect(readFileSync(r.path, 'utf8')).toBe('x')
  })

  it('uploads concorrentes nunca sobrescrevem (nomes finais distintos)', async () => {
    const dir = tmp()
    const [a, b] = await Promise.all([
      saveUpload(dir, 'colado-120000.png', Readable.from('AAA')),
      saveUpload(dir, 'colado-120000.png', Readable.from('BBB')),
    ])
    expect(a.path).not.toBe(b.path)
    expect(readFileSync(a.path, 'utf8')).toBe('AAA')
    expect(readFileSync(b.path, 'utf8')).toBe('BBB')
  })
})

const DAY = 24 * 60 * 60 * 1000

/** Cria `name` em `dir` com mtime = agora - `ageMs`. */
function fileAged(dir: string, name: string, ageMs: number): string {
  const f = join(dir, name)
  writeFileSync(f, 'x')
  const when = new Date(Date.now() - ageMs)
  utimesSync(f, when, when)
  return f
}

describe('rotateUploads', () => {
  it('rotação por idade apaga só o que passou de 30 dias', () => {
    const dir = tmp()
    fileAged(dir, '001-velho.txt', 31 * DAY)
    fileAged(dir, '002-quase.txt', 29 * DAY)
    fileAged(dir, '003-novo.txt', 0)
    rotateUploads(dir)
    expect(readdirSync(dir).sort()).toEqual(['002-quase.txt', '003-novo.txt'])
  })
  it('teto de segurança apaga os mais velhos excedentes', () => {
    const dir = tmp()
    for (let i = 0; i < 5; i++) fileAged(dir, `00${i}-f${i}.txt`, (5 - i) * 60_000) // f4 é o mais novo
    rotateUploads(dir, { hardCap: 3 })
    expect(readdirSync(dir).sort()).toEqual(['002-f2.txt', '003-f3.txt', '004-f4.txt'])
  })
  it('maxAgeMs e now são configuráveis', () => {
    const dir = tmp()
    fileAged(dir, '001-a.txt', 2 * DAY)
    fileAged(dir, '002-b.txt', 0)
    rotateUploads(dir, { maxAgeMs: DAY, now: Date.now() })
    expect(readdirSync(dir)).toEqual(['002-b.txt'])
  })
  it('cem uploads não apagam o primeiro (era o teto antigo)', () => {
    const dir = tmp()
    for (let i = 0; i < 101; i++) fileAged(dir, `${String(i + 1).padStart(3, '0')}-f.txt`, (101 - i) * 1000)
    rotateUploads(dir)
    expect(readdirSync(dir)).toHaveLength(101)
    expect(readdirSync(dir)).toContain('001-f.txt')
  })
  it('pasta inexistente é no-op', () => {
    expect(() => rotateUploads('/nao/existe')).not.toThrow()
  })
})

describe('missingUploads', () => {
  it('missingUploads aponta ausentes e recusa caminho fora da pasta', () => {
    const dir = tmp()
    const ok = fileAged(dir, '001-ok.txt', 0)
    const sumiu = join(dir, '002-sumiu.txt')
    const fora = join(dir, '../etc/passwd')
    const relativo = '../etc/passwd'
    expect(missingUploads(dir, [ok, sumiu, fora, relativo])).toEqual([sumiu, fora, relativo])
  })
  it('caminho fora da pasta conta como ausente mesmo que exista', () => {
    const dir = tmp()
    const vizinho = tmp() // existe, mas é outra pasta
    const f = fileAged(vizinho, 'x.txt', 0)
    // prefixo de nome igual (dir + "-irmao") também não passa
    expect(missingUploads(dir, [f, `${dir}-irmao/x.txt`, dir])).toEqual([f, `${dir}-irmao/x.txt`, dir])
  })
})
