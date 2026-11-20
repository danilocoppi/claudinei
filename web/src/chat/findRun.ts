import { useStore } from '../store'
import i18n from '../i18n'
import { searchHistory } from '../api'
import type { SearchSlice } from '../types'
import { FIND_HIT_LIMIT, FIND_ROUND_BYTES, FIND_SLICE_BYTES, foldsToOpen, locateHit, locateLiveHit } from './find'
import { groupActions } from './grouping'
import { nodeIndexOfItem } from './nodes'
import { chatFollow, chatListRef, chatUserScroll } from './listHandle'
import { loadOlderPage } from './olderPages'

/**
 * Busca na conversa (Ctrl+F), a parte que conversa com o servidor e com a
 * lista: varrer em fatias, cancelar, e ir a uma ocorrência.
 *
 * Só uma busca existe por vez (a barra é da conversa aberta). Uma nova busca,
 * o Esc e a troca de terminal cancelam o pedido no ar (AbortController) e a
 * ida em curso a uma ocorrência (`idaSeq`); nada de uma busca velha cai no
 * estado de outra.
 */

let busca: AbortController | null = null
let idaSeq = 0
/** Idas já tentadas à ocorrência atual: o Enter repete uma vez a que não levou a nada. */
let tentativas = { index: -1, n: 0 }
/** Gestos de rolagem do operador (`chatUserScroll.n`) no momento do Enter. */
let rolagemNoEnter = 0

const get = () => useStore.getState()

// A busca some do store por outros caminhos (bloqueio da conta, conversa
// trocada na sessão): o pedido no ar e a ida em curso param junto.
useStore.subscribe((s, prev) => {
  if (prev.find && (!s.find || s.find.localId !== prev.find.localId)) cancelFind()
})

/** Cancela o pedido de fatia no ar e a ida em curso a uma ocorrência. */
export function cancelFind(): void {
  busca?.abort()
  busca = null
  idaSeq++
}

/** Esc, troca de terminal: cancela e fecha a barra. */
export function closeFind(): void {
  cancelFind()
  get().closeFind()
}

/** Enter com uma consulta nova (ou com "incluir ferramentas" trocado): começa do fim da conversa. */
export function startFind(localId: string, q: string, tools: boolean): void {
  cancelFind()
  tentativas = { index: -1, n: 0 }
  rolagemNoEnter = chatUserScroll.n
  get().setFind({
    localId, q, tools, hits: [], index: 0, scanning: true, before: null, atStart: false,
    scannedBytes: 0, capped: false, currentKey: null, error: null,
  })
  void rodada()
}

/** "buscar mais para trás": uma nova rodada de 64 MB a partir de onde a anterior parou. */
export function searchMore(): void {
  const f = get().find
  if (!f || f.scanning || f.atStart || f.capped) return
  get().patchFind(f.localId, f.q, { scanning: true, scannedBytes: 0, error: null })
  void rodada()
}

/**
 * A primeira ocorrência pode chegar segundos depois do Enter, numa conversa
 * enorme. Só é visitada sozinha se o operador ainda está esperando por ela —
 * o foco na barra e a conversa sem rolar desde o Enter. Se ele voltou a ler,
 * a barra só mostra "1 de n"; o próximo Enter leva até ela.
 */
function aindaEsperando(): boolean {
  const el = document.activeElement
  return chatUserScroll.n === rolagemNoEnter && el instanceof Element && !!el.closest('.find-bar')
}

/**
 * Uma rodada: fatias encadeadas pelo `before` até o começo da conversa, o teto
 * de ocorrências ou 64 MB varridos.
 */
async function rodada(): Promise<void> {
  const inicio = get().find
  if (!inicio) return
  const { localId, q, tools } = inicio
  busca?.abort()
  const ctrl = new AbortController()
  busca = ctrl
  const vale = () => !ctrl.signal.aborted && busca === ctrl && get().find?.localId === localId && get().find?.q === q
  for (;;) {
    const f = get().find!
    let fatia: SearchSlice
    try {
      fatia = await searchHistory(localId, q, tools, f.before ?? undefined, ctrl.signal)
    } catch (err) {
      if (!vale()) return
      get().patchFind(localId, q, { scanning: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!vale()) return
    const g = get().find!
    // Cada fatia anda para trás. Uma que não anda (servidor com defeito) faria
    // o laço pedir a mesma fatia para sempre: para, com aviso.
    if (!fatia.atStart && g.before !== null && fatia.before >= g.before) {
      get().patchFind(localId, q, { scanning: false, error: i18n.t('find.stalled') })
      return
    }
    const antes = g.hits.length
    let hits = antes ? g.hits.concat(fatia.hits) : fatia.hits
    const capped = hits.length > FIND_HIT_LIMIT
    if (capped) hits = hits.slice(0, FIND_HIT_LIMIT)
    // A primeira fatia vem do fim do arquivo, de tamanho desconhecido aqui: conta a fatia cheia.
    const scannedBytes = g.scannedBytes + (g.before === null ? FIND_SLICE_BYTES : Math.max(0, g.before - fatia.before))
    const fim = fatia.atStart || capped
    const pausa = !fim && scannedBytes >= FIND_ROUND_BYTES
    get().patchFind(localId, q, { hits, before: fatia.before, atStart: fatia.atStart, capped, scannedBytes, scanning: !fim && !pausa })
    if (antes === 0 && hits.length > 0 && aindaEsperando()) void gotoHit(0)
    if (fim || pausa) return
  }
}

const proximoQuadro = () => new Promise<void>((r) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r())
  else setTimeout(r, 16)
})

/**
 * A ocorrência ainda pode estar numa página não carregada? Sim se o evento dela
 * vem antes do cursor; e, na saída de ferramenta, se o resultado está à espera
 * da chamada (que é mais antiga que ele).
 */
function precisaDeMais(localId: string, pos: number, toolUseId: string | undefined): boolean {
  const st = get()
  const cursor = st.historyCursor[localId]
  if (!cursor || cursor.atStart) return false
  if (cursor.before > pos) return true
  return !!toolUseId && !!st.orphanResults[localId]?.[toolUseId]
}

/**
 * Leva a tela à ocorrência `index`:
 *  1. carrega as páginas anteriores (pelo mesmo carregador do topo da lista,
 *     sem o teto de páginas seguidas) até o item dela aparecer ou a conversa
 *     chegar ao começo;
 *  2. abre as dobras onde ela está;
 *  3. solta o "grudado no fim" e rola até o item, no meio da tela;
 *  4. marca o item (`currentKey`, a classe `chat-hit`).
 * Cancelável a qualquer momento (Esc, nova busca, outra ida, troca de terminal).
 */
export async function gotoHit(index: number): Promise<void> {
  const seq = ++idaSeq
  const f = get().find
  const hit = f?.hits[index]
  if (!f || !hit) return
  const { localId, q } = f
  tentativas = tentativas.index === index ? { index, n: tentativas.n + 1 } : { index, n: 1 }
  get().patchFind(localId, q, { index })
  const vale = () => seq === idaSeq && get().find?.localId === localId && get().find?.q === q && get().activeLocalId === localId

  let key = locateHit(get().chat[localId] ?? [], hit)
  let parado = 0
  while (key === null && precisaDeMais(localId, hit.pos, hit.toolUseId)) {
    const antes = get().historyCursor[localId]?.before
    const pedido = loadOlderPage(localId)
    if (!pedido) break
    const r = await pedido
    if (!vale()) return
    if (!r.ok) break
    // Página descartada (o cursor andou por outro caminho) não é avanço: duas
    // seguidas sem o cursor andar e a ida desiste, em vez de pedir para sempre.
    if (get().historyCursor[localId]?.before === antes && ++parado >= 2) break
    key = locateHit(get().chat[localId] ?? [], hit)
  }
  // Ocorrência do turno em andamento: o servidor já lê as linhas novas, mas
  // na tela elas ainda têm chave ao vivo (`l<n>`) até o refetch do fim do
  // turno. Procura entre os itens ao vivo pelo trecho.
  if (key === null && !precisaDeMais(localId, hit.pos, hit.toolUseId)) key = locateLiveHit(get().chat[localId] ?? [], hit)
  if (key === null) {
    get().patchFind(localId, q, { currentKey: null })
    return
  }

  const st = get()
  const working = st.sessions[localId]?.status === 'working'
  for (const id of foldsToOpen(groupActions(st.chat[localId] ?? [], working), st.chat[localId] ?? [], key, hit.field)) {
    st.setFold(localId, id, true)
  }
  chatFollow.release()
  // A lista recebe os itens, as dobras abertas e o fim do acompanhamento no
  // próximo render; só então o índice do nó é o que ela mostra.
  await proximoQuadro()
  if (!vale()) return
  const st2 = get()
  const nodes = groupActions(st2.chat[localId] ?? [], st2.sessions[localId]?.status === 'working')
  const at = nodeIndexOfItem(nodes, key)
  if (at >= 0) chatListRef.current?.scrollToIndex({ index: at, align: 'center' })
  get().patchFind(localId, q, { currentKey: key })
}

/**
 * Enter (+1, a mais antiga seguinte) e Shift+Enter (−1), dando a volta nas
 * pontas. A ocorrência atual que ainda não levou a nada (não visitada, ou o
 * item não estava na tela) é tentada antes — uma vez — de seguir adiante.
 */
export function stepFind(delta: number): void {
  const f = get().find
  if (!f || f.hits.length === 0) return
  if (f.currentKey === null && (tentativas.index !== f.index || tentativas.n < 2)) {
    void gotoHit(f.index)
    return
  }
  const n = f.hits.length
  void gotoHit(((f.index + delta) % n + n) % n)
}
