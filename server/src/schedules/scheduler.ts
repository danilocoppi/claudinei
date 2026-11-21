import type { Db } from '../db.js'
import type { SessionInfo } from '../claude/manager.js'
import type { Project } from '../projects.js'
import type { Schedule, SchedulesStore } from './store.js'
import { getEngine, hasEngine } from '../engine/index.js'
import { enginesOf } from '../terminal-engines.js'
import { RESTART_FAIL_TEXT } from '../restart/terminal-state.js'
import { USAGE_LIMIT_FAIL_PREFIX } from '../limit/texts.js'
import { SCHEDULE_RUN_TEXTS } from '../../../shared/schedule-run.js'

/**
 * O que o agendador precisa do gerenciador de sessões — e só isso. A superfície
 * estreita é o que permite testar o agendador inteiro sem subir uma CLI.
 */
export interface SchedulerManager {
  list(): SessionInfo[]
  start(project: Project, opts?: { engine?: string; model?: string; effort?: string }): SessionInfo
  revive(localId: string): SessionInfo
  setSessionOptions(localId: string, opts: { model?: string; effort?: string }): Promise<SessionInfo>
  sendAndWait(localId: string, text: string, opts?: { timeoutMs?: number; wait?: boolean }): Promise<string | null>
}

export interface SchedulerDeps {
  db: Db
  store: SchedulesStore
  manager: SchedulerManager
  broadcast?: (msg: object) => void
  /** Teto de espera pela resposta de uma execução. */
  timeoutMs?: number
  /** Intervalo do laço. */
  tickMs?: number
  /**
   * O terminal (projeto + motor) tem aviso aberto esperando o operador (reinício
   * sem retomada automática, ou o limite de uso): a execução não fala com ele,
   * como a fila do operador e as tarefas de outros agentes. Ausente = nenhum.
   * Um texto em vez de `true` é o motivo gravado na execução pulada (a escrita
   * do desfazer segura pelo mesmo caminho, com motivo próprio).
   */
  holds?: (projectId: number, engine: string) => boolean | string
}

/** Motivo gravado na execução pulada por aviso aberto no terminal. */
export const NOTICE_HELD_TEXT = SCHEDULE_RUN_TEXTS.noticeHeld
/** Motivo gravado na execução pulada pela escrita do desfazer (ou pela volta da conversa) no terminal. */
export const UNDO_HELD_TEXT = SCHEDULE_RUN_TEXTS.undoHeld

/** Estados em que a sessão está de pé e aceita uma mensagem nova agora. */
const READY = new Set(['idle', 'needs_attention', 'starting'])
/** Ocupada: existe um turno em andamento (do operador ou de outra execução). */
const BUSY = new Set(['working'])
/** Atraso a partir do qual a execução é "recuperada", e não pontual. */
const LATE_AFTER_MS = 90_000

export function createScheduler(deps: SchedulerDeps) {
  const { db, store, manager } = deps
  const timeoutMs = deps.timeoutMs ?? 1_800_000
  let timer: ReturnType<typeof setInterval> | null = null

  const projectOf = (id: number): Project | null =>
    (db.prepare(`SELECT * FROM projects WHERE id=?`).get(id) as Project | undefined) ?? null

  const notify = (kind: string, payload: Record<string, unknown>) => deps.broadcast?.({ type: kind, ...payload })

  /**
   * A sessão em que este agendamento deve falar. Com engine fixada, é a daquela
   * engine, mesmo que o motor tenha saído da lista do terminal. Sem, só contam
   * os motores da lista: a primeira de pé, senão a parada mais recente, senão
   * uma nova no primeiro motor da lista que o servidor conhece.
   */
  function resolveSession(s: Schedule): SessionInfo {
    const listed = s.engine ? null : enginesOf(db, s.projectId)
    const mine = manager.list().filter((x) => x.projectId === s.projectId &&
      (s.engine ? x.engine === s.engine : listed!.includes(x.engine)))
    // Terminal com aviso aberto não serve: a escolha passa ao próximo motor
    // (sem motor fixo); se nenhum servir por causa do aviso, a execução é
    // pulada com o motivo do primeiro que segurou.
    let heldReason: string | null = null
    const usable = (engine: string): boolean => {
      const held = deps.holds?.(s.projectId, engine)
      if (!held) return true
      heldReason ??= typeof held === 'string' ? held : NOTICE_HELD_TEXT
      return false
    }
    const ready = mine.find((x) => READY.has(x.status) && usable(x.engine))
    if (ready) return ready
    if (mine.some((x) => BUSY.has(x.status) || x.status === 'in_terminal')) {
      throw new OverlapError(SCHEDULE_RUN_TEXTS.sessionBusy)
    }

    // Reviver preserva a conversa; começar do zero perde o contexto que o
    // agendamento pode depender ("continue de onde parou ontem"). A mais recente
    // pelo updatedAt: a ordem do manager.list() não garante isso (as sessões
    // vivas entram no fim). No empate, vale a ordem da lista.
    const revivable = mine
      .filter((x) => (x.status === 'stopped' || x.status === 'dead') && usable(x.engine))
      .reduce<SessionInfo | undefined>((best, x) => (!best || x.updatedAt > best.updatedAt ? x : best), undefined)
    if (revivable) return manager.revive(revivable.localId)

    const project = projectOf(s.projectId)
    if (!project) throw new Error(SCHEDULE_RUN_TEXTS.projectGone)
    // Sem motor conhecido na lista (só ids de uma versão futura), fica o padrão do manager.
    const engine = s.engine
      ? (usable(s.engine) ? s.engine : undefined)
      : listed!.find((id) => hasEngine(id) && usable(id))
    // Com aviso aberto no motor fixo, ou em todos os listados, a execução é pulada.
    if (!engine && heldReason) throw new NoticeHeldError(heldReason)
    return manager.start(project, { engine, model: s.model ?? undefined, effort: s.effort ?? undefined })
  }

  /** Sinaliza sobreposição — não é falha do agendamento, é "agora não". */
  class OverlapError extends Error {}
  /** O terminal tem aviso aberto esperando o operador: "agora não", sem contar falha. */
  class NoticeHeldError extends Error {}

  async function applyOptions(s: Schedule, info: SessionInfo): Promise<void> {
    if (s.model && s.model !== info.model) await manager.setSessionOptions(info.localId, { model: s.model })
    if (!s.effort || s.effort === info.effort) return
    // Sessão nova já devolve o effort de lançamento em info. Uma revivida pode
    // conservar outro valor e precisa receber o override pedido pelo agendamento.
    // Effort não tem control_request: vai como mensagem, e o resultado DELE é
    // esperado e descartado aqui — senão o feed guardaria a resposta do /effort
    // no lugar da resposta da tarefa.
    const caps = getEngine(info.engine).capabilities()
    if (caps.slashSource === 'protocol' || caps.slashCommands.includes('effort')) {
      await manager.sendAndWait(info.localId, `/effort ${s.effort}`, { timeoutMs })
    }
    await manager.setSessionOptions(info.localId, { effort: s.effort })
  }

  /** Executa um agendamento agora. `late` só marca o registro, não muda o comportamento. */
  async function fire(s: Schedule, opts: { late?: boolean } = {}): Promise<void> {
    if (store.hasRunning(s.id)) {
      const skipped = store.startRun(s.id, {})
      store.finishRun(skipped.id, { status: 'skipped', error: SCHEDULE_RUN_TEXTS.previousRunning })
      notify('schedule_run', { scheduleId: s.id, projectId: s.projectId })
      return
    }

    const run = store.startRun(s.id, { late: opts.late })
    notify('schedule_run', { scheduleId: s.id, projectId: s.projectId, running: true })
    try {
      const info = resolveSession(s)
      await applyOptions(s, info)
      const text = `[Agendamento: ${s.name} #${run.seq}]: ${s.task}`
      const result = await manager.sendAndWait(info.localId, text, { timeoutMs, wait: s.expectsResult })
      store.finishRun(run.id, {
        status: 'ok',
        content: s.expectsResult ? result ?? '' : undefined,
        localId: info.localId,
      })
    } catch (err) {
      const message = (err as Error).message
      // Aviso aberto no terminal: pulada, e a contagem de falhas fica como está.
      if (err instanceof NoticeHeldError) {
        store.finishRun(run.id, { status: 'skipped', error: message, countFailure: false })
        notify('schedule_run', { scheduleId: s.id, projectId: s.projectId })
        return
      }
      // O reinício derrubou o turno (sendAndWait recusa com este texto): erro, mas
      // não falha seguida da tarefa, como no closeInterruptedRuns da subida.
      if (message === RESTART_FAIL_TEXT) {
        store.finishRun(run.id, { status: 'error', error: RESTART_FAIL_TEXT, countFailure: false })
        notify('schedule_run', { scheduleId: s.id, projectId: s.projectId })
        return
      }
      // O turno bateu no limite de uso do Claude: erro, mas a tarefa não falhou.
      // Também não tenta de novo quando a janela reabre: a próxima é a da cadência.
      if (message.startsWith(USAGE_LIMIT_FAIL_PREFIX)) {
        store.finishRun(run.id, { status: 'error', error: message, countFailure: false })
        notify('schedule_run', { scheduleId: s.id, projectId: s.projectId })
        return
      }
      const status = err instanceof OverlapError ? 'skipped'
        : /timed out/i.test(message) ? 'timeout'
          : 'error'
      store.finishRun(run.id, { status, error: message })
    }
    notify('schedule_run', { scheduleId: s.id, projectId: s.projectId })
  }

  return {
    /**
     * Uma passada: dispara o que venceu e reagenda. Execuções perdidas enquanto o
     * servidor esteve fora caem aqui naturalmente — `due` as devolve, elas rodam UMA
     * vez (marcadas como atrasadas) e o reagendamento salta para a próxima futura.
     */
    async tick(now = new Date()): Promise<void> {
      for (const s of store.due(now)) {
        const late = now.getTime() - new Date(s.nextRunAt!).getTime() > LATE_AFTER_MS
        // Reagenda ANTES de executar: uma execução longa não pode fazer o próximo
        // tick disparar a mesma coisa de novo.
        store.reschedule(s.id, now)
        await fire(s, { late })
      }
    },

    /** Disparo manual: não mexe no horário da próxima execução automática. */
    async runNow(scheduleId: number): Promise<void> {
      const s = store.get(scheduleId)
      if (!s) throw new Error(`agendamento ${scheduleId} não existe`)
      await fire(s)
    },

    start(): void {
      if (timer) return
      timer = setInterval(() => {
        void this.tick().catch((err) => console.error('[scheduler] tick falhou', err))
      }, deps.tickMs ?? 30_000)
      timer.unref?.()
    },

    stop(): void {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
  }
}

export type Scheduler = ReturnType<typeof createScheduler>
