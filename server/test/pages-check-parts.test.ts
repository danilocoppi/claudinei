import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { metaCsp } from '../src/pages/csp.js'
import { HEIGHT_SCRIPT } from '../src/pages/height-script.js'
import {
  CHECK_CONSOLE_MAX, CHECK_MAX_HEIGHT, CHECK_SHOT_TTL_MS,
  checkDocument, createCheckShots, cropPngHeight, orderConsole, withMetaCsp,
} from '../src/pages/check-parts.js'

// Peças do check_page que não dependem do navegador (projeto 15).

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** Linhas já filtradas: o filtro de cada linha varia (0 a 4) para provar que os bytes passam intactos. */
function rows(width: number, height: number, bpp: number): Buffer {
  const rowBytes = 1 + width * bpp
  const raw = Buffer.alloc(height * rowBytes)
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = y % 5
    for (let i = 1; i < rowBytes; i++) raw[y * rowBytes + i] = (y * 31 + i * 7) & 0xff
  }
  return raw
}

/** Codificador mínimo: IHDR, um tEXt antes do IDAT, IDAT em dois pedaços e IEND. */
function encodePng(opts: {
  width: number; height: number; colorType?: number; bpp?: number; bitDepth?: number; interlace?: number
}): { png: Buffer; raw: Buffer } {
  const { width, height, colorType = 6, bpp = 4, bitDepth = 8, interlace = 0 } = opts
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[12] = interlace
  const raw = rows(width, height, bpp)
  const z = deflateSync(raw)
  const half = z.length >> 1
  const png = Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Software\0teste', 'latin1')),
    chunk('IDAT', z.subarray(0, half)),
    chunk('IDAT', z.subarray(half)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return { png, raw }
}

interface Chunk { type: string; data: Buffer; crcOk: boolean }
function readChunks(png: Buffer): Chunk[] {
  expect(png.subarray(0, 8).equals(SIG)).toBe(true)
  const out: Chunk[] = []
  let at = 8
  while (at < png.length) {
    const len = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + len)
    const crc = png.readUInt32BE(at + 8 + len)
    out.push({ type, data, crcOk: crc === crc32(png.subarray(at + 4, at + 8 + len)) })
    at += 12 + len
  }
  return out
}

describe('cropPngHeight', () => {
  it('PNG 100×3000 vira 100×2000: IHDR com altura 2000, IDAT descomprime em 2000 linhas iguais às originais, CRCs válidos', () => {
    const { png, raw } = encodePng({ width: 100, height: 3000 })
    const r = cropPngHeight(png, CHECK_MAX_HEIGHT)
    expect(CHECK_MAX_HEIGHT).toBe(2000)
    expect(r.cropped).toBe(true)
    const chunks = readChunks(r.png)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND'])
    expect(chunks.every((c) => c.crcOk)).toBe(true)
    const ihdr = chunks[0].data
    expect(ihdr.readUInt32BE(0)).toBe(100)
    expect(ihdr.readUInt32BE(4)).toBe(2000)
    expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0])
    const idat = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
    const rowBytes = 1 + 100 * 4
    expect(idat.length).toBe(2000 * rowBytes)
    expect(idat.equals(raw.subarray(0, 2000 * rowBytes))).toBe(true)
  })

  it('outras profundidades de cor de 8 bits: cinza (1 byte), RGB (3), cinza+alfa (2), paleta (1)', () => {
    for (const [colorType, bpp] of [[0, 1], [2, 3], [4, 2], [3, 1]]) {
      const { png, raw } = encodePng({ width: 37, height: 50, colorType, bpp })
      const r = cropPngHeight(png, 20)
      expect(r.cropped).toBe(true)
      const chunks = readChunks(r.png)
      expect(chunks[0].data.readUInt32BE(4)).toBe(20)
      const idat = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
      expect(idat.equals(raw.subarray(0, 20 * (1 + 37 * bpp)))).toBe(true)
    }
  })

  it('PNG com 1500 linhas volta igual, cropped false', () => {
    const { png } = encodePng({ width: 100, height: 1500 })
    const r = cropPngHeight(png, 2000)
    expect(r.cropped).toBe(false)
    expect(r.png).toBe(png)
  })

  it('entrelaçado ou 16 bits volta igual', () => {
    const inter = encodePng({ width: 10, height: 3000, interlace: 1 }).png
    expect(cropPngHeight(inter, 2000)).toEqual({ png: inter, cropped: false })
    const deep = encodePng({ width: 10, height: 3000, bitDepth: 16, bpp: 8 }).png
    expect(cropPngHeight(deep, 2000)).toEqual({ png: deep, cropped: false })
    const low = encodePng({ width: 10, height: 3000, bitDepth: 4, colorType: 0, bpp: 1 }).png
    expect(cropPngHeight(low, 2000)).toEqual({ png: low, cropped: false })
  })

  it('PNG malformado não lança: volta igual, cropped false', () => {
    const { png } = encodePng({ width: 50, height: 3000 })
    const bad = [
      Buffer.alloc(0),
      Buffer.from('não é png'),
      png.subarray(0, 40),
      Buffer.concat([png.subarray(0, 33), chunk('IDAT', Buffer.from('lixo que não é zlib'))]),
      // IDAT bom, mas curto demais para 2000 linhas.
      Buffer.concat([png.subarray(0, 33), chunk('IDAT', deflateSync(Buffer.alloc(10)))]),
    ]
    for (const b of bad) {
      const r = cropPngHeight(b, 2000)
      expect(r.cropped).toBe(false)
      expect(r.png).toBe(b)
    }
  })
})

describe('withMetaCsp e checkDocument', () => {
  const csp = metaCsp('cdn')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`

  it('withMetaCsp: com <head lang>, sem head, sem html', () => {
    expect(withMetaCsp('<html><head lang="pt"><title>x</title></head><body>a</body></html>', csp))
      .toBe(`<html><head lang="pt">${meta}<title>x</title></head><body>a</body></html>`)
    // <header> não é <head>.
    expect(withMetaCsp('<!doctype html><html lang="pt"><body><header>h</header></body></html>', csp))
      .toBe(`<!doctype html><html lang="pt"><head>${meta}</head><body><header>h</header></body></html>`)
    expect(withMetaCsp('<p>oi</p>', csp)).toBe(`${meta}<p>oi</p>`)
    // Sem <html>, o meta fica depois do doctype, para não tirar a página do modo padrão.
    expect(withMetaCsp('<!DOCTYPE html>\n<p>oi</p>', csp)).toBe(`<!DOCTYPE html>${meta}\n<p>oi</p>`)
  })

  it('withMetaCsp escapa aspas e & no atributo', () => {
    expect(withMetaCsp('<p>x</p>', `a "b" & c`))
      .toBe('<meta http-equiv="Content-Security-Policy" content="a &quot;b&quot; &amp; c"><p>x</p>')
  })

  it('metaCsp não tem sandbox', () => {
    expect(metaCsp('cdn')).not.toMatch(/sandbox/)
    expect(metaCsp('open')).not.toMatch(/sandbox/)
  })

  it('checkDocument traz meta CSP e script de altura', () => {
    const doc = checkDocument('<html><head></head><body><p>oi</p></body></html>', 'open')
    expect(doc).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${metaCsp('open')}">`)
    expect(doc).toContain(HEIGHT_SCRIPT)
    expect(doc.indexOf(HEIGHT_SCRIPT)).toBeLessThan(doc.indexOf('</body>'))
    expect(doc).not.toMatch(/sandbox/)
  })
})

describe('orderConsole', () => {
  it('orderConsole: erros primeiro, 50 no máximo, linha cortada em 500', () => {
    expect(CHECK_CONSOLE_MAX).toBe(50)
    const out = orderConsole([
      { type: 'log', text: 'um' },
      { type: 'error', text: 'falhou' },
      { type: 'warning', text: 'cuidado' },
      { type: 'pageerror', text: 'ReferenceError: x' },
    ])
    expect(out).toEqual(['[error] falhou', '[pageerror] ReferenceError: x', '[log] um', '[warning] cuidado'])

    const many = Array.from({ length: 80 }, (_, i) => ({ type: i % 2 ? 'error' : 'log', text: String(i) }))
    const cut = orderConsole(many)
    expect(cut).toHaveLength(50)
    expect(cut.slice(0, 40).every((l) => l.startsWith('[error] '))).toBe(true)
    expect(cut[0]).toBe('[error] 1')
    expect(cut[40]).toBe('[log] 0')
    expect(orderConsole(many, 3)).toEqual(['[error] 1', '[error] 3', '[error] 5'])

    const [long] = orderConsole([{ type: 'log', text: 'x'.repeat(2000) }])
    expect(long).toHaveLength(500)
    expect(long.startsWith('[log] xxx')).toBe(true)
  })
})

describe('createCheckShots', () => {
  let base: string | null = null
  afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = null })

  it('createCheckShots: grava em dir/claudinei-check, nomes distintos; sweep apaga os de mais de 30 min (now injetado)', () => {
    expect(CHECK_SHOT_TTL_MS).toBe(30 * 60_000)
    base = mkdtempSync(join(tmpdir(), 'check-shots-'))
    const dir = join(base, 'claudinei-check')
    let now = Date.now()
    const shots = createCheckShots({ dir, now: () => now })
    const a = shots.save(Buffer.from('png-a'))
    const b = shots.save(Buffer.from('png-b'))
    expect(a).not.toBe(b)
    expect(dirname(a)).toBe(dir)
    expect(dirname(b)).toBe(dir)
    expect(basename(a)).toMatch(/\.png$/)
    expect(readFileSync(a, 'utf8')).toBe('png-a')
    expect(readFileSync(b, 'utf8')).toBe('png-b')

    // a fica velho (31 min); b, só 10 min.
    const t = Date.now() / 1000
    utimesSync(a, t - 31 * 60, t - 31 * 60)
    utimesSync(b, t - 10 * 60, t - 10 * 60)
    expect(shots.sweep()).toBe(1)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(true)

    // Com o relógio 31 min à frente, o save seguinte apaga b antes de gravar.
    now += 31 * 60_000
    const c = shots.save(Buffer.from('png-c'))
    expect(existsSync(b)).toBe(false)
    expect(readdirSync(dir)).toEqual([basename(c)])
  })

  it('sweep sem a pasta devolve 0 e não apaga o que não é .png', () => {
    base = mkdtempSync(join(tmpdir(), 'check-shots-'))
    const dir = join(base, 'claudinei-check')
    const shots = createCheckShots({ dir, ttlMs: 1000, now: () => Date.now() + 60_000 })
    expect(shots.sweep()).toBe(0)
    shots.save(Buffer.from('x'))
    const other = join(dir, 'outro.txt')
    writeFileSync(other, 'y')
    expect(shots.sweep()).toBe(1)
    expect(readdirSync(dir)).toEqual(['outro.txt'])
  })

  it('sweep só apaga os nomes que o save cria: outro .png velho na pasta fica', () => {
    base = mkdtempSync(join(tmpdir(), 'check-shots-'))
    const dir = join(base, 'claudinei-check')
    const shots = createCheckShots({ dir, ttlMs: 1000, now: () => Date.now() + 60_000 })
    const nosso = shots.save(Buffer.from('x'))
    expect(basename(nosso)).toMatch(/^check-[0-9a-f]{16}\.png$/)
    // Mais velhos que o ttl, com nome parecido mas fora do formato do save.
    const alheios = ['foto.png', 'check-123.png', 'check-0123456789abcdef.png.bak', 'xcheck-0123456789abcdef.png']
    for (const n of alheios) writeFileSync(join(dir, n), 'y')
    expect(shots.sweep()).toBe(1)
    expect(existsSync(nosso)).toBe(false)
    expect(readdirSync(dir).sort()).toEqual([...alheios].sort())
  })

  it('pasta insegura: symlink no lugar da pasta → save lança e não grava no alvo', () => {
    base = mkdtempSync(join(tmpdir(), 'check-shots-'))
    const alvo = join(base, 'alvo')
    mkdirSync(alvo)
    const dir = join(base, 'claudinei-check')
    symlinkSync(alvo, dir)
    const shots = createCheckShots({ dir })
    expect(() => shots.save(Buffer.from('x'))).toThrow(/not a safe folder/)
    expect(readdirSync(alvo)).toEqual([])
  })

  it('pasta insegura: arquivo comum no lugar da pasta → save lança', () => {
    base = mkdtempSync(join(tmpdir(), 'check-shots-'))
    const dir = join(base, 'claudinei-check')
    writeFileSync(dir, 'x')
    expect(() => createCheckShots({ dir }).save(Buffer.from('x'))).toThrow()
  })

  it('pasta insegura: dono diferente do processo → save lança e não grava', () => {
    base = mkdtempSync(join(tmpdir(), 'check-shots-'))
    const dir = join(base, 'claudinei-check')
    const shots = createCheckShots({ dir, uid: () => 4_000_000 })
    expect(() => shots.save(Buffer.from('x'))).toThrow(/not a safe folder/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('o arquivo some sozinho depois do ttl (timer com unref)', async () => {
    base = mkdtempSync(join(tmpdir(), 'check-shots-'))
    const shots = createCheckShots({ dir: join(base, 'claudinei-check'), ttlMs: 50 })
    const p = shots.save(Buffer.from('x'))
    expect(existsSync(p)).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(existsSync(p)).toBe(false)
  })
})
