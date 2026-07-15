import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * O binário da engine existe e é executável? Caminho com '/' é checado direto;
 * nome nu é procurado no PATH (mesma resolução que o spawn fará). Nunca lança.
 */
export function binAvailable(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!bin) return false
  if (bin.includes('/')) {
    try { accessSync(bin, constants.X_OK); return true } catch { return false }
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try { accessSync(join(dir, bin), constants.X_OK); return true } catch { /* próximo dir */ }
  }
  return false
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
