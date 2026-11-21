import { copyFile, lstat, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { git, splitZ } from './git.js'
import type { RepoInfo } from './repo.js'

/**
 * O marco (retrato) de um repositório: um commit sem pai com o estado da
 * árvore de trabalho, guardado numa ref oculta `refs/claudinei/<chave>/<n>`.
 *
 * Nada aqui escreve no índice, no stash, no HEAD ou nos branches do operador.
 * O retrato usa um índice próprio (`<gitDir>/claudinei-index`, semeado com uma
 * cópia do índice do operador para o git só reler o que mudou); o índice do
 * operador só é lido (`ls-files`, com GIT_OPTIONAL_LOCKS=0 vindo do git()).
 */

export const SNAPSHOT_LIMITS = {
  /** Solto (não rastreado e não ignorado) acima disto fica fora do retrato. */
  untrackedMaxBytes: 2 * 1024 * 1024,
  /** Acima disto de soltos, o retrato é limitado. */
  limitedFiles: 5000,
  /** Acima disto somado nos soltos, o retrato é limitado. */
  limitedBytes: 200 * 1024 * 1024,
}

export interface UntrackedEntry { path: string; size: number; mtimeMs: number }

export interface Snapshot {
  ref: string
  commit: string
  /** Commit do HEAD do operador; null em repositório sem commit. */
  head: string | null
  /** Branch do HEAD; null com HEAD destacado e em repositório sem commit. */
  branch: string | null
  mode: 'full' | 'limited'
  /** Soltos acima do limite, fora do retrato (nos dois modos). */
  big: UntrackedEntry[]
  /** Modo limitado: a lista inteira dos soltos (inclusive os grandes). Completo: null. */
  listing: UntrackedEntry[] | null
}

const OWN_INDEX = 'claudinei-index'
const REF_PREFIX = 'refs/claudinei/'
// Lock do índice próprio mais velho que isto é de um marco que morreu no meio
// (o git() mata em 60 s; o processo inteiro pode ter caído).
const STALE_LOCK_MS = 10 * 60 * 1000
// Nenhum hook do operador roda: post-index-change dispara em toda escrita de
// índice e reference-transaction em todo update-ref (ferramentas como o
// git-branchless gravam estado em .git a cada chamada, e um hook lento come o
// tempo limite do git()).
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']
// Nos comandos que escrevem o índice próprio, além disso, ele nunca fica
// dividido, preso a um sharedindex.* que o git do operador expira.
const OWN_INDEX_CONFIG = [...NO_HOOKS, '-c', 'core.splitIndex=false']
const LSTAT_BATCH = 256

export function refName(key: string, n: number): string {
  return `${REF_PREFIX}${key}/${n}`
}

function nulList(paths: string[]): string {
  return paths.map(p => `${p}\0`).join('')
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code
}

/** Cria o índice próprio com uma cópia do do operador, se ainda não existe. */
async function seedOwnIndex(gitDir: string): Promise<string> {
  const own = join(gitDir, OWN_INDEX)
  try {
    await lstat(own)
    return own
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e
  }
  // Cópia por arquivo temporário e rename: um marco que morra no meio não
  // deixa um índice próprio pela metade.
  const tmp = `${own}.seed-${process.pid}-${Date.now()}`
  try {
    await copyFile(join(gitDir, 'index'), tmp)
    await rename(tmp, own)
  } catch (e) {
    await rm(tmp, { force: true })
    // Sem índice do operador (repo recém-criado): o add cria o próprio.
    if (errCode(e) !== 'ENOENT') throw e
  }
  return own
}

/**
 * Lock do índice próprio deixado por um marco morto travaria todos os
 * seguintes. Os marcos de um repositório rodam um por vez (fila serial), então
 * um lock velho não tem dono vivo; um recente pode ter (outra instância).
 */
async function clearStaleLock(own: string): Promise<void> {
  const lock = `${own}.lock`
  try {
    const st = await lstat(lock)
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true })
  } catch { /* sem lock */ }
}

async function lstatMany(top: string, paths: string[]): Promise<UntrackedEntry[]> {
  const out: UntrackedEntry[] = []
  for (let i = 0; i < paths.length; i += LSTAT_BATCH) {
    const batch = await Promise.all(paths.slice(i, i + LSTAT_BATCH).map(async path => {
      try {
        const st = await lstat(join(top, path))
        return { path, size: st.size, mtimeMs: st.mtimeMs }
      } catch {
        return null // sumiu entre a listagem e o lstat
      }
    }))
    for (const e of batch) if (e) out.push(e)
  }
  return out
}

/** Soltos: não rastreados pelo índice do operador e não ignorados. */
async function listUntracked(top: string): Promise<UntrackedEntry[]> {
  const res = await git(top, ['ls-files', '-o', '--exclude-standard', '-z'])
  // `dir/` é um repositório aninhado que não é submódulo: fica fora.
  const paths = splitZ(res.stdout).filter(p => !p.endsWith('/'))
  return lstatMany(top, paths)
}

async function lsFiles(top: string, indexFile?: string): Promise<Set<string>> {
  const res = await git(top, ['ls-files', '-z'], indexFile ? { indexFile } : {})
  return new Set(splitZ(res.stdout))
}

/**
 * Caminhos do índice próprio e os marcados com assume-unchanged (etiqueta
 * minúscula no `ls-files -v`) ou skip-worktree (`S`, ou `s` com as duas
 * marcas). A semeadura copia essas marcas do índice do operador, e com elas o
 * `add -u` nunca lê o arquivo do disco.
 */
async function lsOwnIndex(top: string, indexFile: string): Promise<{
  paths: Set<string>; assumeUnchanged: string[]; skipWorktree: string[]
}> {
  const res = await git(top, ['ls-files', '-v', '-z'], { indexFile })
  const paths = new Set<string>()
  const assumeUnchanged: string[] = []
  const skipWorktree: string[] = []
  for (const entry of splitZ(res.stdout)) {
    const tag = entry[0]
    const path = entry.slice(2)
    if (paths.has(path)) continue // entrada em conflito aparece uma vez por estágio
    paths.add(path)
    if (tag === 'S' || tag === 's') skipWorktree.push(path)
    else if (tag !== tag.toUpperCase()) assumeUnchanged.push(path)
  }
  return { paths, assumeUnchanged, skipWorktree }
}

/** O caminho existe no disco (arquivo, link ou pasta). */
async function exists(top: string, path: string): Promise<boolean> {
  try {
    await lstat(join(top, path))
    return true
  } catch {
    return false
  }
}

/** O caminho ainda pode ir ao `git add`: existe e, se é pasta, é um submódulo. */
async function addable(top: string, path: string): Promise<boolean> {
  try {
    const st = await lstat(join(top, path))
    if (!st.isDirectory()) return true
    await lstat(join(top, path, '.git'))
    return true
  } catch {
    return false
  }
}

async function filterAddable(top: string, paths: string[]): Promise<string[]> {
  const ok = await Promise.all(paths.map(p => addable(top, p)))
  return paths.filter((_, i) => ok[i])
}

export async function takeSnapshot(
  repo: RepoInfo,
  n: number,
  opts: { previousListing?: UntrackedEntry[] | null; limits?: typeof SNAPSHOT_LIMITS } = {},
): Promise<Snapshot> {
  const limits = opts.limits ?? SNAPSHOT_LIMITS
  const top = repo.top
  const own = await seedOwnIndex(repo.gitDir)
  await clearStaleLock(own)
  const ownGit = (args: string[], input?: string, allowFail = false) =>
    git(top, [...OWN_INDEX_CONFIG, ...args], { indexFile: own, input, allowFail })

  // 1. Soltos, com o índice do operador (só leitura), e o modo.
  const untracked = await listUntracked(top)
  const totalBytes = untracked.reduce((sum, e) => sum + e.size, 0)
  const mode: Snapshot['mode'] =
    untracked.length > limits.limitedFiles || totalBytes > limits.limitedBytes ? 'limited' : 'full'
  const small = untracked.filter(e => e.size <= limits.untrackedMaxBytes)
  const big = untracked.filter(e => e.size > limits.untrackedMaxBytes)
  const smallPaths = new Set(small.map(e => e.path))

  const operatorPaths = await lsFiles(top)
  const ownIndex = await lsOwnIndex(top, own)
  const ownPaths = ownIndex.paths

  // 2. Sai do índice próprio quem não está no do operador nem é solto pequeno:
  // cresceu além do limite, sumiu ou passou a ser ignorado. Vem antes do
  // `add -u` para o git não ler (e gravar na base de objetos) o arquivo grande.
  // No modo limitado, os soltos que já estão no índice próprio continuam: foram
  // criados durante turnos.
  const drop = [...ownPaths].filter(p => !operatorPaths.has(p) && !smallPaths.has(p))
  const dropSet = new Set(drop)
  // Sai também, para voltar no passo 4 sem a marca e com o conteúdo do disco,
  // quem tem assume-unchanged ou skip-worktree no índice próprio. Skip-worktree
  // só se o arquivo existe: num sparse checkout, o ausente fica com o conteúdo
  // que tem, e não vira arquivo apagado. Só o índice próprio perde as marcas.
  const existing = await Promise.all(ownIndex.skipWorktree.map(p => exists(top, p)))
  const unflag = [
    ...ownIndex.assumeUnchanged,
    ...ownIndex.skipWorktree.filter((_, i) => existing[i]),
  ].filter(p => !dropSet.has(p))
  const remove = [...drop, ...unflag]
  if (remove.length) {
    // -f: o conteúdo do índice próprio difere do arquivo e do HEAD (é o caso do
    // solto que cresceu); --sparse: sem ele o git recusa mexer em entrada com
    // skip-worktree; --cached nunca toca a árvore de trabalho.
    await ownGit(['rm', '--cached', '-f', '-q', '--sparse', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], nulList(remove))
    for (const p of remove) ownPaths.delete(p)
  }

  // 3. Atualiza (e remove os apagados) tudo o que já está no índice próprio.
  // --sparse: num sparse checkout, o arquivo fora do cone que existe no disco
  // aparece sem a marca skip-worktree, mas sem --sparse o `add -u` não o lê; o
  // ausente continua com a marca e com o conteúdo que tem.
  await ownGit(['add', '-u', '--sparse'])

  // 4. Acrescenta os soltos pequenos novos e o que o operador pôs no índice
  // dele depois da semeadura. No modo limitado, só os soltos criados desde o
  // marco anterior; sem a lista anterior, nenhum (não dá para saber quais são
  // novos).
  const previous = mode === 'limited' ? new Set((opts.previousListing ?? []).map(e => e.path)) : null
  const fresh = mode === 'limited' && !opts.previousListing
    ? []
    : small.filter(e => !ownPaths.has(e.path) && !previous?.has(e.path)).map(e => e.path)
  const fromOperator = await filterAddable(top, [...operatorPaths].filter(p => !ownPaths.has(p)))
  const toAdd = [...new Set([...fresh, ...fromOperator, ...await filterAddable(top, unflag)])]
  if (toAdd.length) {
    // -f: o operador pode ter forçado no índice dele um caminho ignorado.
    // --sparse: o caminho pode estar fora do cone de um sparse checkout.
    const args = ['add', '-f', '--sparse', '--pathspec-from-file=-', '--pathspec-file-nul']
    const res = await ownGit(args, nulList(toAdd), true)
    // Algo sumiu entre a listagem e o add: de novo, só com o que existe.
    if (res.code !== 0) {
      const still = await filterAddable(top, toAdd)
      if (still.length) await ownGit(args, nulList(still))
    }
  }

  // 5. Tree, commit sem pai e a ref oculta. Submódulo entra como o commit
  // apontado (é o que o add faz com um gitlink).
  const tree = (await ownGit(['write-tree'])).stdout.toString('utf8').trim()
  const commit = (await git(top, ['commit-tree', '--no-gpg-sign', '-m', `claudinei ${n}`, tree]))
    .stdout.toString('utf8').trim()
  const ref = refName(repo.key, n)
  await git(top, [...NO_HOOKS, '-c', 'core.logAllRefUpdates=false', 'update-ref', ref, commit])

  // 6. HEAD e branch do operador. Repo sem commit: os dois null; HEAD destacado: branch null.
  const headRes = await git(top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true })
  const head = headRes.code === 0 ? headRes.stdout.toString('utf8').trim() : null
  let branch: string | null = null
  if (head) {
    const b = await git(top, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })
    branch = b.code === 0 ? b.stdout.toString('utf8').trim() || null : null
  }

  return { ref, commit, head, branch, mode, big, listing: mode === 'limited' ? untracked : null }
}

// Só as refs do retrato: `refs/claudinei/` seguido de partes simples, sem `..`.
const OUR_REF = /^refs\/claudinei\/[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

function isOurRef(ref: string): boolean {
  return OUR_REF.test(ref) && !ref.includes('..') && !ref.endsWith('.lock') && !ref.endsWith('.')
}

/** Apaga refs do retrato numa transação só. Qualquer ref fora de refs/claudinei/ recusa tudo. */
export async function deleteRefs(repo: RepoInfo, refs: string[]): Promise<void> {
  const bad = refs.find(r => !isOurRef(r))
  if (bad !== undefined) throw new Error(`ref fora de ${REF_PREFIX}: ${JSON.stringify(bad)}`)
  if (!refs.length) return
  await git(repo.top, [...NO_HOOKS, 'update-ref', '--stdin'], { input: refs.map(r => `delete ${r}\n`).join('') })
}
