import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import type { LimitOrigin, TerminalStateDto, TerminalStateStore } from '../restart/terminal-state.js'
import type { RestartService } from '../restart/boot.js'
import type { NextSend, NextSendProvider } from '../queue/next-send.js'
import { createProjectsService } from '../projects.js'
import { createTasksService, type Task } from '../tasks.js'
import { taskResultText } from './texts.js'

/**
 * O aviso de resultado de tarefa delegada (lugar 4 do árbitro do próximo
 * envio): quando uma tarefa encaminhada termina, o terminal que a encaminhou
 * (`fromProjectId` + `fromEngine`) recebe uma mensagem do Claudinei com o
 * resultado, sem precisar ficar consultando o list_tasks.
 *
 * Quem é acordado: tarefa sem projeto de origem (do operador, ou de um projeto
 * apagado) não acorda ninguém; sem motor de origem, vale a sessão viva mais
 * recente do projeto, e sem nenhuma viva ninguém é acordado. O motor de origem
 * vale mesmo fora da lista de motores do terminal (escondido).
 *
 * Quando: a decisão de mandar é sempre do árbitro (`poke` ou o fim de turno),
 * que respeita a ordem (a fila do operador antes) e os avisos abertos (limite
 * de uso, trabalho interrompido). Sessão trabalhando recebe no fim do turno.
 * Terminal parado só é revivido com "Retomar trabalho interrompido" ligado e
 * sem aviso aberto; senão o aviso fica à vista (`taskResults` no estado do
 * terminal) com Continuar e ×.
 *
 * Limite de uso: além do que o árbitro segura, este lugar segura por conta
 * própria o terminal que passou pelo limite até ele voltar a trabalhar por
 * iniciativa do operador ou da retomada armada (um turno bom do operador ou do
 * Claudinei). Sem isto, a reabertura de um limite adiado, ou o × no aviso dele,
 * cutucaria o árbitro e o Claudinei gastaria tokens sozinho só para entregar um
 * resultado. A marca fica só na memória; a subida a refaz pelo estado gravado.
 *
 * Esc (turno interrompido pelo operador) no terminal que delegou segura do
 * mesmo jeito, com a mesma marca (R19): a fila e o goal já pausam no Esc, e o
 * aviso não pode "acordar atropelando" na folga seguinte. O Continuar do aviso
 * ou um turno bom do operador ou do Claudinei a tira.
 *
 * O estado do aviso fica na própria tarefa (`notify`), para sobreviver ao
 * reinício: na subida, os pendentes voltam às mesmas regras.
 */

/** Status em que a sessão está de pé (o mesmo ACTIVE do manager). */
const ACTIVE = new Set(['starting', 'idle', 'working', 'needs_attention'])

type Terminal = { projectId: number; engine: string }
const keyOf = (t: Terminal) => `${t.projectId}:${t.engine}`

export function createTaskWake(deps: {
  db: Db; manager: SessionManager; store: TerminalStateStore
  restart: Pick<RestartService, 'bringUp' | 'publish'>
  nextSend: () => NextSend | undefined
  /**
   * Aviso aberto no terminal (o mesmo `holds` do árbitro, montado no app.ts).
   * Só decide se um terminal PARADO pode ser revivido; a entrega em si é do
   * árbitro.
   */
  holds: (projectId: number, engine: string) => boolean
  /**
   * O aviso saiu para o terminal (depois do envio). Liga ao goal: o goal que
   * esperava as tarefas delegadas volta a ativo. Uma falha aqui só vai ao log.
   */
  onDelivered?: (projectId: number, engine: string) => void
  log?: (msg: string) => void
}) {
  const { db, manager, store } = deps
  const log = deps.log ?? ((msg: string) => console.error(msg))
  const tasks = createTasksService(db)
  const projects = createProjectsService(db)
  const holds = deps.holds

  /**
   * Terminais (chave `projeto:motor`) segurados até voltarem a trabalhar: pelo
   * limite de uso ou pelo Esc do operador (R19).
   */
  const held = new Set<string>()
  /** Refaz a marca pelo estado gravado: todo terminal com limite registrado. */
  const markLimitedRows = (): void => {
    for (const r of store.list()) if (r.limitHitAt != null) held.add(keyOf(r))
  }
  // Na construção (o buildApp, antes do startAfterListen): a subida do limite
  // roda antes da deste serviço e limpa o adiado que venceu com o Claudinei
  // fora do ar, publicando (e cutucando o árbitro). Se a marca só nascesse no
  // `boot`, o limite já teria saído e o aviso iria sem ninguém trabalhar.
  markLimitedRows()
  /** Marca o terminal se ele está no limite agora; devolve se está segurado. */
  const isHeld = (t: Terminal): boolean => {
    if (store.get(t.projectId, t.engine).limitHitAt != null) held.add(keyOf(t))
    return held.has(keyOf(t))
  }

  const liveOf = (projectId: number, engine: string) =>
    manager.list().find((s) => s.projectId === projectId && s.engine === engine && ACTIVE.has(s.status))

  /** Sessões do projeto, da mais recente para a mais antiga (só vivas, se pedido). */
  const latestSessions = (projectId: number, onlyLive: boolean) =>
    manager.list()
      .filter((s) => s.projectId === projectId && (!onlyLive || ACTIVE.has(s.status)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  /**
   * O motor de uma tarefa sem motor de origem: o da sessão viva mais recente do
   * projeto. Com `fallback` (aviso que já está pendente e precisa de um lugar
   * para aparecer), sem nenhuma viva vale a sessão mais recente de todas.
   */
  const engineForUnknown = (projectId: number, fallback: boolean): string | null =>
    latestSessions(projectId, true)[0]?.engine ?? (fallback ? latestSessions(projectId, false)[0]?.engine ?? null : null)

  /** O terminal a acordar, ou null se não há quem. */
  const originOf = (t: Task, fallback: boolean): Terminal | null => {
    if (t.fromProjectId == null || !projects.get(t.fromProjectId)) return null
    const engine = t.fromEngine ?? engineForUnknown(t.fromProjectId, fallback)
    return engine ? { projectId: t.fromProjectId, engine } : null
  }

  /**
   * Avisos pendentes do terminal, da tarefa mais antiga para a mais nova. As
   * sem motor de origem entram no terminal do motor que as recebe (veja acima).
   */
  const pendingFor = (projectId: number, engine: string): Task[] => {
    const own = tasks.pendingNotifyFor(projectId, engine)
    const loose = tasks.pendingNotifyFor(projectId, null)
    if (loose.length === 0 || engineForUnknown(projectId, true) !== engine) return own
    return [...own, ...loose].sort((a, b) => a.id - b.id)
  }

  /** Publica o estado sem deixar uma falha da tela desfazer o que já foi feito. */
  const publish = (projectId: number, engine: string): void => {
    try { deps.restart.publish(projectId, engine) } catch (err) {
      log(`[aviso de tarefa] publicar ${projectId}/${engine} falhou: ${(err as Error)?.message ?? err}`)
    }
  }

  /**
   * Tenta entregar o que está pendente para o terminal, segundo o estado da
   * sessão de origem: viva → o árbitro decide (livre recebe agora; trabalhando,
   * no fim do turno; com aviso aberto, segura); parada → revive só com
   * "retomar" ligado e sem aviso aberto, e o árbitro entrega na sessão que sobe
   * (em `starting`, que conta como livre). O que não sai fica à vista.
   */
  const route = (t: Terminal): void => {
    // Encerrando: o pendente fica no banco e volta na próxima subida.
    if (manager.isShuttingDown()) return
    if (isHeld(t)) {
      // Nem cutuca nem revive: o resultado espera o terminal voltar a trabalhar.
    } else if (liveOf(t.projectId, t.engine)) {
      deps.nextSend()?.poke(t.projectId, t.engine)
    } else if (store.get(t.projectId, t.engine).autoResume && !holds(t.projectId, t.engine)) {
      try {
        deps.restart.bringUp(t.projectId, t.engine, null)
        deps.nextSend()?.poke(t.projectId, t.engine)
      } catch (err) {
        // Não subiu: o aviso fica à vista, e o Continuar tenta de novo.
        log(`[aviso de tarefa] terminal ${t.projectId}/${t.engine} não subiu: ${(err as Error)?.message ?? err}`)
      }
    }
    if (pendingFor(t.projectId, t.engine).length > 0) publish(t.projectId, t.engine)
  }

  const provider: NextSendProvider = {
    name: 'task-results',
    slot: 4,
    /** Todas as pendentes do terminal numa mensagem só, uma por bloco. */
    offer(ctx) {
      if (isHeld(ctx)) return false
      const pending = pendingFor(ctx.projectId, ctx.engine)
      if (pending.length === 0) return false
      manager.sendAsClaudinei(ctx.localId, taskResultText(pending.map((t) => ({
        id: t.id, toProjectName: t.toProjectName, status: t.status as 'completed' | 'failed', result: t.result,
      }))))
      // Já mandou: daqui em diante nada pode lançar, senão o árbitro ofereceria
      // a sessão ao lugar seguinte e sairiam duas mensagens na mesma folga.
      try {
        tasks.setNotify(pending.map((t) => t.id), 'delivered')
      } catch (err) {
        log(`[aviso de tarefa] marcar entregue falhou em ${ctx.projectId}/${ctx.engine}: ${(err as Error)?.message ?? err}`)
      }
      publish(ctx.projectId, ctx.engine)
      try {
        deps.onDelivered?.(ctx.projectId, ctx.engine)
      } catch (err) {
        log(`[aviso de tarefa] onDelivered falhou em ${ctx.projectId}/${ctx.engine}: ${(err as Error)?.message ?? err}`)
      }
      return true
    },
  }

  return {
    provider,

    /** A tarefa terminou (concluída ou falha): marca o aviso e tenta entregar. */
    onTaskEnded(taskId: number): void {
      const t = tasks.get(taskId)
      if (!t || (t.status !== 'completed' && t.status !== 'failed')) return
      // Já entregue, dispensado ou sem ninguém: um segundo fim não avisa de novo.
      if (t.notify != null && t.notify !== 'pending') return
      const target = originOf(t, false)
      if (!target) { tasks.setNotify([t.id], 'none'); return }
      tasks.setNotify([t.id], 'pending')
      route(target)
    },

    /**
     * O Continuar do aviso "A tarefa terminou": sobe o terminal se ele estiver
     * parado e deixa o árbitro entregar. `false` se não há nada pendente (ou o
     * serviço está encerrando). Erro do revive sobe para quem chamou.
     */
    continueNow(projectId: number, engine: string): boolean {
      if (manager.isShuttingDown()) return false
      if (pendingFor(projectId, engine).length === 0) return false
      // O Continuar é o operador pedindo a entrega: tira a marca (limite ou Esc), desde
      // que o limite já tenha saído (com ele ativo, o árbitro segura de todo jeito).
      if (store.get(projectId, engine).limitHitAt == null) held.delete(keyOf({ projectId, engine }))
      if (!liveOf(projectId, engine)) deps.restart.bringUp(projectId, engine, null)
      deps.nextSend()?.poke(projectId, engine)
      return true
    },

    /**
     * Fim de turno (o mesmo gancho do manager). O turno que bate no limite marca
     * o terminal, e o interrompido pelo operador também (R19); um turno bom do
     * operador ou do Claudinei (a retomada armada do limite é do Claudinei) tira
     * a marca: o terminal voltou a trabalhar. Turno com erro, de tarefa, de
     * agendamento ou de compactação (que herda a origem do turno anterior) não
     * prova isso. O Esc segura mesmo num turno de compactação, e publica o
     * estado quando há resultado pendente.
     */
    onTurnResult(projectId: number, engine: string, info: { isError: boolean; interrupted: boolean; limited: boolean; origin: LimitOrigin; compaction?: boolean }): void {
      const key = keyOf({ projectId, engine })
      if (info.limited) { held.add(key); return }
      // O Esc vem antes da compactação: o operador que interrompe uma
      // compactação também segura o aviso (R19).
      if (info.interrupted) {
        held.add(key)
        // A tela precisa ver o aviso segurado (o Continuar) sem recarregar; só
        // publica se há resultado pendente, para não fazer barulho à toa.
        if (pendingFor(projectId, engine).length > 0) publish(projectId, engine)
        return
      }
      if (info.compaction) return
      if (info.isError) return
      if (info.origin === 'operator' || info.origin === 'claudinei') held.delete(key)
    },

    /**
     * O × do aviso: os pendentes do terminal viram dispensados. O resultado segue
     * em list_tasks. Devolve quantos foram dispensados.
     */
    dismiss(projectId: number, engine: string): number {
      const ids = pendingFor(projectId, engine).map((t) => t.id)
      tasks.setNotify(ids, 'dismissed')
      publish(projectId, engine)
      return ids.length
    },

    /** O terminal tem resultado de tarefa esperando para sair (segurado ou não). */
    hasPending(projectId: number, engine: string): boolean {
      return pendingFor(projectId, engine).length > 0
    },

    /**
     * O pedaço do estado do terminal que é deste serviço: os avisos pendentes e
     * se a marca do limite os segura. Só lê: com o limite ativo conta como
     * segurado mesmo antes de a marca nascer (ela nasce na próxima oferta).
     */
    decorate(projectId: number, engine: string): Pick<TerminalStateDto, 'taskResults' | 'taskResultsHeld'> {
      return {
        taskResults: pendingFor(projectId, engine).map((t) => ({
          id: t.id, toProjectName: t.toProjectName, status: t.status as 'completed' | 'failed',
        })),
        taskResultsHeld: held.has(keyOf({ projectId, engine })) || store.get(projectId, engine).limitHitAt != null,
      }
    },

    /**
     * Terminais com aviso pendente: a lista do estado dos terminais os inclui
     * mesmo sem linha própria (retomar desligado é o padrão e não grava nada).
     */
    terminals(): Terminal[] {
      const seen = new Map<string, Terminal>()
      for (const t of tasks.allPendingNotify()) {
        const target = originOf(t, true)
        if (target) seen.set(keyOf(target), target)
      }
      return [...seen.values()]
    },

    /**
     * A subida: os avisos pendentes da vez anterior voltam às mesmas regras. Roda
     * depois das subidas do reinício e do limite, para que a retomada saia antes
     * (o terminal interrompido segura até ela). Pendente sem quem acordar (o
     * projeto de origem foi apagado) vira `none`.
     */
    async boot(): Promise<void> {
      // A marca do limite é só da memória: refeita pelo estado gravado (de novo
      // aqui, para um limite gravado entre a construção e a subida).
      markLimitedRows()
      const targets = new Map<string, Terminal>()
      for (const t of tasks.allPendingNotify()) {
        // Desvio deliberado da regra "só a sessão viva": um aviso sem motor de
        // origem que já estava pendente fica na sessão mais recente do projeto,
        // mesmo sem nenhuma viva, para seguir à vista (e no Continuar).
        const target = originOf(t, true)
        if (!target) { tasks.setNotify([t.id], 'none'); continue }
        targets.set(keyOf(target), target)
      }
      for (const target of targets.values()) {
        if (manager.isShuttingDown()) return
        try { route(target) } catch (err) {
          log(`[aviso de tarefa] subida de ${target.projectId}/${target.engine} falhou: ${(err as Error)?.message ?? err}`)
        }
      }
    },
  }
}

export type TaskWake = ReturnType<typeof createTaskWake>
