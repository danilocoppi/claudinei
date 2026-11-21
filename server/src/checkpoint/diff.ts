import { git, splitZ } from './git.js'
import type { RepoInfo } from './repo.js'
import type { UntrackedEntry } from './snapshot.js'

/**
 * O que mudou entre dois marcos, e o diff de um arquivo.
 *
 * Só leitura na pasta do operador (`diff-tree`, `diff`, `cat-file`). A config
 * dele não pode mudar a saída nem rodar programas: diff externo, textconv,
 * cor, prefixos (`diff.noprefix`, `diff.mnemonicPrefix`), contexto e o
 * `ignore` de submódulos são fixados na linha de comando. Caminhos vão sempre
 * depois de `--`, e o GIT_LITERAL_PATHSPECS do git() faz deles nomes literais;
 * as listas saem com `-z`, então espaço, acento, tab e aspas não atrapalham.
 */

export type FileStatus = 'added' | 'modified' | 'deleted' | 'mode' | 'submodule' | 'too_big' | 'unsnapshotted'

export interface FileChange {
  path: string
  status: FileStatus
  /** Linhas acrescentadas (numstat); 0 em binário, submódulo, too_big e unsnapshotted. */
  added: number
  removed: number
  binary: boolean
  /** too_big e unsnapshotted: tamanho em bytes, quando conhecido. */
  size?: number
}

/** O lado de um marco no diff: o commit e o que ficou fora dele. */
export interface MarkSide { commit: string; big: UntrackedEntry[]; listing: UntrackedEntry[] | null }

export interface FileDiff { path: string; binary: boolean; sizeKb?: number; text: string; truncated: boolean }

export const DIFF_MAX_LINES = 2000

const GITLINK = '160000'
const EXEC_BITS = new Set(['100644', '100755'])
// Hash de objeto (sha1 ou sha256). Nada que o git possa ler como opção ou revisão.
const HASH = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

// Opções de toda saída de diff: nenhum programa do operador roda e a forma não depende da config dele.
const DIFF_SAFE = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=none']

function assertHash(commit: string): void {
  if (!HASH.test(commit)) throw new Error(`commit inválido: ${JSON.stringify(commit)}`)
}

interface RawEntry {
  path: string
  srcMode: string
  dstMode: string
  dstSha: string
  srcSha: string
  /** A, D, M ou T (troca de tipo: arquivo ↔ link ↔ submódulo). */
  letter: string
  added: number
  removed: number
  binary: boolean
}

/**
 * Lê a saída de `diff-tree -r -z --no-renames --raw --numstat`: primeiro os
 * registros raw (`:<modo> <modo> <sha> <sha> <letra>` NUL `<caminho>` NUL),
 * depois os do numstat (`<+>\t<−>\t<caminho>` NUL), sem separador entre os dois
 * blocos. O caminho vem sempre depois de um registro raw, então um nome que
 * começa com `:` não se confunde; no numstat, o caminho é o que sobra depois
 * dos dois primeiros tabs (pode ter tab). Binário tem `-\t-`.
 */
export function parseRawNumstat(buf: Buffer): RawEntry[] {
  const tokens = splitZ(buf)
  const entries = new Map<string, RawEntry>()
  const order: RawEntry[] = []
  let i = 0
  while (i < tokens.length && tokens[i].startsWith(':')) {
    const [srcMode, dstMode, srcSha, dstSha, status] = tokens[i].slice(1).split(' ')
    const path = tokens[i + 1]
    if (path === undefined || status === undefined) throw new Error(`saída inesperada do diff-tree: ${JSON.stringify(tokens[i])}`)
    const entry: RawEntry = { path, srcMode, dstMode, srcSha, dstSha, letter: status[0], added: 0, removed: 0, binary: false }
    entries.set(path, entry)
    order.push(entry)
    i += 2
  }
  for (; i < tokens.length; i++) {
    const tok = tokens[i]
    const t1 = tok.indexOf('\t')
    const t2 = t1 < 0 ? -1 : tok.indexOf('\t', t1 + 1)
    if (t2 < 0) throw new Error(`saída inesperada do numstat: ${JSON.stringify(tok)}`)
    const entry = entries.get(tok.slice(t2 + 1))
    if (!entry) continue
    const a = tok.slice(0, t1)
    const r = tok.slice(t1 + 1, t2)
    // Somado: se o git partir uma troca de tipo em duas linhas, o total segue certo.
    if (a === '-' || r === '-') entry.binary = true
    else {
      entry.added += Number(a)
      entry.removed += Number(r)
    }
  }
  return order
}

async function rawDiff(repo: RepoInfo, from: string, to: string, paths: string[] = []): Promise<RawEntry[]> {
  const args = ['diff-tree', '-r', '-z', '--raw', '--numstat', ...DIFF_SAFE, from, to]
  if (paths.length) args.push('--', ...paths)
  const res = await git(repo.top, args)
  return parseRawNumstat(res.stdout)
}

function toChange(e: RawEntry): FileChange {
  if (e.srcMode === GITLINK || e.dstMode === GITLINK) {
    return { path: e.path, status: 'submodule', added: 0, removed: 0, binary: false }
  }
  let status: FileStatus
  if (e.letter === 'A') status = 'added'
  else if (e.letter === 'D') status = 'deleted'
  else if (e.srcSha === e.dstSha && e.srcMode !== e.dstMode && EXEC_BITS.has(e.srcMode) && EXEC_BITS.has(e.dstMode)) status = 'mode'
  else status = 'modified'
  return { path: e.path, status, added: e.added, removed: e.removed, binary: e.binary }
}

function index(list: UntrackedEntry[] | null): Map<string, UntrackedEntry> {
  return new Map((list ?? []).map(e => [e.path, e]))
}

function differs(a: UntrackedEntry, b: UntrackedEntry): boolean {
  return a.size !== b.size || a.mtimeMs !== b.mtimeMs
}

async function treePaths(repo: RepoInfo, commit: string): Promise<Set<string>> {
  const res = await git(repo.top, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit])
  return new Set(splitZ(res.stdout))
}

/**
 * Arquivos que mudaram entre dois marcos. Além do diff-tree, cruza o que ficou
 * fora dos commits (`big` e, no modo limitado, `listing`) dos dois lados:
 *
 * - solto grande (`to.big`) ausente antes, ou com tamanho/data diferente, vira
 *   `too_big` com o tamanho. Se ele era pequeno e estava no retrato de antes, o
 *   diff-tree o dá como apagado; vale o `too_big` (desfazer apagaria o grande);
 * - grande de antes (`from.big`) que sumiu ou encolheu (para dentro do retrato
 *   ou, no modo limitado, fora dele) também é `too_big`, com o tamanho de
 *   antes: o "antes" não tem retrato, e desfazer apagaria um arquivo que existia;
 * - solto das duas listagens do modo limitado, fora dos dois commits, com
 *   tamanho/data diferente, vira `unsnapshotted`;
 * - solto antigo que entra no retrato quando o modo limitado acaba aparece no
 *   diff-tree como criado; como existia antes (está em `from.listing`), vira
 *   `unsnapshotted`, nunca `added` (desfazer o apagaria).
 */
export async function changedFiles(repo: RepoInfo, from: MarkSide, to: MarkSide): Promise<FileChange[]> {
  assertHash(from.commit)
  assertHash(to.commit)
  const raw = from.commit === to.commit ? [] : await rawDiff(repo, from.commit, to.commit)
  const fromBig = index(from.big)
  const toBig = index(to.big)
  const fromListing = index(from.listing)
  const toListing = index(to.listing)

  const inRaw = new Set(raw.map(e => e.path))
  const out = new Map<string, FileChange>()
  for (const e of raw) {
    const prevBig = fromBig.get(e.path)
    if (toBig.has(e.path)) continue // decidido abaixo, pelo lado dos grandes
    if (prevBig) {
      out.set(e.path, { path: e.path, status: 'too_big', added: 0, removed: 0, binary: false, size: prevBig.size })
      continue
    }
    const prevListed = fromListing.get(e.path)
    if (e.letter === 'A' && prevListed) {
      const size = toListing.get(e.path)?.size
      out.set(e.path, { path: e.path, status: 'unsnapshotted', added: 0, removed: 0, binary: false, ...(size !== undefined ? { size } : {}) })
      continue
    }
    out.set(e.path, toChange(e))
  }

  // Grandes de agora: novos ou mudados.
  for (const now of to.big) {
    const before = fromBig.get(now.path) ?? fromListing.get(now.path)
    if (before && !differs(before, now) && !inRaw.has(now.path)) continue
    out.set(now.path, { path: now.path, status: 'too_big', added: 0, removed: 0, binary: false, size: now.size })
  }

  // Grandes de antes que deixaram de ser grandes sem aparecer no diff-tree:
  // apagados, agora ignorados, ou encolhidos fora do retrato (modo limitado).
  const gone = from.big.filter(e => !toBig.has(e.path) && !inRaw.has(e.path))
  // Os soltos das duas listagens que mudaram, fora do diff-tree e dos grandes.
  const listed = from.listing && to.listing
    ? to.listing.filter(now => {
      const before = fromListing.get(now.path)
      return before && differs(before, now) && !toBig.has(now.path) && !fromBig.has(now.path) && !inRaw.has(now.path)
    })
    : []
  if (gone.length || listed.length) {
    // Quem está no commit de agora e não mudou no diff-tree não é "sem retrato".
    const inTree = await treePaths(repo, to.commit)
    for (const e of gone) {
      if (inTree.has(e.path)) continue
      out.set(e.path, { path: e.path, status: 'too_big', added: 0, removed: 0, binary: false, size: e.size })
    }
    for (const e of listed) {
      if (inTree.has(e.path)) continue
      out.set(e.path, { path: e.path, status: 'unsnapshotted', added: 0, removed: 0, binary: false, size: e.size })
    }
  }

  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Corta o texto em `max` linhas. */
function cutLines(text: string, max: number): { text: string; truncated: boolean } {
  let pos = 0
  for (let n = 0; n < max; n++) {
    const nl = text.indexOf('\n', pos)
    if (nl < 0) return { text, truncated: false }
    pos = nl + 1
  }
  if (pos >= text.length) return { text, truncated: false }
  return { text: text.slice(0, pos), truncated: true }
}

/**
 * Diff unificado (-U3) de um arquivo entre dois commits, cortado em `maxLines`
 * linhas. Binário não tem texto: vem `sizeKb`, do lado novo (ou do antigo, se o
 * arquivo foi apagado), arredondado para cima. Arquivo sem mudança: texto vazio.
 */
export async function fileDiff(
  repo: RepoInfo, fromCommit: string, toCommit: string, path: string, maxLines = DIFF_MAX_LINES,
): Promise<FileDiff> {
  assertHash(fromCommit)
  assertHash(toCommit)
  const [entry] = fromCommit === toCommit ? [] : await rawDiff(repo, fromCommit, toCommit, [path])
  if (!entry || entry.path !== path) return { path, binary: false, text: '', truncated: false }
  if (entry.binary) {
    const sha = /^0+$/.test(entry.dstSha) ? entry.srcSha : entry.dstSha
    const res = await git(repo.top, ['cat-file', '-s', sha])
    const bytes = Number(res.stdout.toString('utf8').trim())
    return { path, binary: true, sizeKb: Math.ceil(bytes / 1024), text: '', truncated: false }
  }
  const res = await git(repo.top, [
    'diff', ...DIFF_SAFE, '-U3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/',
    '--submodule=short', '--no-relative', fromCommit, toCommit, '--', path,
  ])
  const { text, truncated } = cutLines(res.stdout.toString('utf8'), maxLines)
  return { path, binary: false, text, truncated }
}

/** O commit do marco ainda existe na base de objetos. false = "retrato perdido". */
export async function commitExists(repo: RepoInfo, commit: string): Promise<boolean> {
  if (!HASH.test(commit)) return false
  const res = await git(repo.top, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true })
  return res.code === 0
}
