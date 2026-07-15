import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, extname } from 'node:path'

const MAX_NAME = 80

/** Mantém só [a-zA-Z0-9._-]; remove '..'; trunca preservando a extensão; vazio → 'arquivo'. */
export function sanitizeName(name: string): string {
  let clean = name.replace(/\.\./g, '').replace(/[^a-zA-Z0-9._-]/g, '_')
  clean = clean.replace(/^[._]+/, '') // não começa com ponto (arquivo oculto) nem _
  if (!clean) return 'arquivo'
  if (clean.length > MAX_NAME) {
    const ext = extname(clean)
    clean = clean.slice(0, MAX_NAME - ext.length) + ext
  }
  return clean
}

/** Próximo prefixo NNN- (maior existente + 1, mínimo 001), zero-padded a 3. */
function nextPrefix(dir: string): string {
  let max = 0
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(\d+)-/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return String(max + 1).padStart(3, '0')
}

export async function saveUpload(
  dir: string,
  name: string,
  stream: NodeJS.ReadableStream,
): Promise<{ path: string; name: string }> {
  mkdirSync(dir, { recursive: true })
  // 'wx' é exclusivo: se dois uploads concorrentes calcularem o mesmo NNN,
  // o segundo recebe EEXIST e recalcula — nunca sobrescreve o primeiro.
  // A reserva do nome (openSync) acontece ANTES de qualquer leitura da
  // stream, então o retry nunca toca uma stream já parcialmente consumida.
  for (;;) {
    const finalName = `${nextPrefix(dir)}-${sanitizeName(name)}`
    const path = join(dir, finalName)
    let fd: number
    try {
      fd = openSync(path, 'wx') // reserva o nome atomicamente
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      continue // outro upload pegou este NNN: recalcula
    }
    closeSync(fd)
    await pipeline(stream, createWriteStream(path)) // agora o nome é nosso
    return { path, name: finalName }
  }
}

/** Rotação global: mantém só os `keep` mais novos por mtime. */
export function rotateUploads(dir: string, keep = 100): void {
  if (!existsSync(dir)) return
  const files: Array<{ f: string; mtime: number }> = []
  for (const f of readdirSync(dir)) {
    try { files.push({ f, mtime: statSync(join(dir, f)).mtimeMs }) } catch { /* sumiu no meio: ignora */ }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const { f } of files.slice(keep)) {
    try { unlinkSync(join(dir, f)) } catch { /* sumiu no meio: ok */ }
  }
}
