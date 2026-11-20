import { fetchHistory } from '../api'
import { useStore } from '../store'
import { lastConfirmedPos, liveOperatorMissing, pageSigs } from './reconcile'
import type { HistoryPage } from '../types'

/** Teto de páginas extras que a releitura do fim busca para trás até alcançar a tela. */
export const TAIL_CATCHUP_PAGES = 10
/** Tamanho dessas páginas extras: o teto da rota, para alcançar em menos pedidos. */
export const TAIL_CATCHUP_LIMIT = 500

/** Pedido mais recente de releitura por localId: só o resultado dele é aplicado. */
const latest: Record<string, number> = {}
let seq = 0

/**
 * Relê o fim da conversa `conv` e, se o turno foi maior que uma página, continua
 * lendo para trás até a página encostar no que já está na tela. Entrega o
 * resultado a `apply`, que reconcilia e marca o histórico como carregado.
 *
 * Sem isto, um turno longo (tarefa autônoma, centenas de eventos) trazia uma
 * cauda sem nenhuma chave em comum com a tela, e a reconciliação só podia
 * substituir tudo: sumiam as páginas antigas que o operador tinha carregado e o
 * começo do próprio turno, inclusive o pedido que o iniciou.
 *
 * Só busca para trás na MESMA conversa (sem cursor ainda, a tela é só o turno
 * ao vivo dela). Com itens confirmados na tela, até a página encostar no mais
 * recente deles. Sem nenhum (terminal novo, ou a carga inicial veio vazia), o
 * primeiro turno inteiro só existe ao vivo: lê enquanto houver texto do
 * operador ao vivo que as páginas ainda não têm — senão a abertura do turno,
 * sem par, iria parar no fim da lista, e de novo no topo ao subir. Passado o
 * teto, entrega o que juntou e a reconciliação substitui, sem deixar buraco.
 * As páginas juntadas viram uma cauda só.
 *
 * Releituras concorrentes (o efeito do ChatView dispara de novo antes de a
 * anterior terminar): só a mais recente chama `apply`. Uma resposta velha que
 * chegasse depois reconciliaria a tela com uma cauda mais curta — e os itens
 * confirmados depois do fim dela sumiriam — e ainda marcaria como carregado,
 * travando a próxima releitura. A checagem e o `apply` rodam juntos, sem
 * `await` no meio. Devolve se aplicou.
 */
export async function loadHistoryTail(localId: string, conv: string, apply: (page: HistoryPage) => void): Promise<boolean> {
  const mine = ++seq
  latest[localId] = mine
  const stale = () => latest[localId] !== mine
  let page = await fetchHistory(localId)
  if (stale()) return false
  const cursor = useStore.getState().historyCursor[localId]
  if (cursor ? cursor.conv === conv : true) {
    let sigs: Set<string> | undefined
    for (let extra = 0; extra < TAIL_CATCHUP_PAGES; extra++) {
      if (page.atStart || page.events.length === 0) break
      const screen = useStore.getState().chat[localId] ?? []
      // A tela cobre um trecho contínuo até a última posição confirmada: se ela
      // alcança o começo da página, a 1ª chave da página está na tela.
      const last = lastConfirmedPos(screen)
      if (last >= 0) {
        if (last >= page.before) break
      } else {
        sigs ??= pageSigs(page.events)
        if (!liveOperatorMissing(screen, sigs)) break
      }
      const older = await fetchHistory(localId, page.before, TAIL_CATCHUP_LIMIT)
      if (stale()) return false
      if (older.events.length === 0 && !older.atStart) break
      if (sigs) pageSigs(older.events, sigs)
      page = { events: [...older.events, ...page.events], before: older.before, atStart: older.atStart }
    }
  }
  apply(page)
  return true
}
