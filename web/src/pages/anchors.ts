import { attachTurns } from '../undo/attachTurns'
import { isShowPageName, pageIdIn, type VisualPageDto } from '../../../shared/visual-pages'
import type { TurnDto } from '../../../shared/undo'
import type { ChatItem } from '../types'

/**
 * O id do cartão: tool_call sem erro, nome terminado em show_page, resultado com pg_…; senão null.
 * O id vem no texto do resultado (Claude, Kimi, OpenCode) ou no JSON do
 * `mcpToolCall` (Codex); a busca pelo padrão serve aos dois. Um `exec` que
 * imprima um id não passa pelo nome.
 */
export function pageIdOfToolCall(item: ChatItem): string | null {
  if (item.kind !== 'tool_call' || item.isError || typeof item.result !== 'string') return null
  if (!isShowPageName(item.name)) return null
  return pageIdIn(item.result)
}

/**
 * Páginas sem chamada visível: as de turno com texto vão ao fim do bloco do turno; as outras ficam só no menu do terminal.
 * Turnos = os reais do desfazer (quando carregados) mais pseudo-turnos { id: turnId, key: turnKey, origin: 'operator' } dos que faltam; posição por attachTurns.
 * afterIndex < 0 sem atStart, turnKey nulo ou turno que não casou: fora de `at`.
 *
 * Os turnos reais importam com texto repetido: dois "continue" (turnos 5 e 9)
 * e página só no 5. Sozinho, o pseudo-turno do 5 pegaria o "continue" mais
 * novo, que é do 9; com os dois, o `attachTurns` casa cada um no seu.
 */
export function placePages(items: ChatItem[], pages: VisualPageDto[], turns: TurnDto[] | undefined, atStart: boolean):
  { at: Map<number, VisualPageDto[]>; shown: Set<string> } {
  const shown = new Set<string>()
  for (const it of items) {
    const id = pageIdOfToolCall(it)
    if (id !== null) shown.add(id)
  }
  // Só as que precisam de lugar: sem chamada visível e com turno de texto.
  const loose = pages.filter(p => !shown.has(p.id) && p.turnId !== null && p.turnKey !== null)
  if (loose.length === 0) return { at: new Map(), shown }

  const real = turns ?? []
  const known = new Set(real.map(t => t.id))
  const all: TurnDto[] = real.slice()
  for (const p of loose) {
    if (known.has(p.turnId!)) continue
    known.add(p.turnId!)
    // O attachTurns só olha id, key e origin.
    all.push({ id: p.turnId!, key: p.turnKey, origin: 'operator' } as TurnDto)
  }
  const afterOf = new Map<number, number>()
  for (const placement of attachTurns(items, all)) {
    if (placement.itemIndex === null) continue
    if (placement.afterIndex < 0 && !atStart) continue
    afterOf.set(placement.turn.id, placement.afterIndex)
  }

  const at = new Map<number, VisualPageDto[]>()
  for (const p of loose) {
    const after = afterOf.get(p.turnId!)
    if (after === undefined) continue
    const list = at.get(after)
    if (list) list.push(p)
    else at.set(after, [p])
  }
  return { at, shown }
}
