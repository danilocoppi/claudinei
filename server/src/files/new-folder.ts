import { mkdirSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Teto do nome da pasta nova — folgado para nomes reais, longe do limite do sistema. */
const NAME_MAX = 120

/**
 * O nome de uma pasta nova, ou null se ele não for só um nome. Separador, `.` e
 * `..` levariam a criação para fora da pasta-base escolhida; o caractere nulo
 * corta o caminho no meio. Espaços nas bordas saem — o resto (acento, espaço,
 * ponto no meio) é nome legítimo.
 */
export function folderNameOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name.length > NAME_MAX || name === '.' || name === '..') return null
  if (/[/\\\0]/.test(name)) return null
  return name
}

/**
 * Cria `base/name` e entrega o caminho a `use`. Se `use` falhar, a pasta recém-
 * criada sai junto — um terminal recusado não pode deixar pasta órfã.
 *
 * O `mkdirSync` SEM `recursive` é quem garante que a pasta é nova: se ela já
 * existe, a criação falha com EEXIST e nada do que está lá é tocado.
 */
export function withNewFolder<T>(base: string, name: string, use: (path: string) => T): T {
  let isDir = false
  try { isDir = statSync(base).isDirectory() } catch { /* não existe */ }
  if (!isDir) throw new Error(`a pasta-base não existe: ${base}`)
  const path = join(base, name)
  try {
    mkdirSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw Object.assign(new Error(`a pasta já existe: ${path}`), { code: 'EEXIST' })
    }
    throw err
  }
  try {
    return use(path)
  } catch (err) {
    try { rmdirSync(path) } catch { /* já não está vazia: fica */ }
    throw err
  }
}
