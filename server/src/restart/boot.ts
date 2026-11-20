import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { createProjectsService } from '../projects.js'
import { createTasksService } from '../tasks.js'
import { UserError } from '../user-error.js'
import { toDto, type HoldReason, type TerminalStateDto, type TerminalStateRow, type TerminalStateStore } from './terminal-state.js'

/** Marca da mensagem de retomada: a interface a reconhece e mostra como vinda do Claudinei. */
export const RESUME_PREFIX = '[Claudinei: resume after restart]'
/** O texto vai ao agente, então fica em inglês (como as regras do Hermes). */
export const RESUME_TEXT = `${RESUME_PREFIX}: The Claudinei service restarted in the middle of your turn. Continue where you left off; check the current state of the files before redoing anything.`
/** Teto de retomadas automáticas seguidas sem o turno terminar. */
export const MAX_AUTO_RESUMES = 3

export type BootAction =
  | { kind: 'resume'; projectId: number; engine: string; localId: string }
  | { kind: 'idle'; projectId: number; engine: string; localId: string | null }   // null = sem sessão anterior → start
  | { kind: 'hold'; projectId: number; engine: string; reason: HoldReason; alsoIdle: boolean; localId: string | null }

/** Status em que a sessão está de pé (o mesmo ACTIVE do manager). */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

/**
 * Decide o que fazer com cada terminal na subida, na ordem do desenho:
 * pergunta aberta segura; retomar ligado retoma até o teto; retomar desligado
 * segura; sem interrupção, sobe parado se "iniciar" estiver ligado.
 *
 * Marca nova (encerramento ou queda) sempre chega sem motivo de espera. Uma com
 * motivo foi segurada numa subida anterior e esperava o operador: segue segurada
 * com o mesmo motivo, mesmo que o retomar tenha sido ligado depois (e a `failed`
 * não é tentada de novo sozinha).
 *
 * Saída ordenada: primeiro as retomadas, depois as subidas paradas (idle e hold
 * com `alsoIdle`) na ordem de entrada e, por último, os holds que não sobem nada.
 */
export function planBoot(
  rows: TerminalStateRow[],
  latestLocalId: (projectId: number, engine: string) => string | null,
): BootAction[] {
  const resumes: BootAction[] = []
  const risers: BootAction[] = []
  const holds: BootAction[] = []
  for (const r of rows) {
    const { projectId, engine } = r
    if (r.interruptedAt == null) {
      if (r.autostart) risers.push({ kind: 'idle', projectId, engine, localId: latestLocalId(projectId, engine) })
      continue
    }
    const localId = r.interruptedLocalId ?? latestLocalId(projectId, engine)
    // Pergunta gravada como lista vazia não é pergunta (markInterrupted guarda `[]`).
    let reason: HoldReason | null
    if (r.holdReason != null) reason = r.holdReason
    else if (r.lostQuestion && r.lostQuestion.length > 0) reason = 'question'
    else if (!r.autoResume) reason = 'off'
    else if (r.resumeCount >= MAX_AUTO_RESUMES) reason = 'limit'
    else reason = localId ? null : 'failed'   // sem sessão nenhuma para retomar
    if (reason == null) {
      resumes.push({ kind: 'resume', projectId, engine, localId: localId! })
      continue
    }
    const hold: BootAction = { kind: 'hold', projectId, engine, reason, alsoIdle: r.autostart, localId }
    ;(r.autostart ? risers : holds).push(hold)
  }
  return [...resumes, ...risers, ...holds]
}

type Orchestrator = { reattach(taskId: number, localId: string): boolean; failInterrupted(taskId: number): void }

/**
 * O serviço do reinício: a subida em lotes e o que a interface e o manager
 * pedem depois dela (Continuar, fechar o aviso, interruptores, contador).
 */
export function createRestartService(deps: {
  db: Db; manager: SessionManager; store: TerminalStateStore
  orchestrator: () => Orchestrator | undefined
  broadcast: (msg: object) => void          // { type: 'terminal_state', state: TerminalStateDto }
  /**
   * Fecha as execuções de agendamento que o reinício matou (o store dos
   * agendamentos vive no app). Obrigatório: esquecê-lo deixaria execuções
   * `running` para sempre, travando o agendamento.
   */
  closeInterruptedRuns: () => number
  batchSize?: number; gapMs?: number; sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
  /**
   * Um aviso de trabalho interrompido acabou de ficar retido esperando o
   * operador (na subida ou na retomada que falha): liga ao despertador da triagem.
   */
  onHeld?: (projectId: number) => void
}) {
  const { db, manager, store } = deps
  const batchSize = deps.batchSize ?? 3
  const gapMs = deps.gapMs ?? 5000
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? ((msg: string) => console.error(msg))
  const projects = createProjectsService(db)
  const tasks = createTasksService(db)

  const latestSql = db.prepare(
    `SELECT local_id FROM sessions WHERE project_id = ? AND engine = ?
      ORDER BY updated_at DESC, local_id DESC LIMIT 1`,
  )
  const existsSql = db.prepare(`SELECT 1 FROM sessions WHERE local_id = ?`)
  const latestLocalId = (projectId: number, engine: string): string | null =>
    (latestSql.get(projectId, engine) as { local_id: string } | undefined)?.local_id ?? null

  const publish = (projectId: number, engine: string): TerminalStateDto => {
    const state = toDto(store.get(projectId, engine))
    deps.broadcast({ type: 'terminal_state', state })
    return state
  }

  /**
   * Um aviso acabou de ficar retido esperando o operador: acorda o terminal.
   * Só onde o aviso NASCE retido (a subida, a retomada que falha); republicar
   * um aviso que já existia (os interruptores do ⚙) não acorda de novo, senão
   * desfaria o assentar que alguém fez depois. O despertador grava no banco, e
   * uma falha dele não pode parar a subida.
   */
  const held = (projectId: number): void => {
    try { deps.onHeld?.(projectId) } catch (err) { log(`[reinício] despertar ${projectId} falhou: ${(err as Error)?.message ?? err}`) }
  }

  /**
   * Tarefas presas ao turno interrompido de cada terminal que vai retomar
   * (chave `projeto:motor`), anotadas na subida. Só elas são religadas ou
   * fechadas: uma tarefa entregue ao terminal DEPOIS da subida corre num turno
   * novo e não tem nada a ver com o reinício.
   */
  const interruptedTasks = new Map<string, number[]>()
  const keyOf = (projectId: number, engine: string) => `${projectId}:${engine}`

  /** Fecha como interrompidas as tarefas anotadas do terminal: o turno delas não volta. */
  const failTasksOf = (projectId: number, engine: string): void => {
    const ids = interruptedTasks.get(keyOf(projectId, engine)) ?? []
    interruptedTasks.delete(keyOf(projectId, engine))
    const orch = deps.orchestrator()
    if (orch) for (const id of ids) orch.failInterrupted(id)
  }

  /** A sessão de pé do terminal, se houver. */
  const liveOf = (projectId: number, engine: string) =>
    manager.list().find((s) => s.projectId === projectId && s.engine === engine && ACTIVE.has(s.status))

  /**
   * Garante uma sessão de pé no terminal e devolve o local id dela. Já viva:
   * usa essa. Senão revive a preferida (se a linha ainda existe), a mais
   * recente do terminal ou, sem nenhuma, abre uma nova continuando a conversa
   * mais recente da pasta. Erro do revive/start sobe para quem chamou.
   */
  const bringUp = (projectId: number, engine: string, preferred: string | null): string => {
    const live = liveOf(projectId, engine)
    if (live) return live.localId
    const localId = preferred && existsSql.get(preferred) ? preferred : latestLocalId(projectId, engine)
    if (localId) return manager.revive(localId).localId
    const project = projects.get(projectId)
    if (!project) throw new Error(`projeto ${projectId} não existe`)
    return manager.start(project, { engine, continueLatest: true }).localId
  }

  /**
   * Retoma o turno interrompido: o Continuar e a retomada automática passam por
   * aqui. A marca sai (atomicamente) antes do envio: dois pedidos juntos mandam
   * uma mensagem só, e o segundo recebe `false`. Revive antes de tirar a marca,
   * para que um revive que falha deixe o terminal interrompido.
   *
   * Com o serviço encerrando devolve `false` sem tocar em nada: a marca acabou de
   * ser gravada para a próxima subida, e um revive agora subiria um processo que
   * o `stopAll` não conhece. No Continuar, sessão no meio de um turno recusa com
   * `session_busy`: a mensagem de retomada cairia num turno que não é o perdido.
   */
  function resumeTerminal(projectId: number, engine: string, opts?: { auto?: boolean }): boolean {
    if (manager.isShuttingDown()) return false
    const current = store.get(projectId, engine)
    if (current.interruptedAt == null) return false
    if (!opts?.auto) {
      const live = liveOf(projectId, engine)
      if (live && (live.status === 'working' || live.compactingSince !== undefined)) {
        throw new UserError('session_busy', 'sessão está trabalhando; aguarde o turno terminar')
      }
    }
    const localId = bringUp(projectId, engine, current.interruptedLocalId)
    const taken = store.takeInterruption(projectId, engine)
    if (!taken) return false
    // Só a retomada automática conta para o teto; o Continuar é o operador agindo.
    if (opts?.auto) store.bumpResume(projectId, engine)
    else store.resetResume(projectId, engine)
    try {
      manager.sendAsClaudinei(localId, RESUME_TEXT)
    } catch (err) {
      // A mensagem não saiu: a marca volta, como falha, para o operador decidir.
      store.markInterrupted(projectId, engine, taken.interruptedLocalId ?? localId, taken.lostQuestion)
      store.setHold(projectId, engine, 'failed')
      publish(projectId, engine)
      held(projectId)
      throw err
    }
    // Só as tarefas do turno interrompido (anotadas na subida). As de um terminal
    // segurado já fecharam na subida; as entregues depois dela têm o próprio ouvinte.
    const ids = interruptedTasks.get(keyOf(projectId, engine)) ?? []
    interruptedTasks.delete(keyOf(projectId, engine))
    const orch = deps.orchestrator()
    if (orch) for (const id of ids) orch.reattach(id, localId)
    publish(projectId, engine)
    return true
  }

  /**
   * A marca sai sem retomar (o operador fechou o aviso ou mandou outra mensagem):
   * o turno interrompido não volta, então as tarefas presas a ele fecham.
   */
  const dropInterruption = (projectId: number, engine: string): boolean => {
    if (store.get(projectId, engine).interruptedAt == null) return false
    store.clearInterruption(projectId, engine)
    failTasksOf(projectId, engine)
    return true
  }

  const runAction = (a: BootAction): void => {
    try {
      if (a.kind === 'resume') {
        // O revive vem dentro do resumeTerminal: falso = alguém já retomou ou dispensou.
        resumeTerminal(a.projectId, a.engine, { auto: true })
      } else {
        bringUp(a.projectId, a.engine, a.localId)
      }
    } catch (err) {
      log(`[reinício] terminal ${a.projectId}/${a.engine} não subiu: ${(err as Error)?.message ?? err}`)
      // Um aviso que já estava retido (de uma subida anterior, ou deste mesmo
      // boot) só troca de motivo: não nasce agora, então não acorda de novo.
      const wasHeld = store.get(a.projectId, a.engine).holdReason != null
      store.setHold(a.projectId, a.engine, 'failed')
      failTasksOf(a.projectId, a.engine)
      publish(a.projectId, a.engine)
      if (!wasHeld) held(a.projectId)
    }
  }

  return {
    /**
     * A subida: fecha as execuções de agendamento interrompidas, decide cada
     * terminal, fecha as tarefas de quem não retoma e sobe em lotes, primeiro as
     * retomadas. Se um encerramento começar (ou a espera entre lotes rejeitar),
     * os lotes param e o resto fica marcado para a próxima subida.
     */
    async boot(): Promise<void> {
      deps.closeInterruptedRuns()
      const actions = planBoot(store.list(), latestLocalId)
      for (const a of actions) {
        if (a.kind !== 'hold') continue
        // Marca que já tinha motivo foi retida (e acordou) numa subida anterior e
        // segue esperando o operador: acordar de novo a cada reinício desfaria o
        // assentar ou o adiar que ele fez depois.
        const wasHeld = store.get(a.projectId, a.engine).holdReason != null
        store.setHold(a.projectId, a.engine, a.reason)
        publish(a.projectId, a.engine)
        if (!wasHeld) held(a.projectId)
      }
      const resuming = new Set(actions.filter((a) => a.kind === 'resume').map((a) => keyOf(a.projectId, a.engine)))
      const orch = deps.orchestrator()
      for (const t of tasks.listInProgress()) {
        const key = keyOf(t.toProjectId, t.toEngine ?? '')
        if (resuming.has(key)) interruptedTasks.set(key, [...(interruptedTasks.get(key) ?? []), t.id])
        else orch?.failInterrupted(t.id)
      }
      const risers = actions.filter((a) => a.kind !== 'hold' || a.alsoIdle)
      for (let i = 0; i < risers.length; i += batchSize) {
        if (i > 0) await sleep(gapMs)
        // Serviço encerrando: subir mais terminais só para derrubá-los logo depois.
        if (manager.isShuttingDown()) {
          log(`[reinício] encerramento em curso: ${risers.length - i} terminal(is) ficam para a próxima subida`)
          return
        }
        for (const a of risers.slice(i, i + batchSize)) runAction(a)
      }
    },

    resumeTerminal,

    /**
     * Serviço encerrando: entre o `captureShutdown` e o fim do `stopAll`, nada
     * do que o operador faz pode apagar a marca recém-gravada. As rotas do
     * Continuar e do × respondem `shutting_down`.
     */
    isShuttingDown: (): boolean => manager.isShuttingDown(),

    dismiss(projectId: number, engine: string): void {
      if (manager.isShuttingDown()) return
      dropInterruption(projectId, engine)
      publish(projectId, engine)
    },

    onOperatorMessage(projectId: number, engine: string): void {
      if (manager.isShuttingDown()) return
      store.resetResume(projectId, engine)
      if (dropInterruption(projectId, engine)) publish(projectId, engine)
    },

    onTurnResult(projectId: number, engine: string): void {
      store.resetResume(projectId, engine)
      // Turno que terminou durante o encerramento não foi interrompido: a marca
      // que o captureShutdown gravou retomaria um trabalho já concluído.
      if (manager.isShuttingDown() && store.get(projectId, engine).interruptedAt != null) {
        store.clearInterruption(projectId, engine)
        publish(projectId, engine)
      }
    },

    setPrefs(projectId: number, engine: string, p: { autostart?: boolean; autoResume?: boolean }): TerminalStateDto {
      store.setPrefs(projectId, engine, p)
      return publish(projectId, engine)
    },

    list(): TerminalStateDto[] {
      return store.list().map(toDto)
    },
  }
}

export type RestartService = ReturnType<typeof createRestartService>

/**
 * O que roda depois do `listen`: primeiro a subida dos terminais, depois o
 * agendador, para que um agendamento não dispute a sessão com a retomada. Falha
 * da subida é registrada e nunca sobe: ela não pode impedir o agendador. Se o
 * encerramento começou durante a subida, o agendador fica desligado.
 */
export async function startAfterListen(deps: {
  restart: Pick<RestartService, 'boot'> | undefined
  scheduler: { start(): void } | undefined
  isShuttingDown?: () => boolean
  log?: (msg: string) => void
}): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg))
  try {
    await deps.restart?.boot()
  } catch (err) {
    log(`[reinício] a subida dos terminais falhou: ${(err as Error)?.message ?? err}`)
  }
  if (deps.isShuttingDown?.()) return
  deps.scheduler?.start()
}
