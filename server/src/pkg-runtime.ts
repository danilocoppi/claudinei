import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Rodando de dentro de um binário @yao-pkg/pkg? */
export function isPackaged(): boolean {
  return typeof (process as unknown as { pkg?: unknown }).pkg !== 'undefined'
}

/** Pasta de cache versionada p/ os nativos extraídos (respeita XDG_CACHE_HOME,
 *  fallback os.tmpdir()), versionada p/ invalidar no bump. */
export function cacheRoot(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || tmpdir()
  return join(base, 'claudinei', `native-${version}`)
}

/** Copia recursivo via read/write (copyFileSync pode não ler o snapshot do pkg);
 *  pula arquivos que já existem (idempotente / re-run barato). */
export function extractTree(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name)
    const d = join(destDir, name)
    if (statSync(s).isDirectory()) extractTree(s, d)
    else if (!existsSync(d)) writeFileSync(d, readFileSync(s))
  }
}

/** Id do build gravado pelo empacotador (scripts/package.mjs) em assets/build-id.
 *  É a chave de invalidação do cache: sem ela, um rebuild SEM bump de versão
 *  reusaria a extração antiga (extractTree pula existentes) e a UI nunca
 *  atualizaria — bug real: index.html velho apontando pro bundle antigo. */
export function buildIdOf(snapshotAssets: string): string | null {
  try {
    const raw = readFileSync(join(snapshotAssets, 'build-id'), 'utf8').trim()
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
    return safe || null
  } catch {
    return null
  }
}

/** No 1º run extrai assets/native e assets/web do snapshot p/ o cache; devolve
 *  os caminhos reais + o LD_LIBRARY_PATH (stdcxx + dir do sherpa). O cache é
 *  chaveado pelo build-id do snapshot (fallback: version) — cada `npm run
 *  package` extrai num dir NOVO e os caches de builds anteriores são podados.
 *  Dentro do MESMO build, extractTree pula os existentes (re-run barato). */
export function ensureNativeCache(opts: { snapshotAssets: string; version: string }): { nativeDir: string; webDir: string; ldPath: string } {
  const root = cacheRoot(buildIdOf(opts.snapshotAssets) ?? opts.version)
  const nativeDir = join(root, 'native')
  const webDir = join(root, 'web')
  extractTree(join(opts.snapshotAssets, 'native'), nativeDir)
  extractTree(join(opts.snapshotAssets, 'web'), webDir)
  // Poda os caches de builds anteriores (melhor esforço): sem isto eles acumulam
  // no tmp/XDG_CACHE a cada rebuild. O binário em execução não depende deles —
  // .so já carregadas sobrevivem ao unlink no Linux.
  try {
    const parent = dirname(root)
    for (const n of readdirSync(parent)) {
      const p = join(parent, n)
      if (n.startsWith('native-') && p !== root) rmSync(p, { recursive: true, force: true })
    }
  } catch { /* melhor esforço */ }
  const stdcxx = join(nativeDir, 'stdcxx', 'lib')
  // o dir do sherpa é o que contém sherpa-onnx.node (nome do pacote por plataforma)
  const sherpaDir = readdirSync(nativeDir)
    .map((n) => join(nativeDir, n))
    .find((p) => existsSync(join(p, 'sherpa-onnx.node'))) ?? nativeDir
  return { nativeDir, webDir, ldPath: `${stdcxx}:${sherpaDir}` }
}

/** Re-exec único do próprio binário com o LD_LIBRARY_PATH certo (o dlopen das .so
 *  exige o env no arranque do processo). No-op se já está no env. */
export function reexecIfNeeded(ldPath: string): void {
  if ((process.env.LD_LIBRARY_PATH || '').includes(ldPath.split(':')[1] ?? ldPath)) return
  process.env.LD_LIBRARY_PATH = `${ldPath}:${process.env.LD_LIBRARY_PATH || ''}`
  execFileSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env })
  process.exit(0)
}
