import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import type { GoalStatus, LimitOrigin, TerminalStateStore } from '../restart/terminal-state.js'
import type { RestartService } from '../restart/boot.js'
import type { NextSend, NextSendProvider } from '../queue/next-send.js'
import type { SlotContext } from '../queue/operator-queue.js'
import { createTasksService } from '../tasks.js'
import { UserError } from '../user-error.js'
import { GOAL_CRITERION_MAX, GOAL_EVIDENCE_MAX, GOAL_MAX_TURNS, goalContinueText, goalStartText } from './texts.js'

/**
 * O goal do terminal (`/goal <critério>`): o terminal segue turno após turno,
 * com um "continue" do Claudinei no fim de cada um (lugar 6 do árbitro do
 * próximo envio, sempre o último), até o agente chamar `goal_done` com a
 * evidência.
 *
 * Comandos (interceptados no `manager.send`, para todos os motores):
 * - `/goal <critério>`: inicia ou substitui; grava o goal e manda a partida
 *   (que conta como mensagem do operador, mas não pausa o próprio goal);
 * - `/goal resume`: reativa, com os turnos zerados;
 * - `/goal stop`: encerra (o terminal fica sem goal).
 *
 * Teto: 20 turnos sem `goal_done` param com `cap`. Contam só o turno da
 * partida e os turnos do Claudinei (continue, aviso de resultado de tarefa,
 * retomada do reinício ou do limite); tarefa de outro agente, agendamento e
 * compactação rodam no meio sem gastar turnos.
 *
 * Pausas (sem mensagem): mensagem do operador que não seja `/goal`, turno com
 * erro, limite de uso e Esc. A retomada armada do limite (turno bom do
 * Claudinei com o goal pausado pelo limite) reativa e conta.
 *
 * Tarefas delegadas: com tarefas do próprio terminal na fila ou em andamento,
 * o lugar 6 não gira em falso; grava `waiting` e passa a vez. O aviso do
 * resultado (lugar 4) o devolve a `active`, e o turno dele conta.
 *
 * O estado fica nas colunas `goal_*` do estado do terminal (sobrevive ao
 * reinício). Só a marca do turno da partida é da memória.
 */

type Terminal = { projectId: number; engine: string }
const keyOf = (t: Terminal) => `${t.projectId}:${t.engine}`

/** Goal que ainda não acabou: o `goal_done` vale para ele. */
const OPEN = new Set<GoalStatus>(['active', 'waiting', 'paused', 'cap'])
/** Goal que gira: conta turnos e pausa. */
const RUNNING = new Set<GoalStatus>(['active', 'waiting'])

export function createGoalService(deps: {
  db: Db; manager: SessionManager; store: TerminalStateStore
  restart: Pick<RestartService, 'publish'>
  nextSend: () => NextSend | undefined
  log?: (msg: string) => void
}) {
  const { manager, store } = deps
  const log = deps.log ?? ((msg: string) => console.error(msg))
  const tasks = createTasksService(deps.db)

  /** Terminais mandando a partida agora: o onOperatorMessage dela não pausa o goal. */
  const sendingStart = new Set<string>()
  /** Terminais cujo próximo fim de turno é o da partida (origem `operator`, mas conta). */
  const startTurn = new Set<string>()

  /** Publica o estado sem deixar uma falha da tela desfazer o que já foi feito. */
  const publish = (projectId: number, engine: string): void => {
    try { deps.restart.publish(projectId, engine) } catch (err) {
      log(`[goal] publicar ${projectId}/${engine} falhou: ${(err as Error)?.message ?? err}`)
    }
  }

  /**
   * Comando tratado que não mandou nada à sessão: o árbitro precisa olhar de
   * novo. Sem isto, um `/goal stop` entregue pela fila do operador (que conta o
   * item como entregue) deixaria a sessão livre parada com o resto da fila.
   */
  const pokeLater = (projectId: number, engine: string): void => {
    queueMicrotask(() => {
      // Erro aqui seria uma exceção sem dono (derruba o processo): só no log.
      try { deps.nextSend()?.poke(projectId, engine) } catch (err) {
        log(`[goal] cutucar ${projectId}/${engine} falhou: ${(err as Error)?.message ?? err}`)
      }
    })
  }

  const start = (ctx: SlotContext, criterion: string): void => {
    if (criterion.length === 0 || criterion.length > GOAL_CRITERION_MAX) {
      throw new UserError('goal_invalid', `o objetivo precisa de um critério de 1 a ${GOAL_CRITERION_MAX} caracteres`, { max: GOAL_CRITERION_MAX })
    }
    const key = keyOf(ctx)
    // Gravado antes da partida: o fim do turno dela já encontra o goal ativo.
    store.startGoal(ctx.projectId, ctx.engine, criterion)
    startTurn.add(key)
    sendingStart.add(key)
    try {
      // Com eco: a partida aparece no chat (o cartão "Objetivo definido"), como no histórico.
      manager.send(ctx.localId, goalStartText(criterion), { echo: true })
    } catch (err) {
      // A partida não saiu: o goal não começou. O erro sobe a quem mandou o /goal.
      startTurn.delete(key)
      store.clearGoal(ctx.projectId, ctx.engine)
      publish(ctx.projectId, ctx.engine)
      throw err
    } finally {
      sendingStart.delete(key)
    }
    publish(ctx.projectId, ctx.engine)
  }

  const provider: NextSendProvider = {
    name: 'goal',
    slot: 6,
    /** O "continue" com o próximo turno; só com o goal ativo e sem tarefas delegadas abertas. */
    offer(ctx) {
      const row = store.get(ctx.projectId, ctx.engine)
      if (row.goalStatus !== 'active' || row.goalCriterion == null) return false
      if (row.goalTurns >= GOAL_MAX_TURNS) {
        store.setGoalStatus(ctx.projectId, ctx.engine, 'cap')
        publish(ctx.projectId, ctx.engine)
        return false
      }
      if (tasks.openFrom(ctx.projectId, ctx.engine) > 0) {
        store.setGoalStatus(ctx.projectId, ctx.engine, 'waiting')
        publish(ctx.projectId, ctx.engine)
        return false
      }
      manager.sendAsClaudinei(ctx.localId, goalContinueText(row.goalCriterion, row.goalTurns + 1))
      return true
    },
  }

  return {
    provider,

    /**
     * O `/goal` digitado (ou vindo da fila): true = tratado aqui. Critério vazio
     * ou longo demais lança `UserError('goal_invalid')`, sem mandar nada.
     */
    command(ctx: SlotContext, text: string): boolean {
      const arg = text.trim().slice('/goal'.length).trim()
      const word = arg.toLowerCase()
      if (word === 'stop') {
        startTurn.delete(keyOf(ctx))
        store.clearGoal(ctx.projectId, ctx.engine)
        publish(ctx.projectId, ctx.engine)
        pokeLater(ctx.projectId, ctx.engine)
        return true
      }
      if (word === 'resume') {
        const row = store.get(ctx.projectId, ctx.engine)
        // Sem goal, ou já cumprido: nada a retomar.
        if (row.goalStatus != null && row.goalStatus !== 'done') {
          store.resumeGoal(ctx.projectId, ctx.engine)
          publish(ctx.projectId, ctx.engine)
        }
        // O continue sai pelo árbitro: livre agora, ou no fim do turno em curso.
        pokeLater(ctx.projectId, ctx.engine)
        return true
      }
      start(ctx, arg)
      return true
    },

    /** Fim de turno (o mesmo gancho do manager): pausa, reativa ou conta. */
    onTurnResult(projectId: number, engine: string, info: { isError: boolean; interrupted: boolean; limited: boolean; origin: LimitOrigin; compaction?: boolean }): void {
      const key = keyOf({ projectId, engine })
      // A compactação não é turno do goal: nem conta nem consome a marca da partida.
      const isStart = !info.compaction && startTurn.delete(key)
      const row = store.get(projectId, engine)
      if (row.goalCriterion == null || row.goalStatus == null) return
      const status = row.goalStatus
      if (RUNNING.has(status)) {
        const pause = info.interrupted ? 'interrupt' : info.limited ? 'limit' : info.isError ? 'error' : null
        if (pause) {
          store.setGoalStatus(projectId, engine, 'paused', pause)
          publish(projectId, engine)
          return
        }
        if (info.compaction || !(isStart || info.origin === 'claudinei')) return
      } else if (status === 'paused' && row.goalPause === 'limit') {
        // A retomada armada do limite: turno bom do Claudinei reativa e conta.
        if (info.compaction || info.origin !== 'claudinei' || info.isError || info.interrupted || info.limited) return
        store.setGoalStatus(projectId, engine, 'active')
      } else {
        return
      }
      const turns = store.bumpGoalTurn(projectId, engine)
      if (turns >= GOAL_MAX_TURNS) store.setGoalStatus(projectId, engine, 'cap')
      publish(projectId, engine)
    },

    /** Mensagem do operador que não é `/goal`: o goal que não acabou pausa. */
    onOperatorMessage(projectId: number, engine: string): void {
      const key = keyOf({ projectId, engine })
      if (sendingStart.has(key)) return
      // O operador falou no meio da partida: aquele turno já não é do goal.
      startTurn.delete(key)
      const row = store.get(projectId, engine)
      // Pausado por outro motivo também vira "operador": ele assumiu, e só o
      // `/goal resume` volta (a retomada armada do limite deixa de valer).
      if (row.goalStatus == null || (!RUNNING.has(row.goalStatus) && row.goalStatus !== 'paused')) return
      if (row.goalStatus === 'paused' && row.goalPause === 'operator') return
      store.setGoalStatus(projectId, engine, 'paused', 'operator')
      publish(projectId, engine)
    },

    /**
     * O `goal_done` do agente: cumprido, com a evidência. Vale para o goal que
     * não acabou (ativo, esperando, pausado ou no teto); sem goal, ou já
     * cumprido, volta `no_active_goal`.
     */
    done(projectId: number, engine: string, evidence: string): { ok: true } | { ok: false; error: string } {
      const row = store.get(projectId, engine)
      if (row.goalCriterion == null || row.goalStatus == null || !OPEN.has(row.goalStatus)) {
        return { ok: false, error: 'no_active_goal' }
      }
      store.finishGoal(projectId, engine, evidence.slice(0, GOAL_EVIDENCE_MAX))
      startTurn.delete(keyOf({ projectId, engine }))
      publish(projectId, engine)
      return { ok: true }
    },

    /** O aviso de resultado de tarefa saiu para o terminal: o goal esperando volta a ativo. */
    onTaskResultDelivered(projectId: number, engine: string): void {
      if (store.get(projectId, engine).goalStatus !== 'waiting') return
      store.setGoalStatus(projectId, engine, 'active')
      publish(projectId, engine)
    },
  }
}

export type GoalService = ReturnType<typeof createGoalService>
