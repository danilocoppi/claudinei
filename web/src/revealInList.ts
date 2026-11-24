/**
 * Rola `list` o mínimo para `item` aparecer inteiro, com o recuo interno da
 * lista em volta (assim o primeiro item volta a mostrar o topo do menu). Mexe
 * só no scrollTop da própria lista: `scrollIntoView` também rolaria os
 * ancestrais (a conversa, a página no celular) quando o menu encosta na borda.
 */
export function revealInList(list: HTMLElement, item: HTMLElement): void {
  const style = getComputedStyle(list)
  const box = list.getBoundingClientRect()
  const it = item.getBoundingClientRect()
  const top = box.top + list.clientTop + (parseFloat(style.paddingTop) || 0)
  const bottom = box.top + list.clientTop + list.clientHeight - (parseFloat(style.paddingBottom) || 0)
  if (it.top < top) list.scrollTop -= top - it.top
  else if (it.bottom > bottom) list.scrollTop += it.bottom - bottom
}
