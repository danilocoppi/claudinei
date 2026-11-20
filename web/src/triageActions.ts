import { setTriage } from './api'
import { useStore, type TriageUndo } from './store'
import type { TriageItem } from './types'

/**
 * As ações de triagem do operador (fixar, assentar, adiar), por qualquer porta: a
 * ⭐ do cartão e o menu das três bolinhas. Cada uma muda o store na hora, grava
 * no servidor, aplica a resposta dele (que vale mais) e fica desfazível por 5 s.
 * Se a rota falha, o estado de antes volta e a lateral mostra o aviso.
 */
export type TriagePatch = { pinned?: boolean; settled?: boolean; snoozedUntil?: string | null }
type Ws = { send(m: object): void } | null

/** Quanto tempo uma ação fica desfazível. */
export const UNDO_MS = 5_000

const blank = (projectId: number): TriageItem => ({ projectId, pinned: false, settled: false, snoozedUntil: null })

/**
 * O que o servidor faz com o pedido (`server/src/triage/store.ts`), na mesma
 * ordem: assentar tira o pin e o adiamento; adiar tira o assentado; fixar tira o
 * assentado. Serve só para a mudança imediata; a resposta da rota corrige.
 */
function combine(cur: TriageItem, p: TriagePatch): TriageItem {
  const next = { ...cur }
  if (p.settled !== undefined) {
    next.settled = p.settled
    if (p.settled) { next.pinned = false; next.snoozedUntil = null }
  }
  if (p.snoozedUntil !== undefined) {
    next.snoozedUntil = p.snoozedUntil
    if (p.snoozedUntil !== null) next.settled = false
  }
  if (p.pinned !== undefined) {
    next.pinned = p.pinned
    if (p.pinned) next.settled = false
  }
  return next
}

/** Pedido em andamento por projeto: outro pedido no mesmo terminal, enquanto este não volta, é ignorado. */
const inFlight = new Set<number>()
let expiry: ReturnType<typeof setTimeout> | undefined
let errorExpiry: ReturnType<typeof setTimeout> | undefined

type ErrorKey = 'sidebar.pinSaveError' | 'sidebar.triageSaveError'

/** Troca a entrada de desfazer. O prazo é UM setTimeout, que só limpa se ela ainda for a vigente. */
function setUndo(entry: TriageUndo | null): void {
  clearTimeout(expiry)
  useStore.setState({ undo: entry })
  if (entry) {
    expiry = setTimeout(() => {
      if (useStore.getState().undo === entry) useStore.setState({ undo: null })
    }, entry.expiresAt - Date.now())
  }
}

/**
 * Mostra (ou tira) o aviso de falha, no mesmo canto do desfazer. Some no × do
 * aviso, na próxima ação ou no mesmo prazo do desfazer: um erro antigo não fica
 * esperando a gaveta abrir para aparecer fora de contexto.
 */
function setError(key: ErrorKey | null): void {
  clearTimeout(errorExpiry)
  useStore.setState({ triageError: key })
  if (key) {
    errorExpiry = setTimeout(() => {
      if (useStore.getState().triageError === key) useStore.setState({ triageError: null })
    }, UNDO_MS)
  }
}

/** O × do aviso de falha. */
export function dismissTriageError(): void {
  setError(null)
}

const current = (projectId: number): TriageItem | undefined => useStore.getState().triage[projectId]
const sameTriage = (a: TriageItem, b: TriageItem) =>
  a.pinned === b.pinned && a.settled === b.settled && a.snoozedUntil === b.snoozedUntil

/**
 * Muda o store na hora, grava e aplica a resposta. Devolve o estado de antes e o
 * de depois, ou `null` se não gravou (falha da rota, que já avisou, ou outro
 * pedido do mesmo terminal ainda a caminho).
 *
 * O que o servidor mandou pelo WebSocket enquanto o pedido ia e voltava (um
 * despertar, ou o eco da própria ação) é mais novo que a mudança imediata: se o
 * item do store já não é o que pusemos aqui, nem a resposta nem a restauração
 * passam por cima dele.
 */
async function commit(projectId: number, patch: TriagePatch, errorKey: ErrorKey): Promise<{ before: TriageItem; after: TriageItem } | null> {
  if (inFlight.has(projectId)) return null
  inFlight.add(projectId)
  const { setTriageItem } = useStore.getState()
  const before = current(projectId) ?? blank(projectId)
  const optimistic = combine(before, patch)
  setError(null)
  setTriageItem(optimistic)
  try {
    const saved = await setTriage(projectId, patch)
    if (current(projectId) === optimistic) setTriageItem(saved)
    // `after` é o que a rota gravou, nunca o que está no store: um despertar que
    // chegou antes da resposta deixaria o desfazer achar que nada mudou e
    // esconder de novo quem acordou. O eco da própria ação tem o mesmo valor.
    return { before, after: saved }
  } catch {
    if (current(projectId) === optimistic) setTriageItem(before)
    setError(errorKey)
    return null
  } finally {
    inFlight.delete(projectId)
  }
}

/**
 * Assentar ou adiar marca o terminal como lido: zera o `unread` local de todas as
 * sessões do projeto e manda `mark_read` (o mesmo do ChatView) para cada sessão
 * viva — parada ou morta não tem o que marcar no servidor.
 */
function markProjectRead(projectId: number, ws: Ws): void {
  const { sessions, unread } = useStore.getState()
  const next = { ...unread }
  let changed = false
  for (const s of Object.values(sessions)) {
    if (s.projectId !== projectId) continue
    if (next[s.localId]) { next[s.localId] = 0; changed = true }
    if (s.status !== 'stopped' && s.status !== 'dead') ws?.send({ type: 'mark_read', localId: s.localId })
  }
  if (changed) useStore.setState({ unread: next })
}

/**
 * Uma ação de triagem do operador. A ação nova substitui a entrada de desfazer da
 * anterior; se a rota falha, não há o que desfazer. `label` é o texto do aviso.
 * A ação ignorada (o mesmo terminal com pedido a caminho) não mexe em nada.
 */
export async function applyTriage(projectId: number, patch: TriagePatch, label: string, ws: Ws): Promise<void> {
  if (inFlight.has(projectId)) return
  setUndo(null)
  const onlyPin = Object.keys(patch).every((k) => k === 'pinned')
  const done = await commit(projectId, patch, onlyPin ? 'sidebar.pinSaveError' : 'sidebar.triageSaveError')
  if (!done) return
  if (patch.settled === true || (patch.snoozedUntil ?? null) !== null) markProjectRead(projectId, ws)
  setUndo({ label, projectId, before: done.before, after: done.after, expiresAt: Date.now() + UNDO_MS })
}

/**
 * Devolve os três campos de antes da última ação (desfazer um assentar devolve o
 * pin que ele tirou) e limpa a entrada. Um adiamento de antes que já venceu volta
 * como "não adiado": a rota não aceita horário passado. O desfazer não se desfaz.
 *
 * Se o terminal mudou desde a ação (o servidor o acordou), o desfazer só some:
 * devolver o estado de antes esconderia de novo quem precisa do operador.
 */
export async function undoTriage(): Promise<void> {
  const u = useStore.getState().undo
  if (!u || Date.now() >= u.expiresAt) return
  setUndo(null)
  if (!sameTriage(current(u.projectId) ?? blank(u.projectId), u.after)) return
  const { before } = u
  const snoozedUntil = before.snoozedUntil !== null && Date.parse(before.snoozedUntil) > Date.now() ? before.snoozedUntil : null
  await commit(u.projectId, { pinned: before.pinned, settled: before.settled, snoozedUntil }, 'sidebar.triageSaveError')
}
