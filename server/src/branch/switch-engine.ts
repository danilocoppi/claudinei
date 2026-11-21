import type { Db } from '../db.js'
import type { SessionInfo, SessionManager } from '../claude/manager.js'
import type { TerminalStateStore } from '../restart/terminal-state.js'
import { limitActive, type RestartService } from '../restart/boot.js'
import { createProjectsService } from '../projects.js'
import { getEngine, hasEngine } from '../engine/index.js'
import { binAvailableCached } from '../engine/available.js'
import { UserError } from '../user-error.js'
import { collectHandoff, type Handoff } from './handoff.js'
import type { PermissionMode } from '../claude/session.js'
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
  manager: Pick<SessionManager, 'list' | 'get' | 'start' | 'stop' | 'sendAsClaudinei' | 'turnStartedAt' | 'rewindPending'>
  store: Pick<TerminalStateStore, 'get' | 'setGoalStatus'>
  restart: Pick<RestartService, 'publish' | 'dismiss'>
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
 * O destino aceita a troca: sem turno em curso, fora do terminal interativo e
 * fora do limite de uso. Devolve a sessão ociosa de pé (a encerrar), se houver.
 */
function checkTarget(deps: SwitchDeps, projectId: number, to: string): SessionInfo | undefined {
  const live = liveOf(deps, projectId, to)
  // Aberto no terminal interativo: o `manager.start` recusaria depois do pacote e da pausa do goal.
  const inTerminal = deps.db.prepare(
    `SELECT 1 FROM sessions WHERE project_id=? AND engine=? AND status='in_terminal' LIMIT 1`,
  ).get(projectId, to)
  if (live?.status === 'working' || inTerminal) {
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
 * 6. pausa por `operator` o goal ativo ou esperando do destino e descarta a
 *    retomada pendente dele (conversa nova não tem "Continuar");
 * 7. abre a conversa nova (com o modelo, o esforço e a permissão da sessão do
 *    destino, a de pé ou a mais recente do banco) e manda o pacote como
 *    mensagem do Claudinei, no mesmo passo síncrono: o "livre" do início da
 *    sessão (microtask) já a encontra ocupada, e a fila e os avisos do destino
 *    só saem depois do turno do pacote.
 *    Se o envio do pacote lança, a sessão nova já existe: vai ao log e a troca
 *    responde com ela (o operador segue sem o contexto), como no `/fork`.
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
  // A conversa nova do destino herda o modelo, o esforço e a permissão da
  // sessão dele: a de pé (encerrada logo abaixo) ou a mais recente do banco.
  const row = target ? undefined : deps.db.prepare(
    `SELECT model, effort, permission_mode FROM sessions WHERE project_id=? AND engine=?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
  ).get(projectId, to) as { model: string | null; effort: string | null; permission_mode: string | null } | undefined
  const prefs = target
    ? { model: target.model, effort: target.effort, permissionMode: target.permissionMode }
    : { model: row?.model ?? null, effort: row?.effort ?? null, permissionMode: row?.permission_mode ?? null }
  if (target) {
    // Se lança, a troca para aqui: nada foi criado nem pausado.
    await deps.manager.stop(target.localId)
    const still = deps.manager.get(target.localId)
    if (still && ACTIVE.has(still.status)) throw new UserError('handoff_target_busy', 'O motor de destino não encerrou a conversa')
  }

  const state = deps.store.get(projectId, to)
  const pauseGoal = state.goalStatus === 'active' || state.goalStatus === 'waiting'
  if (pauseGoal) deps.store.setGoalStatus(projectId, to, 'paused', 'operator')
  try {
    // A marca do reinício sai (o `dismiss` também publica); sem marca, só a pausa do goal vai à tela.
    if (state.interruptedAt != null) deps.restart.dismiss(projectId, to)
    else if (pauseGoal) deps.restart.publish(projectId, to)
  } catch (err) {
    console.error('[troca de motor] publicar o estado do destino falhou', err)
  }

  const session = deps.manager.start(project, {
    engine: to,
    continueLatest: false,
    ...(prefs.model ? { model: prefs.model } : {}),
    ...(prefs.effort ? { effort: prefs.effort } : {}),
    ...(prefs.permissionMode ? { permissionMode: prefs.permissionMode as PermissionMode } : {}),
  })
  try {
    deps.manager.sendAsClaudinei(session.localId, pack.text)
  } catch (err) {
    console.error('[troca de motor] o pacote não saiu', err)
  }
  return deps.manager.get(session.localId) ?? session
}
