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
 * Casa os turnos gravados com as mensagens do chat pela mesma `turnKey` do
 * servidor. Do mais novo ao mais velho, cada turno pega a mensagem casável
 * mais recente antes da última casada: textos repetidos ("continue") caem na
 * ordem certa. A linha vai no fim do bloco (antes da próxima mensagem do
 * operador ou de uma nota dela, ou no fim da lista). Turno sem texto
 * (`engine`) ou que não casou vai logo depois da linha do turno anterior
 * casado; sem anterior, no começo. `interactive` não vai no chat.
 *
 * Um descasamento (mensagem que a web não vê) só desloca a linha: o servidor
 * confere o texto e a ocorrência de novo antes de qualquer corte.
 */
export function attachTurns(items: ChatItem[], turns: TurnDto[]): TurnPlacement[] {
  const keys: Array<string | null> = items.map(it => (isTurnItem(it) ? turnKey(it.text) : null))
  // Fim do bloco que começa em cada mensagem: o item antes da próxima fronteira.
  const blockEnd = new Array<number>(items.length)
  let end = items.length - 1
  for (let i = items.length - 1; i >= 0; i--) {
    blockEnd[i] = end
    if (keys[i] !== null || isUndoNote(items[i])) end = i - 1
  }

  const ordered = turns.filter(t => t.origin !== 'interactive').sort((a, b) => a.id - b.id)
  const matched = new Array<number | null>(ordered.length).fill(null)
  let limit = items.length
  for (let k = ordered.length - 1; k >= 0; k--) {
    const key = ordered[k].key
    if (key === null) continue
    for (let i = limit - 1; i >= 0; i--) {
      if (keys[i] === key) { matched[k] = i; limit = i; break }
    }
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
 * motor para achar o ponto de corte.
 */
export function occurrenceOf(items: ChatItem[], index: number): { key: string; occurrence: number } {
  const it = items[index]
  const key = it && 'text' in it && typeof it.text === 'string' ? turnKey(it.text) : ''
  let occurrence = 0
  for (let i = index + 1; i < items.length; i++) {
    const other = items[i]
    if (isTurnItem(other) && turnKey(other.text) === key) occurrence++
  }
  return { key, occurrence }
}
