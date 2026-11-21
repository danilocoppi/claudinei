import type { ChatItem } from '../types'

/**
 * Uma mudança que o agente declarou nas ferramentas (pastas sem git):
 * - `edit`: os trechos enviados (Edit/MultiEdit do Claude, `edit` do OpenCode);
 * - `written`: arquivo escrito inteiro (Write), sem diff falso;
 * - `patch`: o `diff` do `file_change` do Codex;
 * - `path_only`: a ferramenta só diz o caminho.
 */
export interface DeclaredChange {
  path: string
  kind: 'edit' | 'written' | 'patch' | 'path_only'
  pairs?: Array<{ old: string; new: string }>
  diff?: string
}

// A mesma regra de nomes e de chaves do servidor (server/src/undo/declared.ts).
const WRITES = /edit|write|patch|replace|create|notebook|file_change/i
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'path'] as const
/** Escrita do arquivo inteiro: Write do Claude, write do OpenCode, WriteFile do Kimi. */
const WHOLE_WRITE = /^(write|writefile)$/i

const str = (v: unknown): v is string => typeof v === 'string'

/** Os pares antigo→novo do input, nos formatos do Claude e do OpenCode. */
function pairsOf(o: Record<string, unknown>): Array<{ old: string; new: string }> {
  if (str(o.old_string) && str(o.new_string)) return [{ old: o.old_string, new: o.new_string }]
  if (str(o.oldString) && str(o.newString)) return [{ old: o.oldString, new: o.newString }]
  if (Array.isArray(o.edits)) {
    const out: Array<{ old: string; new: string }> = []
    for (const e of o.edits as Array<Record<string, unknown> | null>) {
      if (e && str(e.old_string) && str(e.new_string)) out.push({ old: e.old_string, new: e.new_string })
    }
    return out
  }
  return []
}

/** As mudanças de uma chamada de ferramenta, uma por caminho. */
function changesOf(name: string, input: unknown): DeclaredChange[] {
  if (!WRITES.test(name)) return []
  let parsed = input
  if (str(parsed)) {
    try { parsed = JSON.parse(parsed) } catch { return [] }
  }
  if (!parsed || typeof parsed !== 'object') return []
  const o = parsed as Record<string, unknown>
  const out: DeclaredChange[] = []

  // O file_change do Codex: o item inteiro, com `changes: [{ path, kind, diff }]`.
  if (Array.isArray(o.changes)) {
    for (const c of o.changes as Array<Record<string, unknown> | null>) {
      if (!c || !str(c.path) || !c.path) continue
      out.push(str(c.diff) ? { path: c.path, kind: 'patch', diff: c.diff } : { path: c.path, kind: 'path_only' })
    }
  }

  const pairs = pairsOf(o)
  for (const key of PATH_KEYS) {
    const path = o[key]
    if (!str(path) || !path) continue
    if (WHOLE_WRITE.test(name)) out.push({ path, kind: 'written' })
    else if (pairs.length > 0) out.push({ path, kind: 'edit', pairs })
    else out.push({ path, kind: 'path_only' })
  }
  return out
}

/** Junta duas mudanças do mesmo caminho: escrita inteira vence; o resto soma. */
function merge(a: DeclaredChange, b: DeclaredChange): DeclaredChange {
  if (a.kind === 'written' || b.kind === 'written') return { path: a.path, kind: 'written' }
  if (a.kind === 'path_only') return b
  if (b.kind === 'path_only' || a.kind !== b.kind) return a
  if (a.kind === 'edit') return { path: a.path, kind: 'edit', pairs: [...(a.pairs ?? []), ...(b.pairs ?? [])] }
  return { path: a.path, kind: 'patch', diff: `${a.diff ?? ''}${a.diff && !a.diff.endsWith('\n') ? '\n' : ''}${b.diff ?? ''}` }
}

/**
 * O que as ferramentas do bloco do turno declararam mexer, um item por
 * caminho, na ordem em que apareceram. Inclui o que os subagentes fizeram
 * (o servidor conta igual). Bash e afins não entram: não declaram caminho.
 */
export function declaredChanges(items: ChatItem[]): DeclaredChange[] {
  const byPath = new Map<string, DeclaredChange>()
  for (const it of items) {
    if (it.kind !== 'tool_call') continue
    for (const c of changesOf(it.name, it.input)) {
      const prev = byPath.get(c.path)
      byPath.set(c.path, prev ? merge(prev, c) : c)
    }
  }
  return [...byPath.values()]
}
