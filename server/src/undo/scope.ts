import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileDiff } from '../checkpoint/diff.js'
import type { RepoInfo } from '../checkpoint/repo.js'
import type { FileChange, FileDiff } from '../../../shared/undo.js'

/**
 * A regra única do que cai "dentro do projeto" e do que tem diff. Ela decide o
 * que quem não é administrador pode ver; por isso serviço, atribuição e
 * conjunto (index.ts) importam daqui, e não há uma segunda cópia.
 */

/** Sem retrato do conteúdo: aparecem na prévia, sem desfazer, e o diff vem vazio. */
export const NOT_UNDOABLE: ReadonlySet<FileChange['status']> = new Set<FileChange['status']>(['too_big', 'unsnapshotted', 'submodule'])

/** Projeto fora do topo do repositório: nenhum caminho cai "dentro" dele. */
export const NOWHERE = '\0fora'

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || 'erro desconhecido'

/** O caminho absoluto cai dentro do topo (para pasta que o resolver ainda não viu). */
export function underTop(path: string, top: string): boolean {
  const abs = resolve(path)
  return abs === top || abs.startsWith(top + sep)
}

/**
 * O caminho (relativo ao topo) cai na pasta do projeto. `projectRel` vazio, `.`
 * ou `./` é o repositório inteiro; barras finais e `./` no começo não contam.
 */
export function inProjectOf(projectRel: string): (path: string) => boolean {
  let base = projectRel.replace(/\/+$/, '')
  if (base.startsWith('./')) base = base.slice(2)
  if (!base || base === '.') return () => true
  return path => path === base || path.startsWith(`${base}/`)
}

/** A pasta do projeto relativa ao topo (caminho real, com `/`), `''` no topo, ou NOWHERE se cai fora. */
export async function projectRelOf(repo: RepoInfo, projectPath: string): Promise<string> {
  const real = await realpath(projectPath).catch(() => resolve(projectPath))
  const rel = relative(repo.top, real)
  if (!rel) return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return NOWHERE
  return sep === '/' ? rel : rel.split(sep).join('/')
}

/** O diff de uma mudança entre dois commits; sem retrato do conteúdo, diff sem texto (a tela mostra o selo). */
export function changeDiff(repo: RepoInfo, change: Pick<FileChange, 'path' | 'status'>, fromCommit: string, toCommit: string): Promise<FileDiff> {
  if (NOT_UNDOABLE.has(change.status)) return Promise.resolve({ path: change.path, binary: false, text: '', truncated: false })
  return fileDiff(repo, fromCommit, toCommit, change.path)
}
