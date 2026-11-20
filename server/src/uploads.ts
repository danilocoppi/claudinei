import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, extname, resolve, sep } from 'node:path'

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

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_AGE_MS = 30 * DAY_MS // anexo vive 30 dias: um rascunho guardado ainda acha o arquivo
const HARD_CAP = 5000 // teto de segurança contra disco cheio, não a regra do dia a dia

/**
 * Rotação por idade: apaga o que tem mtime anterior a `now - maxAgeMs` (padrão
 * 30 dias). Se ainda sobrar mais que `hardCap` (padrão 5000), apaga os mais
 * velhos excedentes.
 */
export function rotateUploads(
  dir: string,
  opts: { maxAgeMs?: number; hardCap?: number; now?: number } = {},
): void {
  if (!existsSync(dir)) return
  const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS
  const hardCap = opts.hardCap ?? HARD_CAP
  const cutoff = (opts.now ?? Date.now()) - maxAgeMs
  const kept: Array<{ f: string; mtime: number }> = []
  for (const f of readdirSync(dir)) {
    let mtime: number
    try { mtime = statSync(join(dir, f)).mtimeMs } catch { continue /* sumiu no meio: ignora */ }
    if (mtime < cutoff) {
      try { unlinkSync(join(dir, f)) } catch { /* sumiu no meio: ok */ }
    } else {
      kept.push({ f, mtime })
    }
  }
  if (kept.length <= hardCap) return
  kept.sort((a, b) => b.mtime - a.mtime) // mais novos primeiro
  for (const { f } of kept.slice(hardCap)) {
    try { unlinkSync(join(dir, f)) } catch { /* sumiu no meio: ok */ }
  }
}

/**
 * Devolve, na ordem recebida, os caminhos que não existem. Caminho que resolve
 * fora de `dir` conta como ausente sem tocar o disco: a checagem não serve para
 * sondar o resto do sistema de arquivos.
 */
export function missingUploads(dir: string, paths: string[]): string[] {
  const root = resolve(dir) + sep
  return paths.filter((p) => {
    const abs = resolve(dir, p)
    if (!abs.startsWith(root)) return true
    return !existsSync(abs)
  })
}
