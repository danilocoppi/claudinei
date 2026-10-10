import type { Project, SessionInfo } from './types'
import { isWaitingForYou, liveSessionsOf, primarySessionOf } from './engineSession'

export interface QuickItem {
  project: Project
  /** Sessão principal do terminal: decide o rosto e o que o clique abre. */
  session: SessionInfo
  /** Alguma engine ligada espera por você. */
  waiting: boolean
}

/**
 * A coluna de rostinhos da lateral: só terminais ligados, primeiro os que pedem
 * ação, depois do que você mexeu por último ao mais antigo. Os ligados em que você
 * nunca mexeu vão para o fim, na ordem em que aparecem na lista (`projects` já
 * vem nessa ordem). Num terminal com várias engines ligadas, vale a mexida mais
 * recente entre elas, e basta uma esperando para ele pedir ação.
 */
export function quickColumnItems(projects: Project[], sessions: Record<string, SessionInfo>): QuickItem[] {
  const items = projects.flatMap((project, index) => {
    const live = liveSessionsOf(project.id, sessions)
    const session = primarySessionOf(project.id, sessions)
    if (live.length === 0 || !session) return []
    // ISO 8601 em UTC ordena como texto.
    const last = live.reduce<string>((max, s) => (s.lastInputAt && s.lastInputAt > max ? s.lastInputAt : max), '')
    return [{ project, session, waiting: live.some(isWaitingForYou), last, index }]
  })
  items.sort((a, b) =>
    Number(b.waiting) - Number(a.waiting)
    || (a.last === b.last ? 0 : a.last > b.last ? -1 : 1)
    || a.index - b.index)
  return items.map(({ project, session, waiting }) => ({ project, session, waiting }))
}
