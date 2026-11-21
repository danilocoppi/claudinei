import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { createProjectsService } from '../projects.js'
import { createTasksService } from '../tasks.js'
import { enginesOf } from '../terminal-engines.js'
import { UserError } from '../user-error.js'
import { toDto, type HoldReason, type TerminalStateDto, type TerminalStateRow, type TerminalStateStore } from './terminal-state.js'
import type { UsageLimitService } from '../limit/usage-limit.js'

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

/** Quanto vale um limite sem reabertura conhecida: o tamanho da janela curta do Claude. */
export const UNKNOWN_RESET_ACTIVE_MS = 5 * 3600_000

/**
 * `limitHitAt` vem do `datetime('now')` do SQLite: 'YYYY-MM-DD HH:MM:SS', em
 * UTC e sem fuso escrito. Devolve epoch ms, ou NaN se não der para ler.
 */
const sqliteUtcMs = (s: string): number => Date.parse(`${s.replace(' ', 'T')}Z`)

/**
 * Limite de uso ainda ativo: com a reabertura (`limitResetsAt`, epoch
 * SEGUNDOS) ainda no futuro; sem reabertura conhecida, só até 5 h depois de
 * gravado (sem o teto, ele seguraria a retomada do reinício para sempre; data
 * ilegível não segura); ou com a retomada armada, mesmo já vencida: quem manda
 * a mensagem é o serviço do limite, e a marca do reinício é absorvida (nunca
 * duas retomadas). Em `none` ou `snoozed` com a reabertura passada, o reinício
 * retoma como sempre.
 */
export function limitActive(r: TerminalStateRow, now: number = Date.now()): boolean {
  if (r.limitHitAt == null) return false
  if (r.limitAction === 'armed') return true
  if (r.limitResetsAt == null) return sqliteUtcMs(r.limitHitAt) + UNKNOWN_RESET_ACTIVE_MS > now
  return r.limitResetsAt * 1000 > now
}

/**
 * Decide o que fazer com cada terminal na subida, na ordem do desenho:
 * interrompido com limite de uso ativo é pulado (a retomada fica com o serviço
 * do limite, e o `boot` absorve a marca); pergunta aberta segura; retomar
 * ligado retoma até o teto; retomar desligado segura; sem interrupção, sobe
 * parado se "iniciar" estiver ligado.
 *
 * Marca nova (encerramento ou queda) sempre chega sem motivo de espera. Uma com
 * motivo foi segurada numa subida anterior e esperava o operador: segue segurada
 * com o mesmo motivo, mesmo que o retomar tenha sido ligado depois (e a `failed`
 * não é tentada de novo sozinha).
 *
 * A lista de motores do terminal (`isListed`) só controla o "iniciar": um motor
 * fora dela não sobe parado (nem idle, nem hold com `alsoIdle`), mesmo com o
 * interruptor ligado. Trabalho interrompido segue as regras acima, inclusive a
 * retomada, porque a sessão estava viva quando o serviço caiu.
 *
 * Saída ordenada: primeiro as retomadas, depois as subidas paradas (idle e hold
 * com `alsoIdle`) na ordem de entrada e, por último, os holds que não sobem nada.
 */
export function planBoot(
  rows: TerminalStateRow[],
  latestLocalId: (projectId: number, engine: string) => string | null,
  isListed: (projectId: number, engine: string) => boolean = () => true,
  now: number = Date.now(),
): BootAction[] {
  const resumes: BootAction[] = []
  const risers: BootAction[] = []
  const holds: BootAction[] = []
  for (const r of rows) {
    const { projectId, engine } = r
    const autostart = r.autostart && isListed(projectId, engine)
    if (r.interruptedAt == null) {
      if (autostart) risers.push({ kind: 'idle', projectId, engine, localId: latestLocalId(projectId, engine) })
      continue
    }
    // Nem resume, nem idle, nem hold: duas mensagens de retomada na mesma janela, nunca.
    if (limitActive(r, now)) continue
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
    const hold: BootAction = { kind: 'hold', projectId, engine, reason, alsoIdle: autostart, localId }
    ;(autostart ? risers : holds).push(hold)
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
  /**
   * Acrescenta ao estado publicado (e à lista) o que é de outros serviços, como
   * os resultados de tarefa pendentes. Lido a cada publicação.
   */
  decorate?: (projectId: number, engine: string) => Partial<TerminalStateDto>
  /**
   * Terminais que o `decorate` tem algo a mostrar: entram na lista mesmo sem
   * linha de estado (a linha só nasce quando algo do reinício é gravado).
   */
  decoratedTerminals?: () => Array<{ projectId: number; engine: string }>
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

  /** O estado do terminal com o que os outros serviços acrescentam; falha deles não derruba a publicação. */
  const stateOf = (row: TerminalStateRow): TerminalStateDto => {
    const dto = toDto(row)
    if (!deps.decorate) return dto
    try {
      return { ...dto, ...deps.decorate(row.projectId, row.engine) }
    } catch (err) {
      log(`[reinício] decorar ${row.projectId}/${row.engine} falhou: ${(err as Error)?.message ?? err}`)
      return dto
    }
  }

  const publish = (projectId: number, engine: string): TerminalStateDto => {
    const state = stateOf(store.get(projectId, engine))
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
      const rows = store.list()
      const now = Date.now()
      const actions = planBoot(rows, latestLocalId, (p, e) => enginesOf(db, p).includes(e), now)
      // Marca de quem bateu o limite: absorvida pelo limite, que retoma sozinho
      // (ou espera o operador) quando a janela reabrir. Nada foi anotado para
      // esse terminal, então as tarefas dele fecham no laço abaixo, como no ×.
      for (const r of rows) {
        if (r.interruptedAt == null || !limitActive(r, now)) continue
        dropInterruption(r.projectId, r.engine)
        publish(r.projectId, r.engine)
      }
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

    /** Para o serviço do limite: garante a sessão de pé do terminal (veja acima). */
    bringUp,

    /** Para o serviço do limite publicar o estado no mesmo formato. */
    publish,

    /** O estado do terminal como as telas o recebem (com o que os outros serviços acrescentam), sem publicar. */
    state: (projectId: number, engine: string): TerminalStateDto => stateOf(store.get(projectId, engine)),

    /**
     * O limite absorve a marca do reinício: ela sai sem retomar, e as tarefas
     * anotadas do turno fecham como no ×. Nada durante o encerramento (a marca
     * é da próxima subida), e sem marca não publica: não há o que mudar.
     */
    absorbInterruption(projectId: number, engine: string): void {
      if (manager.isShuttingDown()) return
      if (dropInterruption(projectId, engine)) publish(projectId, engine)
    },

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

    setPrefs(
      projectId: number, engine: string,
      p: { autostart?: boolean; autoResume?: boolean; autoResumeLimit?: boolean },
    ): TerminalStateDto {
      store.setPrefs(projectId, engine, p)
      return publish(projectId, engine)
    },

    list(): TerminalStateDto[] {
      const rows = store.list()
      const known = new Set(rows.map((r) => keyOf(r.projectId, r.engine)))
      let extra: Array<{ projectId: number; engine: string }> = []
      try { extra = deps.decoratedTerminals?.() ?? [] } catch (err) {
        log(`[reinício] terminais decorados falharam: ${(err as Error)?.message ?? err}`)
      }
      for (const t of extra) {
        if (known.has(keyOf(t.projectId, t.engine))) continue
        known.add(keyOf(t.projectId, t.engine))
        rows.push(store.get(t.projectId, t.engine))
      }
      return rows.map(stateOf)
    },
  }
}

export type RestartService = ReturnType<typeof createRestartService>

/**
 * O que roda depois do `listen`: antes de tudo, a do desfazer turno (fecha como
 * incertos os turnos que ficaram abertos, antes de qualquer sessão voltar e
 * mandar eventos ao rastreador); então a subida dos terminais, depois a do
 * limite de uso, então a dos avisos de resultado de tarefa pendentes (que
 * esperam as retomadas: o terminal interrompido segura até a dele), por fim o
 * agendador, para que um agendamento não dispute a sessão com uma retomada. A
 * ordem entre as duas primeiras importa: uma retomada armada absorve a marca do
 * reinício, e a garantia de uma só mensagem por janela depende de a subida do
 * reinício ter terminado antes. Falha de uma subida é registrada e nunca sobe:
 * ela não pode impedir as seguintes. Se o encerramento começou no meio, o que
 * falta fica desligado.
 */
export async function startAfterListen(deps: {
  undo?: { boot(): Promise<void> }
  restart: Pick<RestartService, 'boot'> | undefined
  limit?: Pick<UsageLimitService, 'boot'>
  taskWake?: { boot(): Promise<void> }
  scheduler: { start(): void } | undefined
  isShuttingDown?: () => boolean
  log?: (msg: string) => void
}): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg))
  try {
    await deps.undo?.boot()
  } catch (err) {
    log(`[desfazer] a subida do desfazer falhou: ${(err as Error)?.message ?? err}`)
  }
  try {
    await deps.restart?.boot()
  } catch (err) {
    log(`[reinício] a subida dos terminais falhou: ${(err as Error)?.message ?? err}`)
  }
  if (deps.isShuttingDown?.()) return
  try {
    await deps.limit?.boot()
  } catch (err) {
    log(`[limite] a subida do limite de uso falhou: ${(err as Error)?.message ?? err}`)
  }
  if (deps.isShuttingDown?.()) return
  try {
    await deps.taskWake?.boot()
  } catch (err) {
    log(`[aviso de tarefa] a subida dos avisos pendentes falhou: ${(err as Error)?.message ?? err}`)
  }
  if (deps.isShuttingDown?.()) return
  deps.scheduler?.start()
}
