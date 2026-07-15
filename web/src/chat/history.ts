import type { ChatItem } from '../types'

/** Marcadores que o CLI injeta como mensagem de usuário (ex.: ao interromper o turno). */
const CLI_MARKER = /^\[Request interrupted/

/** A mensagem é do usuário de verdade (não subagente, não marcador do CLI)? */
export function isEditableUserText(item: ChatItem): item is ChatItem & { kind: 'user_text'; text: string } {
  return item.kind === 'user_text' && !item.fromSubagent && !CLI_MARKER.test(item.text)
}

/** Textos das últimas n mensagens do usuário (sem subagentes/marcadores), da mais antiga p/ a mais recente. */
export function lastUserTexts(items: ChatItem[], n = 5): string[] {
  const texts: string[] = []
  for (const item of items) {
    if (isEditableUserText(item)) texts.push(item.text)
  }
  return texts.slice(-n)
}

/** Passo de navegação estilo histórico de shell. index null = fora do modo. */
export function historyStep(list: string[], index: number | null, dir: 'up' | 'down'): { index: number | null; text: string } {
  if (list.length === 0) return { index: null, text: '' }
  if (dir === 'up') {
    const next = index === null ? list.length - 1 : Math.max(0, index - 1)
    return { index: next, text: list[next] }
  }
  if (index === null) return { index: null, text: '' }
  const next = index + 1
  if (next >= list.length) return { index: null, text: '' }
  return { index: next, text: list[next] }
}
