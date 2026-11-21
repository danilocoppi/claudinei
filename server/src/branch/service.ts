import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import type { TerminalStateStore } from '../restart/terminal-state.js'
import type { RestartService } from '../restart/boot.js'
import type { SessionInfo } from '../claude/manager.js'
import type { AuthUser } from '../auth/plugin.js'
import { createProjectsService, type Project } from '../projects.js'
import { getEngine } from '../engine/index.js'
import { createSideService, type SideMain, type SideService } from './side.js'
import { forkTerminal } from './fork.js'
import { forkCopyDone, parseForkSource, type ForkSource } from './fork-source.js'
import { collectHandoff } from './handoff.js'

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
  /** `/fork`: o terminal irmão com a cópia da conversa (ver fork.ts). */
  fork(req: { projectId: number; engine: string; name?: string; user?: AuthUser }): Promise<{ project: Project; session: SessionInfo }>
  /** Mensagem do operador aceita pela sessão: a do ramo ainda sem cópia fica guardada até o fim do turno. */
  onOperatorMessage(projectId: number, engine: string, info: { localId?: string; text?: string }): void
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

  const collect = deps.side?.collect ?? collectHandoff

  /**
   * Mensagens do operador mandadas a um ramo cuja cópia ainda não existe, por
   * sessão, até o fim do turno. Se a cópia for recusada (a sessão morre antes
   * do init), elas saem de novo depois do pacote, sem o operador redigitar.
   */
  const pending = new Map<string, string[]>()

  type ForkRow = { local_id: string; claude_session_id: string | null; fork_source: string }

  /**
   * Cópia recusada: revive em conversa nova, manda o pacote do original até o
   * corte e, se a recusa levou mensagens do operador, reenvia-as depois dele.
   * O `fork_source` já saiu do banco: roda uma vez por sessão.
   */
  const recover = async (localId: string, projectPath: string, src: ForkSource, texts: string[]): Promise<void> => {
    const pack = await collect(getEngine(src.engine), projectPath, src.sourceId, {
      working: false, ...(src.previewBefore !== null ? { before: src.previewBefore } : {}),
    }).catch((err) => { console.error('[ramo] pacote da cópia recusada falhou', err); return null })
    try {
      deps.manager.revive(localId)
    } catch (err) {
      // O operador já reviveu (ou parou) o ramo nesse meio-tempo: não insiste.
      console.error('[ramo] não reviveu a cópia recusada', err)
      return
    }
    try {
      if (pack) deps.manager.sendAsClaudinei(localId, pack.text)
      for (const text of texts) deps.manager.send(localId, text, { echo: true })
    } catch (err) {
      console.error('[ramo] envio depois da cópia recusada falhou', err)
    }
  }

  return {
    side,
    fork: (req) => forkTerminal({ db: deps.db, manager: deps.manager, cutFor: deps.side?.cutFor, collect: deps.side?.collect }, req),

    onOperatorMessage(_projectId, _engine, info) {
      if (!info.localId || typeof info.text !== 'string') return
      const row = deps.db.prepare('SELECT fork_source FROM sessions WHERE local_id=?').get(info.localId) as { fork_source?: string | null } | undefined
      if (!row?.fork_source) return
      pending.set(info.localId, [...(pending.get(info.localId) ?? []), info.text])
    },

    onTurnResult(projectId, engine) {
      const rows = deps.db.prepare(
        'SELECT local_id, claude_session_id, fork_source FROM sessions WHERE project_id=? AND engine=? AND fork_source IS NOT NULL',
      ).all(projectId, engine) as ForkRow[]
      if (rows.length === 0) return
      const path = projects.get(projectId)?.path
      for (const r of rows) {
        // O turno acabou: as mensagens dele não estão mais "a caminho".
        pending.delete(r.local_id)
        // A cópia gravada encerra o `fork_source`: o revive daqui em diante
        // retoma o ramo, em vez de copiar de novo por cima do que ele andou.
        if (path && forkCopyDone(getEngine(engine), path, r.claude_session_id)) {
          deps.db.prepare('UPDATE sessions SET fork_source=NULL WHERE local_id=?').run(r.local_id)
        }
      }
    },

    onSessionDied(projectId, engine) {
      // Chamado de dentro do handler de status, com a linha já `dead`.
      const r = deps.db.prepare(
        `SELECT local_id, claude_session_id, fork_source FROM sessions
          WHERE project_id=? AND engine=? AND status='dead' AND fork_source IS NOT NULL
          ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      ).get(projectId, engine) as ForkRow | undefined
      if (!r) return
      const texts = pending.get(r.local_id) ?? []
      pending.delete(r.local_id)
      const path = projects.get(projectId)?.path
      const src = parseForkSource(r.fork_source)
      if (!path || !src || forkCopyDone(getEngine(engine), path, r.claude_session_id)) {
        // Morte comum (a cópia já existe) ou fonte ilegível: nada a refazer.
        deps.db.prepare('UPDATE sessions SET fork_source=NULL WHERE local_id=?').run(r.local_id)
        return
      }
      // O id escolhido nunca virou conversa: sai junto, e o revive abre uma nova.
      deps.db.prepare('UPDATE sessions SET fork_source=NULL, claude_session_id=NULL WHERE local_id=?').run(r.local_id)
      // Assíncrono de propósito: o handler de status ainda vai tirar a sessão
      // morta do `live`, e o revive tem de vir depois disso.
      void recover(r.local_id, path, src, texts).catch((err) => console.error('[ramo] cópia recusada', err))
    },

    onSessionEnded(projectId, engine) { side.onSessionEnded(projectId, engine) },
    bootCleanup: () => side.bootCleanup(),
    dispose: () => side.dispose(),
  }
}
