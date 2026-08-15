import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** Nomes a testar para `bin`. No Windows o executável mora com extensão
 *  (`claude.exe`), e é o PATHEXT que diz quais valem; '' vem primeiro para o
 *  caso de o chamador já ter passado o nome completo. Fora do Windows, só o nome. */
function candidates(bin: string, env: NodeJS.ProcessEnv): string[] {
  if (!WINDOWS) return [bin]
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return ['', ...exts].map((ext) => bin + ext)
}

/** Já é um caminho (não um nome nu a procurar no PATH)? No Windows o separador
 *  é a barra invertida — checar só '/' deixava `C:\...\claude.exe` cair na busca
 *  por PATH e nunca ser encontrado. */
function isPath(bin: string): boolean {
  return bin.includes('/') || (WINDOWS && (bin.includes('\\') || isAbsolute(bin)))
}

/**
 * Caminho executável de `bin`, ou null se não der para executá-lo.
 * Caminho é checado direto; nome nu é procurado no PATH (mesma resolução que o
 * spawn fará). Nunca lança.
 */
export function resolveBin(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!bin) return null
  if (isPath(bin)) {
    for (const candidate of candidates(bin, env)) {
      try { accessSync(candidate, constants.X_OK); return candidate } catch { /* próximo */ }
    }
    return null
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const candidate of candidates(bin, env)) {
      const full = join(dir, candidate)
      try { accessSync(full, constants.X_OK); return full } catch { /* próximo */ }
    }
  }
  return null
}

/** O binário da engine existe e é executável? */
export function binAvailable(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBin(bin, env) !== null
}

// Cache com TTL curto: o GET /api/engines é chamado no boot da SPA e em re-focos;
// não precisa bater no fs a cada request, mas instalar a CLI deve refletir logo.
const cache = new Map<string, { at: number; ok: boolean }>()
const TTL_MS = 30_000

export function binAvailableCached(bin: string): boolean {
  const hit = cache.get(bin)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok
  const ok = binAvailable(bin)
  cache.set(bin, { at: Date.now(), ok })
  return ok
}
