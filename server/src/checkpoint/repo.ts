import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { git } from './git.js'

/**
 * O repositório de uma pasta. A unidade do retrato é o repositório, não o
 * terminal: `/repo` e `/repo/server` resolvem para o mesmo `top` e a mesma chave.
 * Worktrees ligados têm topo, gitDir e chave próprios e dividem o commonDir.
 */
export interface RepoInfo {
  /** Caminho real (realpath) do topo da árvore de trabalho. */
  top: string
  /** Pasta git deste worktree (onde ficam index e claudinei-index). */
  gitDir: string
  /** Pasta git comum (objetos e refs), a mesma entre worktrees ligados. */
  commonDir: string
  /** 16 primeiros hexadecimais do sha1 de `top`. */
  key: string
}

export function repoKeyOf(top: string): string {
  return createHash('sha1').update(top).digest('hex').slice(0, 16)
}

/** null: fora de git, repo bare, pasta inexistente ou git ausente. */
export async function resolveRepo(path: string): Promise<RepoInfo | null> {
  try {
    const res = await git(path, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { allowFail: true })
    // Bare e pasta fora de git: o --show-toplevel falha.
    if (res.code !== 0) return null
    const lines = res.stdout.toString('utf8').replace(/\n$/, '').split('\n')
    if (lines.length !== 3 || lines.some(l => l === '')) return null
    const [rawTop, rawGitDir, rawCommon] = lines
    // O --git-common-dir pode vir relativo à pasta consultada.
    const [top, gitDir, commonDir] = await Promise.all([
      realpath(rawTop), realpath(rawGitDir), realpath(resolve(path, rawCommon)),
    ])
    return { top, gitDir, commonDir, key: repoKeyOf(top) }
  } catch {
    return null
  }
}

/**
 * Cache de resolveRepo por pasta. `get` resolve de novo depois de `ttlMs`;
 * chamadas simultâneas na mesma pasta dividem a mesma resolução. `peek` é
 * síncrono, para o caminho do envio: devolve o último resultado conhecido
 * (mesmo vencido) ou undefined se a pasta nunca foi resolvida.
 */
export function createRepoResolver(ttlMs = 60_000) {
  const cache = new Map<string, { value: RepoInfo | null; at: number }>()
  const pending = new Map<string, Promise<RepoInfo | null>>()

  function get(path: string): Promise<RepoInfo | null> {
    const hit = cache.get(path)
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value)
    const running = pending.get(path)
    if (running) return running
    const job = resolveRepo(path).then(value => {
      cache.set(path, { value, at: Date.now() })
      return value
    }).finally(() => pending.delete(path))
    pending.set(path, job)
    return job
  }

  function peek(path: string): RepoInfo | null | undefined {
    return cache.get(path)?.value
  }

  return { get, peek }
}
