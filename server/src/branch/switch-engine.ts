import type { Db } from '../db.js'
import type { SessionInfo, SessionManager } from '../claude/manager.js'
import type { TerminalStateStore } from '../restart/terminal-state.js'
import { limitActive, type RestartService } from '../restart/boot.js'
import { createProjectsService } from '../projects.js'
import { getEngine, hasEngine } from '../engine/index.js'
import { binAvailableCached } from '../engine/available.js'
import { UserError } from '../user-error.js'
import { collectHandoff, type Handoff } from './handoff.js'
import { originOf, SAFE_ID } from './fork.js'

/**
 * Continuar noutro motor (⇄): a conversa de origem vira o pacote de contexto,
 * que abre uma conversa nova no motor de destino do mesmo terminal. A origem
 * segue viva e como estava; goal e fila são por terminal+motor e não passam.
 */

/** Status em que a sessão está de pé (o mesmo ACTIVE do manager). */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

export interface SwitchDeps {
  db: Db
  manager: Pick<SessionManager, 'list' | 'get' | 'start' | 'stop' | 'sendAsClaudinei' | 'turnStartedAt'>
  store: Pick<TerminalStateStore, 'get' | 'setGoalStatus'>
  restart: Pick<RestartService, 'publish'>
  collect?: typeof collectHandoff // testes
}

/** O binário do motor existe: o mesmo `available` do GET /api/engines. */
const installed = (engine: string): boolean => binAvailableCached(getEngine(engine).bin())

const noConversation = () => new UserError('no_conversation', 'Ainda não há conversa para copiar')

/** A sessão de pé do motor no terminal, se houver. */
function liveOf(deps: SwitchDeps, projectId: number, engine: string): SessionInfo | undefined {
  return deps.manager.list().find((s) => s.projectId === projectId && s.engine === engine && ACTIVE.has(s.status))
}

/**
 * O destino aceita a troca: sem turno em curso e fora do limite de uso.
 * Devolve a sessão ociosa de pé (a encerrar), se houver.
 */
function checkTarget(deps: SwitchDeps, projectId: number, to: string): SessionInfo | undefined {
  const live = liveOf(deps, projectId, to)
  if (live?.status === 'working') {
    throw new UserError('handoff_target_busy', 'O motor de destino está trabalhando')
  }
  if (limitActive(deps.store.get(projectId, to))) {
    throw new UserError('handoff_target_limited', 'O motor de destino está no limite de uso')
  }
  return live
}

/**
 * A troca, nesta ordem:
 * 1. valida os motores (o destino da lista do terminal e instalado);
 * 2. acha a conversa de origem (a viva, ou a mais recente com conversa);
 * 3. confere o destino (trabalhando ou no limite recusa);
 * 4. monta o pacote ANTES de mexer no destino; o destino é conferido de novo
 *    depois, porque pode ter começado a trabalhar enquanto o pacote era lido;
 * 5. encerra o destino ocioso (se o `stop` falha, nada é criado nem pausado);
 * 6. pausa por `operator` o goal ativo ou esperando do destino;
 * 7. abre a conversa nova e manda o pacote como mensagem do Claudinei, no mesmo
 *    passo síncrono: o "livre" do início da sessão (microtask) já a encontra
 *    ocupada, e a fila e os avisos do destino só saem depois do turno do pacote.
 */
export async function switchEngine(deps: SwitchDeps, req: { projectId: number; from: string; to: string }): Promise<SessionInfo> {
  const { projectId, from, to } = req
  if (from === to) throw new UserError('handoff_same_engine', 'O destino é o mesmo motor da conversa')
  const project = createProjectsService(deps.db).get(projectId)
  if (!project) throw new UserError('project_not_found', 'projeto não existe')
  if (!project.engines.includes(to) || !hasEngine(to) || !installed(to)) {
    throw new UserError('handoff_engine_unavailable', 'O motor de destino não está disponível neste terminal', { engine: to })
  }

  const origin = originOf(deps, projectId, from)
  if (!origin || !SAFE_ID.test(origin.sourceId)) throw noConversation()

  checkTarget(deps, projectId, to)

  // Nunca com `before`: o pacote vai até o último turno fechado de agora.
  const collect = deps.collect ?? collectHandoff
  let pack: Handoff | null
  try {
    pack = await collect(getEngine(from), project.path, origin.sourceId, { working: origin.working })
  } catch (err) {
    console.error('[troca de motor] pacote falhou', err)
    pack = null
  }
  if (!pack) throw noConversation()

  const target = checkTarget(deps, projectId, to)
  if (target) {
    // Se lança, a troca para aqui: nada foi criado nem pausado.
    await deps.manager.stop(target.localId)
    const still = deps.manager.get(target.localId)
    if (still && ACTIVE.has(still.status)) throw new UserError('handoff_target_busy', 'O motor de destino não encerrou a conversa')
  }

  const goal = deps.store.get(projectId, to).goalStatus
  if (goal === 'active' || goal === 'waiting') {
    deps.store.setGoalStatus(projectId, to, 'paused', 'operator')
    try { deps.restart.publish(projectId, to) } catch (err) { console.error('[troca de motor] publicar o goal pausado falhou', err) }
  }

  const session = deps.manager.start(project, { engine: to, continueLatest: false })
  deps.manager.sendAsClaudinei(session.localId, pack.text)
  return deps.manager.get(session.localId) ?? session
}
