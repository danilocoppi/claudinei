import type { Project, SessionInfo } from './types'
import type { Group } from './api'
import { liveSessionsOf } from './engineSession'

/**
 * A sidebar é uma lista de ENTRADAS num espaço único de posições: um grupo (com os
 * filhos na ordem) ou um terminal solto — é o que permite arrastar um GRUPO para
 * qualquer lugar entre os terminais.
 */
export type Entry =
  | { kind: 'group'; g: Group; items: Project[] }
  | { kind: 'project'; p: Project }

export const entryKey = (e: Entry): string => (e.kind === 'group' ? `g-${e.g.id}` : `p-${e.p.id}`)
export const entryOrder = (e: Entry): number => (e.kind === 'group' ? (e.g.sortOrder ?? 0) : (e.p.sortOrder ?? 0))

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
  const out: Entry[] = []
  for (const e of entries) {
    if (e.kind === 'project') {
      if (active(e.p.id)) out.push(e)
      continue
    }
    const items = e.items.filter((p) => active(p.id))
    if (items.length > 0) out.push({ ...e, items })
  }
  return out
}
