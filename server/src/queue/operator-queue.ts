import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { UserError } from '../user-error.js'

/**
 * Fila do operador: mensagens que esperam o próximo turno de um terminal
 * (projeto + motor). Fica no banco para sobreviver a recarregar a página e a
 * sessões novas do mesmo terminal; some com o terminal (ON DELETE CASCADE).
 *
 * Entrega um item por turno, quando a sessão fica livre (lugar 3 da ordem do
 * "próximo envio"). Pausa em erro do turno, interrupção pelo operador, morte
 * real da sessão e no botão de pausar; só o Retomar tira a pausa. O limite de
 * uso não pausa: o aviso do limite segura a fila enquanto está aberto, e depois
 * da retomada do Claudinei ela continua sozinha.
 */

export type PauseReason = 'error' | 'interrupted' | 'dead' | 'manual'
export interface QueueItem { id: number; text: string; createdAt: string }
export interface QueueDto { projectId: number; engine: string; items: QueueItem[]; paused: boolean; pauseReason: PauseReason | null }

export const QUEUE_MAX = 20
/** O mesmo teto de mensagem do Kimi e do OpenCode (MAX_PROMPT_BYTES). */
export const QUEUE_ITEM_MAX_BYTES = 120_000

interface ItemRow { id: number; text: string; created_at: string }
const toItem = (r: ItemRow): QueueItem => ({ id: r.id, text: r.text, createdAt: r.created_at })

/** Texto vazio ou grande demais é recusado antes de entrar na fila. */
function checkText(text: string): void {
  if (typeof text !== 'string' || text.trim() === '') throw new UserError('queue_item_empty', 'mensagem vazia não entra na fila')
  if (Buffer.byteLength(text, 'utf8') > QUEUE_ITEM_MAX_BYTES) {
    throw new UserError('queue_item_too_large', `mensagem grande demais para a fila (máximo ${QUEUE_ITEM_MAX_BYTES} bytes)`, { max: QUEUE_ITEM_MAX_BYTES })
  }
}

const notFound = (id: number) => new UserError('queue_item_not_found', `item ${id} não está na fila`)

export function createOperatorQueueStore(db: Db) {
  const listStmt = db.prepare(
    'SELECT id, text, created_at FROM operator_queue WHERE project_id=? AND engine=? ORDER BY position, id',
  )
  const getStmt = db.prepare('SELECT id, text, created_at FROM operator_queue WHERE id=?')
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM operator_queue WHERE project_id=? AND engine=?')
  const maxPosStmt = db.prepare('SELECT MAX(position) AS p FROM operator_queue WHERE project_id=? AND engine=?')
  const minPosStmt = db.prepare('SELECT MIN(position) AS p FROM operator_queue WHERE project_id=? AND engine=?')
  const deleteStmt = db.prepare('DELETE FROM operator_queue WHERE id=?')
  const terminalStmt = db.prepare('SELECT project_id, engine FROM operator_queue WHERE id=?')

  const list = (projectId: number, engine: string): QueueItem[] =>
    (listStmt.all(projectId, engine) as ItemRow[]).map(toItem)

  /** Posição antes da primeira: o item passa a ser o próximo da fila. */
  const frontPosition = (projectId: number, engine: string): number => {
    const p = (minPosStmt.get(projectId, engine) as { p: number | null }).p
    return p == null ? 0 : p - 1
  }

  return {
    list,

    add(projectId: number, engine: string, text: string): QueueItem {
      checkText(text)
      return db.transaction(() => {
        const n = (countStmt.get(projectId, engine) as { n: number }).n
        if (n >= QUEUE_MAX) throw new UserError('queue_full', `a fila já tem ${QUEUE_MAX} mensagens`, { max: QUEUE_MAX })
        const p = (maxPosStmt.get(projectId, engine) as { p: number | null }).p
        const { lastInsertRowid } = db.prepare(
          'INSERT INTO operator_queue (project_id, engine, position, text) VALUES (?, ?, ?, ?)',
        ).run(projectId, engine, p == null ? 0 : p + 1, text)
        return toItem(getStmt.get(Number(lastInsertRowid)) as ItemRow)
      })()
    },

    update(id: number, text: string): QueueItem {
      checkText(text)
      const { changes } = db.prepare(
        `UPDATE operator_queue SET text=?, updated_at=datetime('now') WHERE id=?`,
      ).run(text, id)
      if (!changes) throw notFound(id)
      return toItem(getStmt.get(id) as ItemRow)
    },

    /** `ids` é a fila inteira na ordem nova: nem item a mais, nem a menos, nem repetido. */
    reorder(projectId: number, engine: string, ids: number[]): void {
      db.transaction(() => {
        const mismatch = () => new UserError('queue_order_mismatch', 'a ordem enviada não corresponde à fila atual')
        // Corpo malformado vira o mesmo erro de tela, e não um TypeError.
        if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) throw mismatch()
        const current = list(projectId, engine).map((i) => i.id)
        const wanted = new Set(ids)
        const exact = ids.length === current.length && wanted.size === ids.length && current.every((id) => wanted.has(id))
        if (!exact) throw mismatch()
        const setPos = db.prepare('UPDATE operator_queue SET position=? WHERE id=?')
        ids.forEach((id, i) => setPos.run(i, id))
      })()
    },

    remove(id: number): void {
      deleteStmt.run(id)
    },

    takeFirst(projectId: number, engine: string): QueueItem | null {
      return db.transaction(() => {
        const first = listStmt.get(projectId, engine) as ItemRow | undefined
        if (!first) return null
        deleteStmt.run(first.id)
        return toItem(first)
      })()
    },

    /**
     * Devolve à frente um item tirado (o envio falhou). Volta com o mesmo id e
     * a mesma data, e não conta o teto de 20: o item já era da fila.
     */
    putFirst(projectId: number, engine: string, item: QueueItem): void {
      db.prepare(
        'INSERT INTO operator_queue (id, project_id, engine, position, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(item.id, projectId, engine, frontPosition(projectId, engine), item.text, item.createdAt)
    },

    moveToFront(id: number): void {
      db.transaction(() => {
        const t = terminalStmt.get(id) as { project_id: number; engine: string } | undefined
        if (!t) throw notFound(id)
        const first = listStmt.get(t.project_id, t.engine) as ItemRow
        if (first.id === id) return
        db.prepare('UPDATE operator_queue SET position=? WHERE id=?').run(frontPosition(t.project_id, t.engine), id)
      })()
    },

    terminalOf(id: number): { projectId: number; engine: string } | null {
      const t = terminalStmt.get(id) as { project_id: number; engine: string } | undefined
      return t ? { projectId: t.project_id, engine: t.engine } : null
    },

    state(projectId: number, engine: string): { paused: boolean; pauseReason: PauseReason | null } {
      const r = db.prepare('SELECT paused, pause_reason FROM operator_queue_state WHERE project_id=? AND engine=?')
        .get(projectId, engine) as { paused: number; pause_reason: string | null } | undefined
      if (!r || !r.paused) return { paused: false, pauseReason: null }
      return { paused: true, pauseReason: (r.pause_reason as PauseReason | null) ?? null }
    },

    /** `null` tira a pausa. */
    setPaused(projectId: number, engine: string, reason: PauseReason | null): void {
      db.prepare(
        `INSERT INTO operator_queue_state (project_id, engine, paused, pause_reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, engine) DO UPDATE SET paused=excluded.paused, pause_reason=excluded.pause_reason`,
      ).run(projectId, engine, reason ? 1 : 0, reason)
    },
  }
}

export type OperatorQueueStore = ReturnType<typeof createOperatorQueueStore>

/** O terminal e a sessão viva dele no momento do "livre". */
export interface SlotContext { projectId: number; engine: string; localId: string }

/**
 * Sessão que pode receber agora: os estados "livre" do onSessionAvailable e o
 * `starting` da sessão revivida que ainda não recebeu a 1ª mensagem (o mesmo
 * do hasFreeSession do manager). Quem pergunta já tem uma sessão viva.
 */
const FREE = new Set(['starting', 'idle', 'needs_attention'])

export function createOperatorQueueService(deps: {
  store: OperatorQueueStore
  manager: Pick<SessionManager, 'send' | 'interrupt' | 'get' | 'list'>
  broadcast: (msg: object) => void
  /** Aviso aberto no terminal (interrompido pelo reinício ou limite): a fila segura. */
  holds: (projectId: number, engine: string) => boolean
  /** O motor aceita mensagem no meio do turno (EngineCapabilities.midTurnInput). */
  acceptsMidTurn: (engine: string) => boolean
  /** Sessão viva do terminal, ou null. */
  liveLocalId: (projectId: number, engine: string) => string | null
  /** Avisos do serviço (envio que falhou); por padrão, o console. */
  warn?: (...args: unknown[]) => void
  /**
   * O serviço está encerrando: o turno que cai com erro, a interrupção e a
   * morte são da parada do reinício, que não pausa a fila.
   */
  isShuttingDown?: () => boolean
}) {
  const { store, manager } = deps
  const warn = deps.warn ?? ((...args: unknown[]) => console.warn(...args))
  const key = (projectId: number, engine: string) => `${projectId}:${engine}`
  /**
   * "Enviar agora" num motor sem mensagem no meio do turno: o turno é
   * interrompido de propósito. O result interrompido desse turno consome a
   * marca e não pausa a fila. Kimi e OpenCode não emitem result ao serem
   * interrompidos: por isso a marca também sai quando a sessão fica livre (o
   * turno interrompido acabou), para não engolir o Esc do turno seguinte.
   */
  const interruptToSend = new Set<string>()
  /**
   * O item do "enviar agora" que espera a sessão ficar livre. Passa mesmo com a
   * fila pausada (é ação explícita do operador), sem tirar a pausa.
   */
  const sendNowPending = new Map<string, number>()

  const dto = (projectId: number, engine: string): QueueDto =>
    ({ projectId, engine, items: store.list(projectId, engine), ...store.state(projectId, engine) })

  const emit = (projectId: number, engine: string): QueueDto => {
    const queue = dto(projectId, engine)
    deps.broadcast({ type: 'operator_queue', projectId, engine, queue })
    return queue
  }

  const isFree = (localId: string | null): localId is string =>
    !!localId && FREE.has(manager.get(localId)?.status ?? '')

  const terminalOrThrow = (id: number) => {
    const t = store.terminalOf(id)
    if (!t) throw notFound(id)
    return t
  }

  /**
   * Manda um item já tirado da fila. Se o envio falhar (a sessão morreu entre
   * o "livre" e o envio, ou o manager recusou), o item volta para a frente e a
   * fila pausa com 'error': nada se perde.
   */
  const deliver = (projectId: number, engine: string, localId: string, item: QueueItem): boolean => {
    try {
      manager.send(localId, item.text, { echo: true })
    } catch (err) {
      try {
        store.putFirst(projectId, engine, item)
        store.setPaused(projectId, engine, 'error')
      } catch (rollbackErr) {
        // Só acontece se o terminal sumiu no meio (a fila foi junto).
        console.error('[operator-queue] não devolveu o item à fila:', rollbackErr)
      }
      warn(`[operator-queue] envio do item ${item.id} falhou; fila pausada:`, err instanceof Error ? err.message : err)
      return false
    }
    // Fora do try do envio: o item já saiu, e uma falha daqui em diante não pode
    // devolvê-lo à fila (seria mandado de novo). Fila que esvaziou não fica
    // pausada: não sobrou nada a proteger.
    try {
      if (store.list(projectId, engine).length === 0) store.setPaused(projectId, engine, null)
    } catch (err) {
      warn(`[operator-queue] item ${item.id} enviado, mas a pausa da fila vazia não saiu:`, err instanceof Error ? err.message : err)
    }
    return true
  }

  /** Tira um item pelo id (não necessariamente o primeiro) e manda. */
  const deliverById = (projectId: number, engine: string, localId: string, id: number): boolean => {
    const item = store.list(projectId, engine).find((i) => i.id === id)
    if (!item) return false
    store.remove(id)
    // O item pendente do "enviar agora" que sai agora não pode sair de novo:
    // se o envio falhar, ele volta à frente com o mesmo id e a fila pausada.
    const k = key(projectId, engine)
    if (sendNowPending.get(k) === id) sendNowPending.delete(k)
    return deliver(projectId, engine, localId, item)
  }

  /**
   * Lugar 3 sem transmitir: devolve null se não tirou nada da fila, senão se o
   * envio deu certo. Quem chama transmite o DTO uma vez só.
   */
  const offerQuiet = (ctx: SlotContext): boolean | null => {
    const { projectId, engine, localId } = ctx
    // Confere de novo o estado da sessão: dois "livre" no mesmo tique entregam
    // um item só, porque o primeiro envio já a pôs em working.
    if (!isFree(localId)) return null
    const k = key(projectId, engine)
    // Sessão livre: o turno que o "enviar agora" interrompeu já acabou.
    interruptToSend.delete(k)
    // Aviso aberto segura tudo, inclusive o "enviar agora" que espera.
    if (deps.holds(projectId, engine)) return null
    const pending = sendNowPending.get(k)
    if (pending !== undefined) {
      sendNowPending.delete(k)
      // Ignora a pausa (ação explícita do operador), sem tirá-la.
      if (store.terminalOf(pending)) return deliverById(projectId, engine, localId, pending)
    }
    if (store.state(projectId, engine).paused) return null
    const item = store.takeFirst(projectId, engine)
    if (!item) return null
    return deliver(projectId, engine, localId, item)
  }

  const offer = (ctx: SlotContext): boolean => {
    const r = offerQuiet(ctx)
    if (r !== null) emit(ctx.projectId, ctx.engine)
    return r === true
  }

  /** Tenta entregar agora, se a sessão viva do terminal está livre (sem transmitir). */
  const offerIfFree = (projectId: number, engine: string): void => {
    const localId = deps.liveLocalId(projectId, engine)
    if (isFree(localId)) offerQuiet({ projectId, engine, localId })
  }

  /** Pausa só com itens na fila: fila vazia não tem o que proteger. */
  const pauseFor = (projectId: number, engine: string, reason: PauseReason): void => {
    if (store.list(projectId, engine).length === 0) return
    const s = store.state(projectId, engine)
    if (s.paused && s.pauseReason === reason) return
    store.setPaused(projectId, engine, reason)
    emit(projectId, engine)
  }

  return {
    dto,
    offer,

    add(projectId: number, engine: string, text: string): QueueDto {
      const wasEmpty = store.list(projectId, engine).length === 0
      store.add(projectId, engine, text)
      // Fila vazia, sem pausa, sem aviso e sessão livre: é como mandar na hora
      // (o offer confere a pausa e o aviso). O DTO devolvido já vem sem o item.
      if (wasEmpty) offerIfFree(projectId, engine)
      return emit(projectId, engine)
    },

    update(id: number, text: string): QueueDto {
      const t = terminalOrThrow(id)
      store.update(id, text)
      return emit(t.projectId, t.engine)
    },

    reorder(projectId: number, engine: string, ids: number[]): QueueDto {
      store.reorder(projectId, engine, ids)
      return emit(projectId, engine)
    },

    remove(id: number): QueueDto {
      const t = terminalOrThrow(id)
      store.remove(id)
      if (sendNowPending.get(key(t.projectId, t.engine)) === id) sendNowPending.delete(key(t.projectId, t.engine))
      if (store.list(t.projectId, t.engine).length === 0) store.setPaused(t.projectId, t.engine, null)
      return emit(t.projectId, t.engine)
    },

    /**
     * "Enviar agora": com a sessão livre, manda este item (mesmo que não seja o
     * primeiro); trabalhando num motor que aceita mensagem no meio do turno,
     * injeta no turno atual; senão passa o item para a frente e interrompe o
     * turno, e ele vai quando a sessão ficar livre. Vale com a fila pausada,
     * sem tirar a pausa: é o operador agindo. Com a sessão livre, manda mesmo
     * com aviso aberto (como uma mensagem digitada); o item que espera a
     * sessão ficar livre respeita o aviso, como o resto da fila.
     */
    sendNow(id: number): QueueDto {
      const { projectId, engine } = terminalOrThrow(id)
      const localId = deps.liveLocalId(projectId, engine)
      if (!localId) throw new UserError('session_not_active', 'o terminal não tem sessão ativa')
      const status = manager.get(localId)?.status
      if (isFree(localId) || (status === 'working' && deps.acceptsMidTurn(engine))) {
        deliverById(projectId, engine, localId, id)
        return emit(projectId, engine)
      }
      store.moveToFront(id)
      const k = key(projectId, engine)
      sendNowPending.set(k, id)
      if (status === 'working') {
        interruptToSend.add(k)
        manager.interrupt(localId).catch((err) => {
          // O turno segue; o item espera na frente e vai quando a sessão ficar livre.
          interruptToSend.delete(k)
          warn('[operator-queue] interromper para enviar falhou:', err instanceof Error ? err.message : err)
        })
      }
      return emit(projectId, engine)
    },

    pause(projectId: number, engine: string): QueueDto {
      store.setPaused(projectId, engine, 'manual')
      return emit(projectId, engine)
    },

    resume(projectId: number, engine: string): QueueDto {
      store.setPaused(projectId, engine, null)
      offerIfFree(projectId, engine)
      return emit(projectId, engine)
    },

    /** Fim de um turno do terminal (qualquer turno, não só os da fila). */
    onTurnResult(projectId: number, engine: string, info: { isError: boolean; interrupted: boolean; limited: boolean }): void {
      const k = key(projectId, engine)
      // A marca vale para o result logo depois do "enviar agora", seja qual for.
      const ownInterrupt = interruptToSend.delete(k)
      // Limite de uso não pausa (nem como erro): o aviso do limite segura a fila
      // enquanto está aberto, e depois da retomada do Claudinei ela continua.
      if (info.limited) return
      if (deps.isShuttingDown?.()) return
      if (info.interrupted) { if (!ownInterrupt) pauseFor(projectId, engine, 'interrupted') }
      else if (info.isError) pauseFor(projectId, engine, 'error')
    },

    /** A sessão morreu de verdade (o encerramento do serviço não chama isto). */
    onSessionDied(projectId: number, engine: string): void {
      const k = key(projectId, engine)
      interruptToSend.delete(k)
      sendNowPending.delete(k)
      if (deps.isShuttingDown?.()) return
      pauseFor(projectId, engine, 'dead')
    },
  }
}

export type OperatorQueueService = ReturnType<typeof createOperatorQueueService>
