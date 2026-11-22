import { describe, it, expect } from 'vitest'
import { toViewport } from '../browser/coords'

/** O ponteiro no canvas convertido para px CSS do viewport da página. */
describe('toViewport', () => {
  const vp = { width: 1280, height: 800 }

  it('rect 640×400 mostrando viewport 1280×800: clique em (320,200) → (640,400)', () => {
    expect(toViewport(320, 200, { left: 0, top: 0, width: 640, height: 400 }, vp)).toEqual({ x: 640, y: 400 })
    // Com a tela deslocada na página, conta a posição dentro dela; arredondado.
    expect(toViewport(110.3, 60.2, { left: 100, top: 50, width: 640, height: 400 }, vp)).toEqual({ x: 21, y: 20 })
  })

  it('fora do canvas é grampeado', () => {
    const rect = { left: 10, top: 10, width: 640, height: 400 }
    expect(toViewport(0, 0, rect, vp)).toEqual({ x: 0, y: 0 })
    expect(toViewport(5000, 5000, rect, vp)).toEqual({ x: 1279, y: 799 })
    expect(toViewport(-30, 300, rect, vp)).toEqual({ x: 0, y: 580 })
  })

  it('rect sem tamanho dá a origem', () => {
    expect(toViewport(10, 10, { left: 0, top: 0, width: 0, height: 0 }, vp)).toEqual({ x: 0, y: 0 })
  })
})
