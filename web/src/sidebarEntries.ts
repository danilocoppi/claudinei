import type { Project, SessionInfo } from './types'
import type { Group } from './api'
import { liveSessionsOf } from './engineSession'

/**
 * A sidebar é uma lista de ENTRADAS num espaço único de posições: um setor (com
 * grupos e terminais dentro), um grupo (com os filhos na ordem) ou um terminal
 * solto — é o que permite arrastar qualquer um deles para qualquer lugar entre os
 * outros.
 *
 * A profundidade é fixa: setor não aninha em setor, grupo não aninha em grupo.
 */
export type Entry =
  | { kind: 'sector'; s: Group; children: Array<Extract<Entry, { kind: 'group' | 'project' }>> }
  | { kind: 'group'; g: Group; items: Project[] }
  | { kind: 'project'; p: Project }

export const entryKey = (e: Entry): string =>
  e.kind === 'sector' ? `s-${e.s.id}` : e.kind === 'group' ? `g-${e.g.id}` : `p-${e.p.id}`
export const entryOrder = (e: Entry): number =>
  (e.kind === 'sector' ? e.s.sortOrder : e.kind === 'group' ? e.g.sortOrder : e.p.sortOrder) ?? 0

/** Todos os terminais debaixo da entrada, incluindo os dentro de grupos de um setor. */
export function projectsOf(e: Entry): Project[] {
  if (e.kind === 'project') return [e.p]
  if (e.kind === 'group') return e.items
  return e.children.flatMap(projectsOf)
}

/**
 * O projeto tem agente de pé? Reusa `liveSessionsOf` de propósito: o filtro passa a
 * coincidir exatamente com a bolinha de status que o card já mostra — se a noção de
 * "vivo" mudar, filtro e bolinha mudam juntos.
 *
 * `pinnedLocalId` (o terminal ABERTO agora) mantém o projeto visível mesmo com a
 * sessão parada: sem isso, terminar um agente faria o card sumir da sidebar embaixo
 * do usuário, que segue lendo o chat dele.
 */
export function isProjectActive(
  projectId: number,
  sessions: Record<string, SessionInfo>,
  pinnedLocalId?: string,
): boolean {
  if (liveSessionsOf(projectId, sessions).length > 0) return true
  if (!pinnedLocalId) return false
  return Object.values(sessions).some((s) => s.projectId === projectId && s.localId === pinnedLocalId)
}

/**
 * As entradas visíveis com o filtro "somente ativos" ligado: terminais soltos ativos e
 * grupos com ao menos um filho ativo, já com `items` reduzido aos ativos. Grupo sem
 * nenhum ativo some inteiro (inclusive o vazio, que só existe como alvo de arraste —
 * e o arraste fica desabilitado enquanto se filtra).
 *
 * Não muta a entrada: a lista completa segue sendo a fonte do `applyOrder`.
 */
export function filterEntries(
  entries: Entry[],
  sessions: Record<string, SessionInfo>,
  pinnedLocalId?: string,
): Entry[] {
  const active = (projectId: number) => isProjectActive(projectId, sessions, pinnedLocalId)
  // Recursivo porque a árvore tem três níveis: um setor sobrevive se sobrar algo
  // dentro dele — seja um terminal solto, seja um grupo com filho ativo.
  const keep = (e: Entry): Entry | null => {
    if (e.kind === 'project') return active(e.p.id) ? e : null
    if (e.kind === 'group') {
      const items = e.items.filter((p) => active(p.id))
      return items.length > 0 ? { ...e, items } : null
    }
    const children = e.children.map(keep).filter(Boolean) as Array<Extract<Entry, { kind: 'group' | 'project' }>>
    return children.length > 0 ? { ...e, children } : null
  }
  return entries.map(keep).filter(Boolean) as Entry[]
}

/**
 * Monta a árvore da sidebar a partir das três listas planas do store. Cada item
 * aparece EXATAMENTE uma vez: o pertencimento é lido de cima para baixo (setor →
 * grupo → terminal) e quem já foi colocado não volta a ser considerado na raiz.
 *
 * Referência órfã (setor/grupo que não existe mais na lista) cai na raiz em vez de
 * sumir: um terminal invisível é pior que um terminal fora de lugar.
 */
export function buildEntries(projects: Project[], groups: Group[], sectors: Group[]): Entry[] {
  const byOrder = (a: Entry, b: Entry) => entryOrder(a) - entryOrder(b)
  const groupExists = (id: number | null | undefined) => id != null && groups.some((g) => g.id === id)
  const sectorExists = (id: number | null | undefined) => id != null && sectors.some((s) => s.id === id)
  const itemsOf = (groupId: number) => projects.filter((p) => p.groupId === groupId).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))

  const groupEntry = (g: Group): Entry => ({ kind: 'group', g, items: itemsOf(g.id) })

  const sectorEntries = sectors.map((s): Entry => ({
    kind: 'sector',
    s,
    children: [
      ...groups.filter((g) => g.sectorId === s.id).map(groupEntry),
      ...projects.filter((p) => !groupExists(p.groupId) && p.sectorId === s.id).map((p): Entry => ({ kind: 'project', p })),
    ].sort(byOrder) as Array<Extract<Entry, { kind: 'group' | 'project' }>>,
  }))

  return [
    ...sectorEntries,
    ...groups.filter((g) => !sectorExists(g.sectorId)).map(groupEntry),
    ...projects
      .filter((p) => !groupExists(p.groupId) && !sectorExists(p.sectorId))
      .map((p): Entry => ({ kind: 'project', p })),
  ].sort((a, b) => {
    const d = byOrder(a, b)
    if (d !== 0) return d
    // Empate (dados anteriores à ordenação unificada): contêineres primeiro.
    const rank = (e: Entry) => (e.kind === 'sector' ? 0 : e.kind === 'group' ? 1 : 2)
    return rank(a) - rank(b)
  })
}

// ---------------------------------------------------------------------------
// Arraste em três níveis
//
// A regra que governa tudo: cada tipo só vive onde cabe — setor na raiz, grupo na
// raiz ou num setor, terminal em qualquer lugar. Soltar num alvo "fundo demais"
// não é erro; a entrada sobe até o contêiner mais profundo que a aceita (soltar um
// grupo sobre um terminal agrupado põe o grupo ao lado do grupo daquele terminal).
// ---------------------------------------------------------------------------

type EntryKind = 'sector' | 'group' | 'project'

const kindOfKey = (key: string): EntryKind =>
  key.startsWith('s-') ? 'sector' : key.startsWith('g-') ? 'group' : 'project'

/** O contêiner (`root`, `s-N` ou `g-N`) aceita uma entrada desse tipo? */
export const canHold = (container: string, kind: EntryKind): boolean =>
  container === 'root' ? true : container.startsWith('s-') ? kind !== 'sector' : kind === 'project'

/** Remove a entrada de onde quer que esteja na árvore; devolve o resto e o que saiu. */
export function detachEntry(entries: Entry[], key: string): { rest: Entry[]; grabbed: Entry | null } {
  let grabbed: Entry | null = null
  const pid = key.startsWith('p-') ? Number(key.slice(2)) : null
  const walk = (list: Entry[]): Entry[] =>
    list.flatMap((e): Entry[] => {
      if (entryKey(e) === key) { grabbed = e; return [] }
      if (e.kind === 'group') {
        const found = pid !== null ? e.items.find((p) => p.id === pid) : undefined
        if (!found) return [e]
        grabbed = { kind: 'project', p: found }
        return [{ ...e, items: e.items.filter((p) => p.id !== pid) }]
      }
      if (e.kind === 'sector') {
        return [{ ...e, children: walk(e.children) as Array<Extract<Entry, { kind: 'group' | 'project' }>> }]
      }
      return [e]
    })
  const rest = walk(entries)
  return { rest, grabbed }
}

/** Ordem VISUAL achatada das chaves — é ela que decide inserir antes ou depois do alvo. */
export function flatKeys(entries: Entry[]): string[] {
  return entries.flatMap((e) =>
    e.kind === 'sector' ? [entryKey(e), ...flatKeys(e.children)]
      : e.kind === 'group' ? [entryKey(e), ...e.items.map((p) => `p-${p.id}`)]
        : [entryKey(e)],
  )
}

/** Cadeia de ancestrais até a chave: cada elo diz em que contêiner aquele nível vive. */
function chainOf(entries: Entry[], key: string): Array<{ container: string; key: string }> | null {
  const walk = (list: Entry[], container: string): Array<{ container: string; key: string }> | null => {
    for (const e of list) {
      const k = entryKey(e)
      if (k === key) return [{ container, key: k }]
      if (e.kind === 'sector') {
        const deeper = walk(e.children, k)
        if (deeper) return [{ container, key: k }, ...deeper]
      } else if (e.kind === 'group') {
        if (e.items.some((p) => `p-${p.id}` === key)) return [{ container, key: k }, { container: k, key }]
      }
    }
    return null
  }
  return walk(entries, 'root')
}

/** Insere `grabbed` no contêiner, na posição `at`. Contêiner grupo só aceita terminal. */
function insertInto(entries: Entry[], container: string, at: number, grabbed: Entry): Entry[] {
  if (container === 'root') return [...entries.slice(0, at), grabbed, ...entries.slice(at)]
  return entries.map((e): Entry => {
    if (e.kind === 'sector' && entryKey(e) === container) {
      const kids = e.children as Entry[]
      return { ...e, children: [...kids.slice(0, at), grabbed, ...kids.slice(at)] as Array<Extract<Entry, { kind: 'group' | 'project' }>> }
    }
    if (e.kind === 'group' && entryKey(e) === container && grabbed.kind === 'project') {
      return { ...e, items: [...e.items.slice(0, at), grabbed.p, ...e.items.slice(at)] }
    }
    if (e.kind === 'sector') return { ...e, children: insertInto(e.children as Entry[], container, at, grabbed) as Array<Extract<Entry, { kind: 'group' | 'project' }>> }
    return e
  })
}

/** Acha a entrada pela chave em qualquer profundidade. */
function findEntry(entries: Entry[], key: string): Entry | null {
  for (const e of entries) {
    if (entryKey(e) === key) return e
    if (e.kind === 'sector') {
      const deeper = findEntry(e.children as Entry[], key)
      if (deeper) return deeper
    }
  }
  return null
}

/** Chaves dos filhos diretos de um contêiner (`root`, `s-N` ou `g-N`), na ordem. */
function childKeysOf(entries: Entry[], container: string): string[] {
  if (container === 'root') return entries.map(entryKey)
  const c = findEntry(entries, container)
  if (!c) return []
  return c.kind === 'sector' ? c.children.map(entryKey) : c.kind === 'group' ? c.items.map((p) => `p-${p.id}`) : []
}

/** Índice do filho `key` dentro do contêiner, ou o tamanho dele se não estiver lá. */
function indexIn(entries: Entry[], container: string, key: string): number {
  const keys = childKeysOf(entries, container)
  const i = keys.indexOf(key)
  return i === -1 ? keys.length : i
}

/**
 * Move `dragKey` para a posição de `targetKey` (null = fim da raiz). Arrastar de
 * CIMA insere depois do alvo, de baixo insere antes — sem isso, soltar no vizinho
 * imediato seria um no-op, que é justamente o gesto mais comum.
 */
export function moveEntry(entries: Entry[], dragKey: string, targetKey: string | null): Entry[] {
  if (dragKey === targetKey) return entries
  const kind = kindOfKey(dragKey)
  const { rest, grabbed } = detachEntry(entries, dragKey)
  if (!grabbed) return entries
  if (targetKey === null) return [...rest, grabbed]

  const chain = chainOf(entries, targetKey)
  if (!chain) return [...rest, grabbed]
  // Do alvo para cima: o primeiro nível cujo contêiner aceita o que está sendo
  // arrastado. É o que traduz "soltei aqui" em "cabe aqui".
  const anchor = [...chain].reverse().find((link) => canHold(link.container, kind))
  if (!anchor || anchor.key === dragKey) return entries

  const flat = flatKeys(entries)
  const fromAbove = flat.indexOf(dragKey) !== -1 && flat.indexOf(dragKey) < flat.indexOf(anchor.key)
  const idx = indexIn(rest, anchor.container, anchor.key)
  return insertInto(rest, anchor.container, fromAbove ? idx + 1 : idx, grabbed)
}

/**
 * Solta DENTRO de um contêiner (`s-N`, `g-N`): entra no fim dele. Se o contêiner não
 * aceita esse tipo (grupo sobre grupo, setor sobre setor), o gesto vira
 * reposicionamento — soltar um grupo sobre outro continua sendo "ponha-o aqui".
 */
export function moveInto(entries: Entry[], dragKey: string, container: string): Entry[] {
  if (dragKey === container) return entries
  const kind = kindOfKey(dragKey)
  if (!canHold(container, kind)) return moveEntry(entries, dragKey, container)
  // Soltar dentro do contêiner em que já está, no fim: sai e volta na última posição.
  const { rest, grabbed } = detachEntry(entries, dragKey)
  if (!grabbed) return entries
  const size = childKeysOf(rest, container).length
  return insertInto(rest, container, size, grabbed)
}
