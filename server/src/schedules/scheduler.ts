import type { Db } from '../db.js'
import type { SessionInfo } from '../claude/manager.js'
import type { Project } from '../projects.js'
import type { Schedule, SchedulesStore } from './store.js'

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
}

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
   * engine; sem, a primeira viva do projeto. Devolve também se foi ESTA chamada
   * que subiu a sessão — é o que decide se o effort vai como flag ou como turno.
   */
  function resolveSession(s: Schedule): { info: SessionInfo; justStarted: boolean } {
    const mine = manager.list().filter((x) => x.projectId === s.projectId && (!s.engine || x.engine === s.engine))
    const ready = mine.find((x) => READY.has(x.status))
    if (ready) return { info: ready, justStarted: false }
    if (mine.some((x) => BUSY.has(x.status) || x.status === 'in_terminal')) {
      throw new OverlapError('a sessão está ocupada')
    }

    // Reviver preserva a conversa; começar do zero perde o contexto que o
    // agendamento pode depender ("continue de onde parou ontem").
    const revivable = mine.find((x) => x.status === 'stopped' || x.status === 'dead')
    if (revivable) return { info: manager.revive(revivable.localId), justStarted: true }

    const project = projectOf(s.projectId)
    if (!project) throw new Error('projeto do agendamento não existe mais')
    return {
      info: manager.start(project, { engine: s.engine ?? undefined, model: s.model ?? undefined, effort: s.effort ?? undefined }),
      justStarted: true,
    }
  }

  /** Sinaliza sobreposição — não é falha do agendamento, é "agora não". */
  class OverlapError extends Error {}

  async function applyOptions(s: Schedule, info: SessionInfo, justStarted: boolean): Promise<void> {
    if (s.model && s.model !== info.model) await manager.setSessionOptions(info.localId, { model: s.model })
    if (!s.effort || s.effort === info.effort) return
    if (justStarted) return  // já foi como flag de lançamento
    // Effort não tem control_request: vai como mensagem, e o resultado DELE é
    // esperado e descartado aqui — senão o feed guardaria a resposta do /effort
    // no lugar da resposta da tarefa.
    await manager.sendAndWait(info.localId, `/effort ${s.effort}`, { timeoutMs })
    await manager.setSessionOptions(info.localId, { effort: s.effort })
  }

  /** Executa um agendamento agora. `late` só marca o registro, não muda o comportamento. */
  async function fire(s: Schedule, opts: { late?: boolean } = {}): Promise<void> {
    if (store.hasRunning(s.id)) {
      const skipped = store.startRun(s.id, {})
      store.finishRun(skipped.id, { status: 'skipped', error: 'execução anterior ainda rodando' })
      notify('schedule_run', { scheduleId: s.id, projectId: s.projectId })
      return
    }

    const run = store.startRun(s.id, { late: opts.late })
    notify('schedule_run', { scheduleId: s.id, projectId: s.projectId, running: true })
    try {
      const { info, justStarted } = resolveSession(s)
      await applyOptions(s, info, justStarted)
      const text = `[Agendamento: ${s.name} #${run.seq}]: ${s.task}`
      const result = await manager.sendAndWait(info.localId, text, { timeoutMs, wait: s.expectsResult })
      store.finishRun(run.id, {
        status: 'ok',
        content: s.expectsResult ? result ?? '' : undefined,
        localId: info.localId,
      })
    } catch (err) {
      const message = (err as Error).message
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
