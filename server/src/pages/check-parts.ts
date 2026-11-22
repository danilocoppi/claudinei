import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants as zc, deflateSync, inflateSync } from 'node:zlib'
import type { PageNetwork } from '../../../shared/visual-pages.js'
import { metaCsp } from './csp.js'
import { withHeightScript } from './height-script.js'

/**
 * Peças do `check_page` que não dependem do navegador: o corte do PNG na
 * altura máxima, o documento como seria publicado, a ordem do console e as
 * cópias temporárias da imagem, para o motor que descarta imagem vinda de MCP.
 */

/** Mesma forma do `ConsoleEntry` do host do navegador: 'log' | 'warning' | 'error' | 'pageerror' … */
export interface CheckConsoleEntry { type: string; text: string }

export const CHECK_MAX_HEIGHT = 2000
export const CHECK_CONSOLE_MAX = 50
export const CHECK_SHOT_TTL_MS = 30 * 60_000

const CONSOLE_LINE_MAX = 500

// --- PNG -------------------------------------------------------------------

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** Bytes por pixel em 8 bits, por tipo de cor: cinza, RGB, paleta, cinza+alfa, RGBA. */
const BYTES_PER_PIXEL: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** Teto do que se descomprime: um corte acima disso devolve o original. */
const MAX_KEEP_BYTES = 256 * 1024 * 1024
/** Folga sobre o necessário ao descomprimir um prefixo do IDAT. */
const INFLATE_SLACK = 1024 * 1024
/** Chunks de animação (APNG) descrevem quadros com a altura antiga: não são copiados. */
const DROP_CHUNKS = new Set(['acTL', 'fcTL'])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/**
 * Descomprime só o começo do fluxo zlib, até `need` bytes. Com Z_SYNC_FLUSH,
 * um prefixo do IDAT descomprime sem erro; o tamanho do prefixo começa
 * proporcional à fração pedida, dobra enquanto falta e, se passar da folga,
 * cai pela metade entre o último curto e o último longo. Assim a memória
 * fica perto de `need`, mesmo quando a imagem inteira é enorme.
 */
function inflatePrefix(data: Buffer, need: number, guess: number): Buffer | null {
  const cap = need + Math.max(INFLATE_SLACK, need >> 2)
  let lo = 0
  let hi = data.length + 1
  let len = Math.min(data.length, Math.max(64 * 1024, guess))
  for (let i = 0; i < 64; i++) {
    let out: Buffer
    try {
      out = inflateSync(data.subarray(0, len), { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: cap })
    } catch (err) {
      if ((err as { code?: string }).code !== 'ERR_BUFFER_TOO_LARGE') return null
      hi = len
      len = lo + ((hi - lo) >> 1)
      if (len <= lo) return null
      continue
    }
    if (out.length >= need) return out.subarray(0, need)
    if (len >= data.length) return null
    lo = len
    len = hi > data.length ? Math.min(data.length, len * 2) : lo + ((hi - lo) >> 1)
    if (len <= lo) return null
  }
  return null
}

/** Corta um PNG de 8 bits, sem entrelaçamento, nas primeiras maxHeight linhas (node:zlib). Outro formato: devolve o original, cropped false. */
export function cropPngHeight(png: Buffer, maxHeight: number): { png: Buffer; cropped: boolean } {
  const same = { png, cropped: false }
  try {
    if (!Number.isInteger(maxHeight) || maxHeight < 1) return same
    if (png.length < 8 + 25 || !png.subarray(0, 8).equals(PNG_SIG)) return same

    let ihdr: Buffer | null = null
    const before: Buffer[] = []
    const idat: Buffer[] = []
    let at = 8
    while (at + 12 <= png.length) {
      const len = png.readUInt32BE(at)
      const end = at + 12 + len
      if (end > png.length) return same
      const type = png.toString('latin1', at + 4, at + 8)
      const data = png.subarray(at + 8, at + 8 + len)
      if (!ihdr) {
        if (type !== 'IHDR' || len !== 13) return same
        ihdr = data
      } else if (type === 'IDAT') {
        idat.push(data)
      } else if (type === 'IEND') {
        break
      } else if (idat.length === 0 && !DROP_CHUNKS.has(type)) {
        // Chunks antes do IDAT (PLTE, tRNS, sRGB, pHYs…) seguem como estão, com o CRC original.
        before.push(png.subarray(at, end))
      }
      at = end
    }
    if (!ihdr || idat.length === 0) return same

    const width = ihdr.readUInt32BE(0)
    const height = ihdr.readUInt32BE(4)
    const bitDepth = ihdr[8]
    const bpp = BYTES_PER_PIXEL[ihdr[9]]
    const interlace = ihdr[12]
    if (bitDepth !== 8 || interlace !== 0 || !bpp || width < 1) return same
    if (height <= maxHeight) return same

    // O filtro de cada linha só olha a de cima: as primeiras maxHeight linhas,
    // ainda filtradas, já formam uma imagem válida e são recomprimidas como estão.
    const rowBytes = 1 + width * bpp
    const need = maxHeight * rowBytes
    if (need > MAX_KEEP_BYTES) return same
    const all = Buffer.concat(idat)
    const guess = Math.ceil((all.length * maxHeight) / height)
    const kept = inflatePrefix(all, need, guess)
    if (!kept) return same
    for (let y = 0; y < maxHeight; y++) if (kept[y * rowBytes] > 4) return same

    const head = Buffer.from(ihdr)
    head.writeUInt32BE(maxHeight, 4)
    const out = Buffer.concat([
      PNG_SIG,
      pngChunk('IHDR', head),
      ...before,
      pngChunk('IDAT', deflateSync(kept)),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
    return { png: out, cropped: true }
  } catch {
    return same
  }
}

// --- Documento ---------------------------------------------------------------

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** <meta http-equiv="Content-Security-Policy"> logo depois de <head …>; sem <head>, cria um depois de <html …>; sem <html>, no início. */
export function withMetaCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`
  const insert = (at: number, s: string) => html.slice(0, at) + s + html.slice(at)
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head) return insert(head.index + head[0].length, meta)
  const root = /<html(?:\s[^>]*)?>/i.exec(html)
  if (root) return insert(root.index + root[0].length, `<head>${meta}</head>`)
  // Sem <html>: no início, mas depois de um doctype, para a página não cair no modo quirks.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return insert(doctype ? doctype[0].length : 0, meta)
}

/** O documento como seria publicado: meta CSP da rede atual e script de altura. */
export function checkDocument(html: string, network: PageNetwork): string {
  return withMetaCsp(withHeightScript(html), metaCsp(network))
}

// --- Console -----------------------------------------------------------------

function isError(e: CheckConsoleEntry): boolean {
  return e.type === 'error' || e.type === 'pageerror'
}

function clip(line: string): string {
  if (line.length <= CONSOLE_LINE_MAX) return line
  let end = CONSOLE_LINE_MAX - 1
  // Não parte um par substituto ao meio.
  const code = line.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return line.slice(0, end) + '…'
}

/** Erros (error, pageerror) primeiro, na ordem de chegada; cada linha "[tipo] texto", cortada em 500 caracteres; até max. */
export function orderConsole(entries: CheckConsoleEntry[], max = CHECK_CONSOLE_MAX): string[] {
  const ordered = [...entries.filter(isError), ...entries.filter((e) => !isError(e))]
  return ordered.slice(0, Math.max(0, max)).map((e) => clip(`[${e.type}] ${e.text}`))
}

// --- Cópias temporárias --------------------------------------------------------

export function createCheckShots(opts: { dir?: string; ttlMs?: number; now?: () => number } = {}): {
  save(png: Buffer): string
  sweep(): number
} {
  const dir = opts.dir ?? join(tmpdir(), 'claudinei-check')
  const ttlMs = opts.ttlMs ?? CHECK_SHOT_TTL_MS
  const now = opts.now ?? Date.now

  function remove(path: string): boolean {
    try { unlinkSync(path); return true } catch { return false }
  }

  /** Apaga as cópias (.png) mais velhas que o ttl; devolve quantas. */
  function sweep(): number {
    let names: string[]
    try { names = readdirSync(dir) } catch { return 0 }
    const limit = now() - ttlMs
    let n = 0
    for (const name of names) {
      if (!name.endsWith('.png')) continue
      const path = join(dir, name)
      try {
        const st = statSync(path)
        if (st.isFile() && st.mtimeMs < limit && remove(path)) n++
      } catch { /* sumiu no meio: nada a fazer */ }
    }
    return n
  }

  function save(png: Buffer): string {
    sweep()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `check-${randomBytes(8).toString('hex')}.png`)
    writeFileSync(path, png, { mode: 0o600 })
    setTimeout(() => { remove(path) }, ttlMs).unref()
    return path
  }

  return { save, sweep }
}
