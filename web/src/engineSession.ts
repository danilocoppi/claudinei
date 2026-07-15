import type { SessionInfo } from './types'
import { reviveSession, startSession } from './api'

/**
 * Status "vivos" de uma sessão — a engine está de pé (mesmo que ainda iniciando).
 * Compartilhado entre Sidebar (ordenação de card) e ChatView (abas de engine).
 */
export const LIVE_STATUSES = new Set<SessionInfo['status']>([
  'starting', 'idle', 'working', 'needs_attention', 'in_terminal',
])

export function isLive(session: SessionInfo | undefined): boolean {
  return !!session && LIVE_STATUSES.has(session.status)
}

/**
 * Sessão de (projectId, engineId) a mostrar numa aba/card: prefere a viva; sem
 * uma viva, cai na parada (stopped/dead) mais recente. `undefined` = engine
 * nunca rodou nesse projeto (ou só tem sessões de outras engines).
 */
export function sessionForEngine(
  projectId: number,
  engineId: string,
  sessions: Record<string, SessionInfo>,
): SessionInfo | undefined {
  const candidates = Object.values(sessions).filter((s) => s.projectId === projectId && s.engine === engineId)
  const live = candidates.find((s) => LIVE_STATUSES.has(s.status))
  if (live) return live
  return candidates
    .filter((s) => s.status === 'stopped' || s.status === 'dead')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
}

/**
 * Coloca a engine dada de pé no projeto dado: revive a sessão stopped/dead mais
 * recente dessa (projectId, engineId) se existir; senão inicia uma sessão nova
 * com essa engine. Devolve o localId resultante (para `openSession`).
 */
export async function startOrReviveEngine(
  projectId: number,
  engineId: string,
  sessions: Record<string, SessionInfo>,
): Promise<string> {
  const candidates = Object.values(sessions)
    .filter((s) => s.projectId === projectId && s.engine === engineId && (s.status === 'stopped' || s.status === 'dead'))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  const revivable = candidates[0]
  if (revivable) {
    await reviveSession(revivable.localId)
    return revivable.localId
  }
  const info = await startSession(projectId, { engine: engineId })
  return info.localId
}

/**
 * Prioridade de exibição do status AGREGADO de um projeto (card da sidebar e do
 * dashboard) quando há mais de uma engine viva: o que espera você vence o que
 * trabalha, que vence o ocioso. Antes a escolha caía em updatedAt (instável):
 * 1 Claude idle + 1 Codex working mostrava "idle" no card.
 */
const STATUS_PRIORITY: Record<SessionInfo['status'], number> = {
  needs_attention: 6, working: 5, starting: 4, in_terminal: 3, idle: 2, stopped: 1, dead: 0,
}

/** A sessão "cara do projeto": maior prioridade de status; empate → mais recente. */
export function primarySessionOf(projectId: number, sessions: Record<string, SessionInfo>): SessionInfo | undefined {
  return Object.values(sessions)
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 0
      const pb = STATUS_PRIORITY[b.status] ?? 0
      if (pa !== pb) return pb - pa
      return a.updatedAt < b.updatedAt ? 1 : -1
    })[0]
}

/** Não-lidos do PROJETO inteiro (soma de todas as engines — o badge de uma não pode sumir porque outra foi exibida). */
export function unreadOf(projectId: number, sessions: Record<string, SessionInfo>, unread: Record<string, number>): number {
  return Object.values(sessions)
    .filter((s) => s.projectId === projectId)
    .reduce((acc, s) => acc + (unread[s.localId] ?? 0), 0)
}
