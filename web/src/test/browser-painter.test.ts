import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPainter } from '../browser/painter'
import { parseFrame } from '../browser/frame'
import type { FrameHeader } from '../../../shared/browser'

/**
 * O desenho da tela do navegador (frontend sem GPU): cada quadro vira bitmap e
 * `drawImage`, só quando chega; com uma decodificação em curso, só o último
 * quadro chegado espera. Nenhum laço de `requestAnimationFrame`.
 */

const header = (seq: number, kind: FrameHeader['kind'] = 'frame'): FrameHeader => ({ kind, seq, width: 1280, height: 800 })

/** O `createImageBitmap` dublê: cada chamada fica pendurada até o teste resolver. */
function decoder() {
  const pending: Array<{ blob: Blob; resolve: (b: ImageBitmap) => void; reject: (e: unknown) => void }> = []
  const bitmaps: Array<{ close: ReturnType<typeof vi.fn>; tag: string }> = []
  const createImageBitmap = vi.fn((blob: Blob) => new Promise<ImageBitmap>((resolve, reject) => {
    pending.push({ blob, resolve, reject })
  }))
  /** Resolve a decodificação mais antiga ainda pendente. */
  const finish = async () => {
    const p = pending.shift()!
    const bmp = { close: vi.fn(), tag: String((p.blob as Blob & { tag?: string }).tag) }
    bitmaps.push(bmp)
    p.resolve(bmp as unknown as ImageBitmap)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { createImageBitmap, pending, bitmaps, finish }
}

const blob = (tag: string) => Object.assign(new Blob([tag]), { tag })

function canvasFalso() {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 800
  const ctx = { drawImage: vi.fn() }
  vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return { canvas, ctx }
}

afterEach(() => { vi.restoreAllMocks() })

describe('painter', () => {
  it('três push durante uma decodificação → só o primeiro e o último são decodificados', async () => {
    const d = decoder()
    const { canvas, ctx } = canvasFalso()
    const p = createPainter(canvas, { createImageBitmap: d.createImageBitmap })
    p.push(blob('a'), header(1))
    p.push(blob('b'), header(2))
    p.push(blob('c'), header(3))
    p.push(blob('d'), header(4))
    expect(d.createImageBitmap).toHaveBeenCalledTimes(1)
    await d.finish()
    expect(d.createImageBitmap).toHaveBeenCalledTimes(2)
    expect((d.createImageBitmap.mock.calls[1][0] as Blob & { tag: string }).tag).toBe('d')
    await d.finish()
    expect(d.createImageBitmap).toHaveBeenCalledTimes(2)
    expect(ctx.drawImage).toHaveBeenCalledTimes(2)
    expect(p.lastSeq()).toBe(4)
  })

  it('drawImage chamado por bitmap e close() logo depois', async () => {
    const d = decoder()
    const { canvas, ctx } = canvasFalso()
    const p = createPainter(canvas, { createImageBitmap: d.createImageBitmap })
    p.push(blob('a'), header(1))
    await d.finish()
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
    expect(ctx.drawImage.mock.calls[0][0]).toBe(d.bitmaps[0])
    expect(d.bitmaps[0].close).toHaveBeenCalledTimes(1)
    // O close vem depois do desenho.
    expect(d.bitmaps[0].close.mock.invocationCallOrder[0]).toBeGreaterThan(ctx.drawImage.mock.invocationCallOrder[0])
    p.push(blob('b'), header(2))
    await d.finish()
    expect(ctx.drawImage.mock.calls[1][0]).toBe(d.bitmaps[1])
    expect(d.bitmaps[1].close).toHaveBeenCalledTimes(1)
  })

  it('quadro mais velho que o já desenhado não é decodificado; dispose fecha o bitmap atrasado', async () => {
    const d = decoder()
    const { canvas, ctx } = canvasFalso()
    const p = createPainter(canvas, { createImageBitmap: d.createImageBitmap })
    p.push(blob('a'), header(5))
    await d.finish()
    p.push(blob('velho'), header(3))
    expect(d.createImageBitmap).toHaveBeenCalledTimes(1)
    p.push(blob('b'), header(6))
    p.dispose()
    await d.finish()
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
    expect(d.bitmaps[1].close).toHaveBeenCalledTimes(1)
  })

  it('nenhuma chamada a requestAnimationFrame', async () => {
    const raf = vi.fn()
    const antes = window.requestAnimationFrame
    window.requestAnimationFrame = raf
    try {
      const d = decoder()
      const { canvas } = canvasFalso()
      const p = createPainter(canvas, { createImageBitmap: d.createImageBitmap })
      p.push(blob('a'), header(1))
      p.push(blob('b'), header(2))
      await d.finish()
      await d.finish()
      expect(raf).not.toHaveBeenCalled()
    } finally {
      window.requestAnimationFrame = antes
    }
  })
})

describe('parseFrame', () => {
  const montar = (h: FrameHeader, corpo: number[]) => {
    const json = new TextEncoder().encode(JSON.stringify(h))
    const buf = new Uint8Array(4 + json.length + corpo.length)
    new DataView(buf.buffer).setUint32(0, json.length, false)
    buf.set(json, 4)
    buf.set(corpo, 4 + json.length)
    return buf.buffer
  }

  it('lê o cabeçalho e devolve a imagem com o tipo do quadro', async () => {
    const f = parseFrame(montar(header(7), [1, 2, 3]))
    expect(f.header).toEqual(header(7))
    expect(f.image.type).toBe('image/jpeg')
    expect([...new Uint8Array(await f.image.arrayBuffer())]).toEqual([1, 2, 3])
    expect(parseFrame(montar(header(8, 'still'), [9])).image.type).toBe('image/png')
  })
})
