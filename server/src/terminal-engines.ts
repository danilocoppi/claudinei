import type { Db } from './db.js'

/**
 * Motores de cada terminal (`projects.engines`): um JSON de ids, em ordem
 * canônica. Ids desconhecidos (um motor que esta versão não conhece) são
 * preservados no banco, depois dos canônicos, na ordem gravada.
 */

/** Ordem de exibição: a mesma do registro em engine/index.ts. */
export const CANONICAL_ENGINE_ORDER: readonly string[] = ['claude', 'codex', 'kimi', 'opencode']

/** Forma de um id de motor aceito na lista (inclusive os que ainda não existem). */
export const ENGINE_ID_RE = /^[a-z0-9-]{1,32}$/

const FALLBACK = ['claude']

const isEngineId = (v: unknown): v is string => typeof v === 'string' && ENGINE_ID_RE.test(v)

/** Sem repetição; canônicos primeiro, desconhecidos depois na ordem dada. */
export function sortEngines(ids: string[]): string[] {
  const unique = [...new Set(ids)]
  const canonical = CANONICAL_ENGINE_ORDER.filter((id) => unique.includes(id))
  const unknown = unique.filter((id) => !CANONICAL_ENGINE_ORDER.includes(id))
  return [...canonical, ...unknown]
}

/**
 * Lê a coluna. Qualquer coisa que não seja uma lista não vazia de ids vira null,
 * e quem chama cai no Claude: um valor quebrado não pode derrubar a listagem.
 */
export function parseEngines(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(v) || v.length === 0 || !v.every(isEngineId)) return null
  return v
}

export function enginesOf(db: Db, projectId: number): string[] {
  const row = db.prepare('SELECT engines FROM projects WHERE id = ?').get(projectId) as { engines?: unknown } | undefined
  return parseEngines(row?.engines) ?? [...FALLBACK]
}

/**
 * Migração: cada terminal recebe os motores que já usou, com linha em
 * `sessions` OU em `project_threads` (as sessões antigas são podadas; os threads
 * guardam o histórico de posse). Sem nenhum, fica com o Claude.
 */
export function backfillProjectEngines(db: Db): number {
  const used = db.prepare(
    `SELECT project_id AS projectId, engine FROM sessions
     UNION SELECT project_id AS projectId, engine FROM project_threads
     ORDER BY projectId, engine`,
  ).all() as { projectId: number; engine: string }[]
  const byProject = new Map<number, string[]>()
  for (const { projectId, engine } of used) {
    if (!isEngineId(engine)) continue
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), engine])
  }
  const ids = (db.prepare('SELECT id FROM projects').all() as { id: number }[]).map((r) => r.id)
  const upd = db.prepare('UPDATE projects SET engines = ? WHERE id = ?')
  db.transaction(() => {
    for (const id of ids) {
      const engines = byProject.get(id)
      upd.run(JSON.stringify(engines ? sortEngines(engines) : FALLBACK), id)
    }
  })()
  return ids.length
}

/** Terminal novo: o Claude, ou o primeiro motor instalado na ordem canônica. */
export function defaultEngines(isAvailable: (id: string) => boolean): string[] {
  if (isAvailable('claude')) return ['claude']
  const first = CANONICAL_ENGINE_ORDER.find(isAvailable)
  return first ? [first] : [...FALLBACK]
}

/**
 * Lista vinda do cliente. Null quando não é uma lista de ids, quando está vazia
 * ou quando nenhum id é conhecido; os desconhecidos junto de um conhecido ficam
 * (o formulário devolve o que não sabe exibir).
 */
export function validateEnginesInput(v: unknown, isKnown: (id: string) => boolean): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || !v.every(isEngineId)) return null
  if (!v.some(isKnown)) return null
  return sortEngines(v)
}
