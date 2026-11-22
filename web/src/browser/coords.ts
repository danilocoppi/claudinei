/**
 * O ponteiro na tela (px da página) convertido para px CSS do viewport da aba:
 * a tela pode estar escalada (coluna mais estreita que o viewport, ou o viewport
 * de outro espectador com o bastão). Grampeado ao viewport e arredondado.
 */
export function toViewport(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const axis = (client: number, start: number, size: number, max: number) => {
    if (!(size > 0) || !(max > 0)) return 0
    const v = Math.round(((client - start) * max) / size)
    return Math.min(Math.max(v, 0), max - 1)
  }
  return { x: axis(clientX, rect.left, rect.width, viewport.width), y: axis(clientY, rect.top, rect.height, viewport.height) }
}
