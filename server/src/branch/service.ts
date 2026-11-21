import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import type { TerminalStateStore } from '../restart/terminal-state.js'
import type { RestartService } from '../restart/boot.js'
import { createProjectsService } from '../projects.js'
import { createSideService, type SideMain, type SideService } from './side.js'

/** Status em que a sessão está de pé (o mesmo ACTIVE do manager). */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

/** O que os testes injetam na lateral para não abrir CLIs nem ler o storage real dos motores. */
export type SideTestDeps = Pick<Parameters<typeof createSideService>[0], 'makeSession' | 'cutFor' | 'collect' | 'cleanup'>

/**
 * Ramificar a conversa: a lateral (`/side`, `/btw`), o ramo (`/fork`, Task 8) e
 * a troca de motor (Task 9). Nasce no app, depois do goal; os ganchos do
 * manager (fim de turno, morte e fim da sessão) chegam pela referência que
 * index.ts guarda.
 */
export interface BranchService {
  side: SideService
  onTurnResult(projectId: number, engine: string): void
  onSessionDied(projectId: number, engine: string): void
  onSessionEnded(projectId: number, engine: string): void
  bootCleanup(): Promise<void>
  dispose(): Promise<void>
}

export function createBranchService(deps: {
  db: Db
  manager: SessionManager
  broadcast: (m: object) => void
  store: TerminalStateStore
  restart: Pick<RestartService, 'publish'>
  side?: SideTestDeps
}): BranchService {
  const projects = createProjectsService(deps.db)

  /** A sessão principal viva do terminal, com o início do turno em curso; null sem sessão de pé. */
  const main = (projectId: number, engine: string): SideMain | null => {
    const s = deps.manager.list().find((x) => x.projectId === projectId && x.engine === engine && ACTIVE.has(x.status))
    if (!s) return null
    return {
      localId: s.localId, status: s.status, engineSessionId: s.engineSessionId,
      model: s.model, effort: s.effort, turnStartedAt: deps.manager.turnStartedAt(s.localId),
    }
  }

  const side = createSideService({
    db: deps.db,
    broadcast: deps.broadcast,
    main,
    projectPath: (projectId) => projects.get(projectId)?.path ?? null,
    ...deps.side,
  })

  return {
    side,
    // Vazios até a Task 8 (o ramo que cai no pacote).
    onTurnResult() {},
    onSessionDied() {},
    onSessionEnded(projectId, engine) { side.onSessionEnded(projectId, engine) },
    bootCleanup: () => side.bootCleanup(),
    dispose: () => side.dispose(),
  }
}
