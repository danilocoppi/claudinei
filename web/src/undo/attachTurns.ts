import { turnKey, type TurnDto } from '../../../shared/undo'
import type { ChatItem } from '../types'

/**
 * Onde desenhar a linha de cada turno no chat. `itemIndex`: a mensagem que
 * abriu o turno (null se não casou ou não tem texto); `afterIndex`: a linha vai
 * logo depois deste item (-1 = antes do primeiro).
 */
export interface TurnPlacement { turn: TurnDto; afterIndex: number; itemIndex: number | null }

/** As notas do desfazer: grudadas na mensagem seguinte, não são turnos. */
const isUndoNote = (it: ChatItem): boolean =>
  it.kind === 'claudinei_message' && (it.reason === 'files_reverted' || it.reason === 'conversation_rewound')

/**
 * Item do lado do operador que abre um turno: o texto digitado (sem o de
 * subagente e o que a engine injetou), a tarefa, o agendamento e as mensagens
 * do Claudinei, menos as notas.
 */
function isTurnItem(it: ChatItem): it is ChatItem & { text: string } {
  switch (it.kind) {
    case 'user_text': return !it.fromSubagent && !it.fromEngine
    case 'task_message':
    case 'scheduled_message': return true
    case 'claudinei_message': return !isUndoNote(it)
    default: return false
  }
}

/**
 * O corpo de `task_message`, `scheduled_message` e `claudinei_message` chega
 * sem o envelope (`[Task from X]: `, `[Agendamento: … #n]: `, `[Claudinei: …]: `),
 * e a `turnKey` do servidor tira um envelope só, o deles. Um corpo que começa
 * com colchete (`[WIP] foo`, `[docs](url) …`) perderia mais um aqui; um
 * envelope qualquer na frente faz a `turnKey` tirar exatamente o que o
 * servidor tirou. O texto digitado (`user_text`) é o inteiro, sem envelope a pôr.
 */
const ENVELOPED = '[x]: '

/** As chaves já calculadas: os itens do chat não mudam, a lista é que cresce. */
const keyCache = new WeakMap<ChatItem, string | null>()

/** A `turnKey` do item, se ele abre turno; null se não abre. Calculada uma vez por item. */
function itemKey(it: ChatItem): string | null {
  const cached = keyCache.get(it)
  if (cached !== undefined) return cached
  let key: string | null = null
  // O pacote da ⇄ traz a chave do texto cru (o cartão guarda só o corpo).
  if (isTurnItem(it)) {
    key = it.kind === 'claudinei_message' && it.reason === 'handoff' && it.turnKey !== undefined
      ? it.turnKey
      : turnKey(it.kind === 'user_text' ? it.text : ENVELOPED + it.text)
  }
  keyCache.set(it, key)
  return key
}

/**
 * Casa os turnos gravados com as mensagens do chat pela mesma `turnKey` do
 * servidor. Do mais novo ao mais velho, cada turno pega a mensagem casável
 * mais recente antes da última casada: textos repetidos ("continue") caem na
 * ordem certa. A linha vai no fim do bloco (antes da próxima mensagem do
 * operador ou de uma nota dela, ou no fim da lista). Turno sem texto
 * (`engine`) ou que não casou vai logo depois da linha do turno anterior
 * casado; sem anterior, no começo. `interactive` não vai no chat.
 *
 * Roda a cada render do chat ativo (a parte cara da página): as chaves ficam
 * no cache por item e as posições de cada chave num índice, com um ponteiro
 * por chave que só desce. Fica linear no tamanho da lista mais os turnos.
 *
 * Um descasamento (mensagem que a web não vê) só desloca a linha: o servidor
 * acha a mensagem pelo turno gravado antes de qualquer corte (R22).
 */
export function attachTurns(items: ChatItem[], turns: TurnDto[]): TurnPlacement[] {
  // Fim do bloco que começa em cada mensagem (o item antes da próxima
  // fronteira) e as posições das mensagens por chave, em ordem crescente.
  const blockEnd = new Array<number>(items.length)
  const positions = new Map<string, number[]>()
  let end = items.length - 1
  for (let i = items.length - 1; i >= 0; i--) {
    blockEnd[i] = end
    const key = itemKey(items[i])
    if (key !== null || isUndoNote(items[i])) end = i - 1
  }
  for (let i = 0; i < items.length; i++) {
    const key = itemKey(items[i])
    if (key === null) continue
    const list = positions.get(key)
    if (list) list.push(i)
    else positions.set(key, [i])
  }

  const ordered = turns.filter(t => t.origin !== 'interactive').sort((a, b) => a.id - b.id)
  const matched = new Array<number | null>(ordered.length).fill(null)
  // Por chave, o índice em `positions` da próxima candidata: só desce, como o limite.
  const cursor = new Map<string, number>()
  let limit = items.length
  for (let k = ordered.length - 1; k >= 0; k--) {
    const key = ordered[k].key
    if (key === null) continue
    const list = positions.get(key)
    if (!list) continue
    let p = cursor.get(key) ?? list.length - 1
    while (p >= 0 && list[p] >= limit) p--
    if (p >= 0) { matched[k] = list[p]; limit = list[p]; p-- }
    cursor.set(key, p)
  }

  let prevAfter = -1
  return ordered.map((turn, k) => {
    const itemIndex = matched[k]
    if (itemIndex === null) return { turn, afterIndex: prevAfter, itemIndex: null }
    prevAfter = blockEnd[itemIndex]
    return { turn, afterIndex: prevAfter, itemIndex }
  })
}

/**
 * A chave da mensagem em `index` e quantas mensagens do operador com a mesma
 * chave vêm depois dela (0 = a última), como o servidor conta no histórico do
 * motor. Com o turno gravado, o servidor recalcula a ocorrência pelos turnos
 * (R22); esta vale para a mensagem anterior ao recurso.
 */
export function occurrenceOf(items: ChatItem[], index: number): { key: string; occurrence: number } {
  const it = items[index]
  let key = ''
  if (it) key = itemKey(it) ?? ('text' in it && typeof it.text === 'string' ? turnKey(it.text) : '')
  let occurrence = 0
  for (let i = index + 1; i < items.length; i++) {
    if (itemKey(items[i]) === key) occurrence++
  }
  return { key, occurrence }
}
