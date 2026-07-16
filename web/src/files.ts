// Detecção de candidatos a path no texto do chat + client HTTP p/ resolvê-los
// contra o escopo do projeto no servidor (server/src/files/scope.ts).

export type FileKind = 'image' | 'pdf' | 'markdown' | 'code' | 'text' | 'binary'
export interface ScopeResult { path: string; exists: boolean; inScope: boolean; kind?: FileKind; size?: number }

// absoluto (/...) ou ~/... com extensão (1-8 chars alfanum) no fim. O lookbehind
// (?<!\w) evita casar um "/" no meio de um path relativo (ex.: o "/components" de
// "src/components/App.tsx") como se fosse o início de um path absoluto novo.
const ABSOLUTE_RE = /(?<!\w)(?:~\/|\/)[\w.\-+@]+(?:\/[\w.\-+@]+)*\.[A-Za-z0-9]{1,8}\b/g
// relativo com pelo menos 1 "/" e extensão no fim (sem começar em "/" nem "~/", tratados acima).
const RELATIVE_RE = /\b[\w.\-]+(?:\/[\w.\-]+)+\.[A-Za-z0-9]{1,8}\b/g
// URLs completas — mascaradas antes de rodar as regexes acima, senão
// "https://site.com/logo.png" casaria como "/site.com/logo.png".
const URL_RE = /\b(?:https?|ftp):\/\/\S+/gi

/** Extrai candidatos a path de arquivo de um texto livre (mensagens de chat). */
export function extractCandidatePaths(text: string): string[] {
  if (!text) return []
  // Mascara URLs preservando o comprimento/índices, pra não interferir nos matches
  // de path ao redor e evitar reconstruir offsets manualmente.
  const masked = text.replace(URL_RE, (m) => ' '.repeat(m.length))

  const absoluteRanges: Array<{ start: number; end: number }> = []
  const found = new Set<string>()
  for (const m of masked.matchAll(ABSOLUTE_RE)) {
    absoluteRanges.push({ start: m.index, end: m.index + m[0].length })
    found.add(m[0])
  }

  const overlapsAbsolute = (start: number, end: number) =>
    absoluteRanges.some((r) => start < r.end && end > r.start)

  for (const m of masked.matchAll(RELATIVE_RE)) {
    const start = m.index
    const end = start + m[0].length
    // Descarta o "docs/notas.md" residual de dentro de um "~/docs/notas.md" já achado
    // (mesma lógica pro "home/user/a.ts" dentro de "/home/user/a.ts").
    if (overlapsAbsolute(start, end)) continue
    found.add(m[0])
  }

  return [...found]
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'Content-Type': 'application/json' } : undefined
  const res = await fetch(url, { headers, ...init })
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('claudinei:unauthorized'))
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((body as { error?: string }).error ?? res.statusText)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

/** Resolve candidatos a path contra o escopo do projeto (server-side). */
export const resolveFiles = (paths: string[], projectId?: number) =>
  req<ScopeResult[]>('/api/files/resolve', {
    method: 'POST',
    body: JSON.stringify(projectId ? { paths, projectId } : { paths }),
  })

/** URL de download/preview do conteúdo de um arquivo já resolvido em escopo. */
export const fileContentUrl = (path: string, projectId?: number): string =>
  `/api/files/content?path=${encodeURIComponent(path)}${projectId ? `&projectId=${projectId}` : ''}`

// Palpite de tipo por extensão (espelha o kindOf do servidor) — usado quando o
// resolve ainda não confirmou o path mas o clique precisa abrir o modal mesmo assim
// (o backend revalida e o modal mostra o erro amigável se não existir/sem acesso).
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'])
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'rb', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'php', 'swift', 'kt', 'sh', 'bash', 'zsh', 'sql', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'css', 'scss', 'less', 'html', 'xml', 'vue', 'svelte'])
const TEXT_EXT = new Set(['txt', 'log', 'csv', 'tsv', 'env', 'gitignore', 'diff', 'patch', 'text'])

// Linguagem do highlight.js pela extensão — para o preview de código colorido.
// A maioria das extensões JÁ É um alias válido do hljs (js, ts, py, rb, sh…);
// aqui só os desvios. Null = sem highlight (extensão desconhecida).
const LANG_ALIAS: Record<string, string> = {
  h: 'c', cc: 'cpp', jsonc: 'json', mjs: 'js', cjs: 'js',
  vue: 'html', svelte: 'html', zsh: 'bash', toml: 'ini',
}
export function langOfPath(path: string): string | null {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1]?.toLowerCase() ?? ''
  if (!CODE_EXT.has(ext)) return null
  return LANG_ALIAS[ext] ?? ext
}

export function kindOfPath(path: string): FileKind {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(path)
  const ext = m?.[1]?.toLowerCase() ?? ''
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (CODE_EXT.has(ext)) return 'code'
  if (TEXT_EXT.has(ext) || ext === '') return 'text'
  return 'binary'
}
