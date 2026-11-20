import type { SessionManager } from '../claude/manager.js'
import type { RestartService } from '../restart/boot.js'
import type { LimitOrigin, TerminalStateRow, TerminalStateStore } from '../restart/terminal-state.js'
import { UserError } from '../user-error.js'
import { LIMIT_RESUME_TEXT } from './texts.js'

/** Status em que a sessão está de pé (o mesmo ACTIVE do manager e do reinício). */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

/** Maior espera que o setTimeout aceita (~24,8 dias); acima disso ele dispara na hora. */
const MAX_TIMER_MS = 2 ** 31 - 1

type Timer = { clear(): void }

/**
 * O serviço do "bateu o limite": o estado do limite por terminal (projeto +
 * motor), um relógio único para as reaberturas e a retomada em lotes.
 *
 * Os horários do limite (`limitResetsAt`) são epoch SEGUNDOS; o relógio
 * trabalha em ms. Cada linha armada ou adiada vence em `resetsAt * 1000 +
 * graceMs`: a armada retoma o turno, a adiada só limpa o aviso.
 */
export function createUsageLimitService(deps: {
  manager: SessionManager; store: TerminalStateStore
  restart: Pick<RestartService, 'bringUp' | 'absorbInterruption' | 'publish'>
  now?: () => number; graceMs?: number
  setTimer?: (fn: () => void, ms: number) => Timer
  batchSize?: number; gapMs?: number; sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}) {
  const { manager, store, restart } = deps
  const now = deps.now ?? Date.now
  const graceMs = deps.graceMs ?? 60_000
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): Timer => {
    const t = setTimeout(fn, ms)
    return { clear: () => clearTimeout(t) }
  })
  const batchSize = deps.batchSize ?? 3
  const gapMs = deps.gapMs ?? 5000
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? ((msg: string) => console.error(msg))

  let timer: Timer | null = null
  let processing = false
  let disposed = false

  /**
   * Sessão em que o limite bateu, por terminal: a preferida para reviver. Só
   * memória; depois de uma subida o `bringUp` cai na mais recente do terminal.
   */
  const limitedLocal = new Map<string, string>()
  const keyOf = (projectId: number, engine: string) => `${projectId}:${engine}`

  /** Hora (ms) em que a linha vence; `null` sem reabertura conhecida (nunca vence). */
  const deadlineOf = (r: TerminalStateRow): number | null =>
    r.limitResetsAt == null ? null : r.limitResetsAt * 1000 + graceMs

  /** Armados e adiados com vencimento conhecido: é o que o relógio acompanha. */
  const clockRows = (): TerminalStateRow[] =>
    [...store.listArmed(), ...store.listSnoozed()].filter((r) => deadlineOf(r) != null)

  /**
   * Um único timer, para o próximo vencimento. Rearmado a cada mudança (o
   * anterior sai sempre). Durante um processamento não arma: ele rearma ao
   * terminar. Encerrando, nada: a próxima subida pega os armados no `boot`.
   */
  function rearm(): void {
    timer?.clear()
    timer = null
    if (disposed || processing || manager.isShuttingDown()) return
    const deadlines = clockRows().map((r) => deadlineOf(r)!)
    if (deadlines.length === 0) return
    const ms = Math.min(Math.max(0, Math.min(...deadlines) - now()), MAX_TIMER_MS)
    // Devolve a promessa (o setTimeout a ignora): os testes a esperam. O catch
    // garante que ela nunca rejeita, nem se o próprio log falhar.
    timer = setTimer(() => { timer = null; return processDue().catch(() => {}) }, ms)
  }

  /** A sessão de pé do terminal, se houver. */
  const liveOf = (projectId: number, engine: string) =>
    manager.list().find((s) => s.projectId === projectId && s.engine === engine && ACTIVE.has(s.status))

  /**
   * Retoma o turno que bateu no limite: o relógio (`auto`) e o "Continuar
   * agora" passam por aqui. O limite sai (atomicamente) antes do envio, então o
   * relógio e o clique juntos mandam uma mensagem só.
   *
   * No automático, só age se a linha ainda estiver armada (o operador pode ter
   * cancelado entre um lote e outro); com a sessão no meio de um turno, volta a
   * `none` (o aviso reaparece). No manual, a sessão ocupada recusa com
   * `session_busy`: a mensagem cairia num turno que não é o limitado.
   */
  function resumeAfterLimit(projectId: number, engine: string, opts: { auto: boolean }): boolean {
    if (manager.isShuttingDown()) return false
    const current = store.get(projectId, engine)
    if (current.limitHitAt == null) {
      if (opts.auto) return false
      throw new UserError('no_usage_limit', 'o terminal não está no limite de uso')
    }
    if (opts.auto) {
      // A lista do lote foi tirada antes das esperas: confere de novo que a linha
      // segue armada E vencida. Um Continuar no meio que bateu outro limite
      // (rearmado para a próxima janela) não pode receber a retomada agora.
      const deadline = deadlineOf(current)
      if (current.limitAction !== 'armed' || deadline == null || deadline > now()) return false
    }
    const live = liveOf(projectId, engine)
    if (live && (live.status === 'working' || live.compactingSince !== undefined)) {
      if (!opts.auto) throw new UserError('session_busy', 'sessão está trabalhando; aguarde o turno terminar')
      store.setLimitAction(projectId, engine, 'none')
      restart.publish(projectId, engine)
      return false
    }
    const localId = restart.bringUp(projectId, engine, limitedLocal.get(keyOf(projectId, engine)) ?? null)
    const taken = store.takeLimit(projectId, engine)
    if (!taken) return false
    limitedLocal.delete(keyOf(projectId, engine))
    // Só o automático conta para o teto de uma tentativa por janela; o clique é o operador.
    if (opts.auto) store.bumpLimitTries(projectId, engine)
    try {
      manager.sendAsClaudinei(localId, LIMIT_RESUME_TEXT)
    } catch (err) {
      // A mensagem não saiu: o aviso volta, em none, para o operador decidir.
      store.recordUsageLimit(projectId, engine, { resetsAt: taken.limitResetsAt, origin: taken.limitOrigin ?? 'claudinei' })
      rearm()
      restart.publish(projectId, engine)
      throw err
    }
    rearm()
    restart.publish(projectId, engine)
    return true
  }

  /**
   * O que venceu: os adiados só limpam o aviso; os armados retomam em lotes de
   * `batchSize`, com `gapMs` entre eles. A falha de um terminal fica no log, e
   * ele volta ao aviso em `none` (sem laço de novas tentativas). No fim, o
   * relógio vai para o próximo vencimento.
   */
  async function processDue(): Promise<void> {
    if (processing || disposed || manager.isShuttingDown()) return
    processing = true
    try {
      const t = now()
      const due = (r: TerminalStateRow) => deadlineOf(r) != null && deadlineOf(r)! <= t
      for (const r of store.listSnoozed().filter(due)) {
        store.clearLimit(r.projectId, r.engine)
        restart.publish(r.projectId, r.engine)
      }
      const armed = store.listArmed().filter(due)
      for (let i = 0; i < armed.length; i += batchSize) {
        if (i > 0) await sleep(gapMs)
        if (manager.isShuttingDown()) {
          log(`[limite] encerramento em curso: ${armed.length - i} retomada(s) ficam para a próxima subida`)
          return
        }
        for (const r of armed.slice(i, i + batchSize)) {
          try {
            resumeAfterLimit(r.projectId, r.engine, { auto: true })
          } catch (err) {
            log(`[limite] terminal ${r.projectId}/${r.engine} não retomou: ${(err as Error)?.message ?? err}`)
            const cur = store.get(r.projectId, r.engine)
            if (cur.limitHitAt != null && cur.limitAction === 'armed') store.setLimitAction(r.projectId, r.engine, 'none')
            restart.publish(r.projectId, r.engine)
          }
        }
      }
    } catch (err) {
      log(`[limite] o relógio falhou: ${(err as Error)?.message ?? err}`)
    } finally {
      processing = false
      // O rearme lê o banco e pode falhar: daqui a falha viraria rejeição sem
      // dono (o setTimeout não espera a promessa) e derrubaria o processo.
      try {
        rearm()
      } catch (err) {
        log(`[limite] o relógio não conseguiu rearmar: ${(err as Error)?.message ?? err}`)
      }
    }
  }

  /** O limite ativo do terminal, ou `no_usage_limit`. */
  const activeLimit = (projectId: number, engine: string): TerminalStateRow => {
    const r = store.get(projectId, engine)
    if (r.limitHitAt == null) throw new UserError('no_usage_limit', 'o terminal não está no limite de uso')
    return r
  }

  /** Armar e adiar precisam de uma reabertura conhecida e ainda no futuro. */
  const setFutureAction = (projectId: number, engine: string, action: 'armed' | 'snoozed'): void => {
    const r = activeLimit(projectId, engine)
    if (r.limitResetsAt == null || r.limitResetsAt * 1000 <= now()) {
      throw new UserError('reset_unknown', 'a hora em que o limite reabre não é conhecida')
    }
    store.setLimitAction(projectId, engine, action)
    rearm()
    restart.publish(projectId, engine)
  }

  /** O limite saiu sem retomar (turno sem erro, mensagem do operador). */
  const dropLimit = (projectId: number, engine: string): void => {
    limitedLocal.delete(keyOf(projectId, engine))
    if (store.get(projectId, engine).limitHitAt == null) return
    store.clearLimit(projectId, engine)
    rearm()
    restart.publish(projectId, engine)
  }

  return {
    /**
     * O manager viu o turno bater no limite. A marca do reinício é absorvida
     * (nunca duas retomadas na mesma janela), o limite é gravado em `none` e,
     * com o interruptor ligado, turno do operador ou do Claudinei, nenhuma
     * tentativa automática nesta janela e reabertura no futuro, arma sozinho.
     */
    onUsageLimit(projectId: number, engine: string, p: { localId: string; resetsAt: number | null; origin: LimitOrigin }): void {
      restart.absorbInterruption(projectId, engine)
      const row = store.recordUsageLimit(projectId, engine, { resetsAt: p.resetsAt, origin: p.origin })
      limitedLocal.set(keyOf(projectId, engine), p.localId)
      const autoOrigin = p.origin === 'operator' || p.origin === 'claudinei'
      if (row.autoResumeLimit && autoOrigin && row.limitTries === 0 && p.resetsAt != null && p.resetsAt * 1000 > now()) {
        store.setLimitAction(projectId, engine, 'armed')
      }
      // Sempre: um limite novo sobre um armado volta a none e sai do relógio.
      rearm()
      restart.publish(projectId, engine)
    },

    arm(projectId: number, engine: string): void {
      setFutureAction(projectId, engine, 'armed')
    },

    snooze(projectId: number, engine: string): void {
      setFutureAction(projectId, engine, 'snoozed')
    },

    /** De armado ou adiado, o aviso volta (`none`); de `none`, o aviso é dispensado (limit_tries fica). */
    cancel(projectId: number, engine: string): void {
      const r = activeLimit(projectId, engine)
      if (r.limitAction === 'none') store.clearLimit(projectId, engine)
      else store.setLimitAction(projectId, engine, 'none')
      rearm()
      restart.publish(projectId, engine)
    },

    /** "Continuar agora": `false` se outro caminho já retomou ou o serviço está encerrando. */
    continueNow(projectId: number, engine: string): boolean {
      return resumeAfterLimit(projectId, engine, { auto: false })
    },

    /** O operador falou: limpa o limite e zera as tentativas (a janela é dele agora). */
    onOperatorMessage(projectId: number, engine: string): void {
      store.resetLimitTries(projectId, engine)
      dropLimit(projectId, engine)
    },

    /** Turno sem erro: a janela está aberta. Limpa o limite e zera as tentativas. */
    onTurnResult(projectId: number, engine: string, info: { isError: boolean }): void {
      if (info.isError) return
      store.resetLimitTries(projectId, engine)
      dropLimit(projectId, engine)
    },

    /** Na subida: o que venceu enquanto o serviço estava fora sai agora, em lotes; o resto vai ao relógio. */
    async boot(): Promise<void> {
      await processDue()
    },

    dispose(): void {
      disposed = true
      timer?.clear()
      timer = null
    },
  }
}

export type UsageLimitService = ReturnType<typeof createUsageLimitService>
