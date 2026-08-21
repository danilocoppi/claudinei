import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ORIG_LD } from './localApps.js'

/** Rodando de dentro de um binário @yao-pkg/pkg? */
export function isPackaged(): boolean {
  return typeof (process as unknown as { pkg?: unknown }).pkg !== 'undefined'
}

/** Pasta de cache versionada p/ os nativos extraídos. Respeita XDG_CACHE_HOME;
 *  sem ele, ~/.cache (fallback da spec XDG) — /tmp quebraria com noexec e é
 *  plantável em máquina multiusuário. os.tmpdir() só como último recurso, se
 *  não houver home utilizável. Versionada p/ invalidar no bump. */
export function cacheRoot(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir()
  const base = env.XDG_CACHE_HOME || (home ? join(home, '.cache') : tmpdir())
  return join(base, 'claudinei', `native-${version}`)
}

/** Copia recursivo via read/write (copyFileSync pode não ler o snapshot do pkg);
 *  pula arquivos que já existem (idempotente / re-run barato). Escreve num .tmp
 *  e renomeia (atômico no mesmo fs) — um processo concorrente nunca vê arquivo
 *  parcialmente escrito. */
export function extractTree(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name)
    const d = join(destDir, name)
    if (statSync(s).isDirectory()) extractTree(s, d)
    else if (!existsSync(d)) {
      const tmp = `${d}.tmp-${process.pid}`
      writeFileSync(tmp, readFileSync(s))
      renameSync(tmp, d)
    }
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
  // no XDG_CACHE a cada rebuild. Só dirs com mtime > 7 dias — uma instância
  // antiga ainda rodando pode spawnar o worker de voz depois, com NODE_PATH
  // apontando pro cache dela (deletar cache recente quebraria esse spawn).
  try {
    const parent = dirname(root)
    const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const n of readdirSync(parent)) {
      const p = join(parent, n)
      if (!n.startsWith('native-') || p === root) continue
      try {
        if (statSync(p).mtimeMs < cutoffMs) rmSync(p, { recursive: true, force: true })
      } catch { /* melhor esforço */ }
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
 *  exige o env no arranque do processo). No-op se TODAS as entradas de ldPath já
 *  estão presentes como entradas exatas (substring match daria falso positivo). */
export function reexecIfNeeded(ldPath: string): void {
  const current = (process.env.LD_LIBRARY_PATH || '').split(':').filter(Boolean)
  const wanted = ldPath.split(':').filter(Boolean)
  if (wanted.every((dir) => current.includes(dir))) return
  // Guarda o valor de ANTES. Quem abre um app do desktop (localApps.ts) precisa
  // devolver a ele o ambiente do SISTEMA: o libstdc++ portátil que carregamos aqui
  // é mais velho que o do sistema, e um app gráfico que herde este caminho morre
  // no arranque — foi assim que "Abrir terminal" virou um botão que não fazia nada.
  process.env[ORIG_LD] = process.env.LD_LIBRARY_PATH ?? ''
  process.env.LD_LIBRARY_PATH = `${ldPath}:${process.env.LD_LIBRARY_PATH || ''}`
  execFileSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env })
  process.exit(0)
}
