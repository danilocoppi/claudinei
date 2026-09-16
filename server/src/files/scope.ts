import { realpathSync, statSync } from 'node:fs'
import { resolve, sep, extname, isAbsolute } from 'node:path'
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

// Ex.: projeto /repo/backend + backend/docs/plano.md → /repo/backend/docs/plano.md.
// Só considera componentes completos, usando a maior sobreposição entre o fim
// da base e o começo do relativo. Absolutos, ~ e traversal mantêm seu significado.
function withoutRepeatedBase(raw: string, projectPath: string): string | null {
  const p = raw.trim()
  if (isAbsolute(p) || p === '~' || p.startsWith('~/')) return null
  const parts = p.split(sep).filter((part) => part && part !== '.')
  if (parts.includes('..')) return null
  const base = resolve(projectPath).split(sep).filter(Boolean)
  for (let count = Math.min(base.length, parts.length - 1); count > 0; count--) {
    if (base.slice(-count).every((part, i) => part === parts[i])) {
      return resolve(projectPath, ...parts.slice(count))
    }
  }
  return null
}

/**
 * Resolve um path pedido e decide se está no ESCOPO permitido. Fonte única de verdade
 * de segurança (usada por todas as rotas de arquivo). Usa realpath (segue symlink) e checa que
 * o arquivo real está sob a raiz real do projeto — barra traversal e symlink pra fora.
 *
 * Quando inScope é true, `real` traz o realpath do arquivo (pós-symlink) para que rotas
 * futuras (ex.: content) possam ler o arquivo direto sem re-derivar/normalizar o path.
 */
export function resolveInScope(raw: string, project: { id: number; path: string } | null, isAdmin: boolean): ScopeResult {
  const missing: ScopeResult = { path: raw, exists: false, inScope: false }
  const abs = toAbsolute(raw, project?.path ?? null)
  if (!abs) return missing
  let realFile: string
  let st: ReturnType<typeof statSync>
  let removedBase = false
  try { realFile = realpathSync(abs); st = statSync(realFile) } catch (err) {
    // Arquivos/diretórios existentes e erros de acesso não autorizam trocar o
    // alvo. A alternativa só é tentada quando o caminho original não existe.
    const code = (err as NodeJS.ErrnoException).code
    if (!project || (code !== 'ENOENT' && code !== 'ENOTDIR')) return missing
    const alternative = withoutRepeatedBase(raw, project.path)
    if (!alternative) return missing
    try { realFile = realpathSync(alternative); st = statSync(realFile) } catch { return missing }
    removedBase = true
  }
  if (!st.isFile()) return { path: raw, exists: isAdmin && !removedBase, inScope: false }
  // A base removida é uma inferência: só vale dentro da raiz real do projeto,
  // inclusive para admin. Caminhos explícitos mantêm as permissões anteriores.
  let inScope = isAdmin && !removedBase
  if (!inScope && project) {
    try {
      const realRoot = realpathSync(project.path)
      inScope = realFile === realRoot || realFile.startsWith(realRoot + sep)
    } catch { inScope = false }
  }
  // Não-admin fora do escopo responde como "não existe": exists:true aqui (e o
  // 404-vs-403 derivado dele) seria um oráculo de existência de arquivos
  // arbitrários do SO para quem só tem acesso a um projeto.
  if (!inScope) return missing
  return {
    path: raw,
    exists: true,
    inScope,
    kind: inScope ? kindOf(realFile) : undefined,
    size: inScope ? st.size : undefined,
    real: inScope ? realFile : undefined,
  }
}
