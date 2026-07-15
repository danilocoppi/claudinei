import { realpathSync, statSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'
import { homedir } from 'node:os'

export type FileKind = 'image' | 'pdf' | 'markdown' | 'code' | 'text' | 'binary'
export interface ScopeResult { path: string; exists: boolean; inScope: boolean; kind?: FileKind; size?: number; real?: string }

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico'])
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.java', '.c', '.h', '.cpp', '.cc', '.cs', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.sql', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.css', '.scss', '.less', '.html', '.xml', '.vue', '.svelte'])
const TEXT = new Set(['.txt', '.log', '.csv', '.tsv', '.env', '.gitignore', '.diff', '.patch', '.text'])

export function kindOf(p: string): FileKind {
  const e = extname(p).toLowerCase()
  if (IMAGE.has(e)) return 'image'
  if (e === '.pdf') return 'pdf'
  if (e === '.md' || e === '.markdown') return 'markdown'
  if (CODE.has(e)) return 'code'
  if (TEXT.has(e) || e === '') return 'text'
  return 'binary'
}

// ~ e relativo → absoluto; relativo sem projeto → null (não resolve)
function toAbsolute(raw: string, projectPath: string | null): string | null {
  let p = raw.trim()
  if (!p) return null
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1)
  if (p.startsWith('/')) return resolve(p)
  if (!projectPath) return null
  return resolve(projectPath, p)
}

/**
 * Resolve um path pedido e decide se está no ESCOPO permitido. Fonte única de verdade
 * de segurança (usada por resolve e content). Usa realpath (segue symlink) e checa que
 * o arquivo real está sob a raiz real do projeto — barra traversal e symlink pra fora.
 *
 * Quando inScope é true, `real` traz o realpath do arquivo (pós-symlink) para que rotas
 * futuras (ex.: content) possam ler o arquivo direto sem re-derivar/normalizar o path.
 */
export function resolveInScope(raw: string, project: { id: number; path: string } | null, isAdmin: boolean): ScopeResult {
  const abs = toAbsolute(raw, project?.path ?? null)
  if (!abs) return { path: raw, exists: false, inScope: false }
  let realFile: string
  let st: ReturnType<typeof statSync>
  try { realFile = realpathSync(abs); st = statSync(realFile) } catch { return { path: raw, exists: false, inScope: false } }
  if (!st.isFile()) return { path: raw, exists: true, inScope: false }
  let inScope = isAdmin
  if (!inScope && project) {
    try {
      const realRoot = realpathSync(project.path)
      inScope = realFile === realRoot || realFile.startsWith(realRoot + sep)
    } catch { inScope = false }
  }
  return {
    path: raw,
    exists: true,
    inScope,
    kind: inScope ? kindOf(realFile) : undefined,
    size: inScope ? st.size : undefined,
    real: inScope ? realFile : undefined,
  }
}
