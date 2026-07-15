import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeName, saveUpload, rotateUploads } from '../src/uploads.js'

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
  it('grava com prefixo incremental a partir do maior existente', async () => {
    const dir = tmp()
    writeFileSync(join(dir, '007-antigo.txt'), 'x')
    const r1 = await saveUpload(dir, 'foto.png', Readable.from('AAA'))
    expect(r1.name).toBe('008-foto.png')
    expect(r1.path).toBe(join(dir, '008-foto.png'))
    expect(readFileSync(r1.path, 'utf8')).toBe('AAA')
    const r2 = await saveUpload(dir, 'foto.png', Readable.from('BBB'))
    expect(r2.name).toBe('009-foto.png') // mesmo nome nunca colide
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

describe('rotateUploads', () => {
  it('mantém só os N mais novos por mtime', () => {
    const dir = tmp()
    for (let i = 0; i < 7; i++) {
      const f = join(dir, `00${i}-f${i}.txt`)
      writeFileSync(f, 'x')
      utimesSync(f, new Date(1000000 + i * 1000), new Date(1000000 + i * 1000))
    }
    rotateUploads(dir, 3)
    const left = readdirSync(dir).sort()
    expect(left).toEqual(['004-f4.txt', '005-f5.txt', '006-f6.txt'])
  })
  it('pasta inexistente é no-op', () => {
    expect(() => rotateUploads('/nao/existe', 3)).not.toThrow()
  })
})
