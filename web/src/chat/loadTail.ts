import { fetchHistory } from '../api'
import { useStore } from '../store'
import { lastConfirmedPos } from './reconcile'
import type { HistoryPage } from '../types'

/** Teto de páginas extras que a releitura do fim busca para trás até alcançar a tela. */
export const TAIL_CATCHUP_PAGES = 10
/** Tamanho dessas páginas extras: o teto da rota, para alcançar em menos pedidos. */
export const TAIL_CATCHUP_LIMIT = 500

/**
 * Relê o fim da conversa `conv` e, se o turno foi maior que uma página, continua
 * lendo para trás até a página encostar no que já está na tela.
 *
 * Sem isto, um turno longo (tarefa autônoma, centenas de eventos) trazia uma
 * cauda sem nenhuma chave em comum com a tela, e a reconciliação só podia
 * substituir tudo: sumiam as páginas antigas que o operador tinha carregado e o
 * começo do próprio turno, inclusive o pedido que o iniciou.
 *
 * Só busca para trás na MESMA conversa e com itens confirmados na tela mais
 * antigos que a página. Passado o teto, devolve o que juntou e a reconciliação
 * substitui, sem deixar buraco. As páginas juntadas viram uma cauda só.
 */
export async function loadHistoryTail(localId: string, conv: string): Promise<HistoryPage> {
  let page = await fetchHistory(localId)
  if (useStore.getState().historyCursor[localId]?.conv !== conv) return page
  for (let extra = 0; extra < TAIL_CATCHUP_PAGES; extra++) {
    if (page.atStart || page.events.length === 0) break
    // A tela cobre um trecho contínuo até a última posição confirmada: se ela
    // alcança o começo da página, a 1ª chave da página está na tela.
    const last = lastConfirmedPos(useStore.getState().chat[localId] ?? [])
    if (last < 0 || last >= page.before) break
    const older = await fetchHistory(localId, page.before, TAIL_CATCHUP_LIMIT)
    if (older.events.length === 0 && !older.atStart) break
    page = { events: [...older.events, ...page.events], before: older.before, atStart: older.atStart }
  }
  return page
}
