import type { FrameHeader } from '../../../shared/browser'

type Decode = (b: Blob) => Promise<ImageBitmap>

/**
 * O desenho da tela, sem laço de quadros (frontend sem GPU): cada quadro que
 * chega vira bitmap (`createImageBitmap`) e `drawImage`, e o bitmap é fechado
 * logo depois. Com uma decodificação em curso, só o último quadro chegado
 * espera a vez; os do meio nem são decodificados. Quadro mais velho que o já
 * desenhado é descartado. Nada de `requestAnimationFrame`: o desenho sai quando
 * a decodificação termina.
 */
export function createPainter(canvas: HTMLCanvasElement, d: { createImageBitmap?: Decode } = {}): {
  push(image: Blob, header: FrameHeader): void
  lastSeq(): number
  /** Tira o quadro que esperava a vez (a tela saiu de vista): ele não é decodificado. */
  takeWaiting(): { image: Blob; header: FrameHeader } | null
  /**
   * Conexão nova (outra aba no servidor, com o `seq` de volta a 1): esquece o
   * último desenhado e o que esperava; o que ainda decodifica, da conexão
   * anterior, é fechado sem desenhar.
   */
  reset(): void
  /** Para de desenhar: o que estiver decodificando é fechado ao terminar. */
  dispose(): void
} {
  const decode: Decode = d.createImageBitmap ?? ((b) => createImageBitmap(b))
  let ctx: CanvasRenderingContext2D | null = null
  let busy = false
  let waiting: { image: Blob; header: FrameHeader } | null = null
  let drawn = -1
  let disposed = false
  /** Muda a cada `reset`: a decodificação de antes dele não desenha. */
  let epoch = 0

  function start(image: Blob, header: FrameHeader): void {
    busy = true
    const ep = epoch
    decode(image).then((bmp) => {
      // O bitmap é fechado mesmo se o desenho lançar (canvas sem contexto, bitmap inválido).
      try {
        // Desmontado no meio, conexão trocada (reset) ou um quadro mais novo já desenhado: só fecha.
        if (!disposed && ep === epoch && header.seq > drawn) {
          // O contexto só na primeira vez: sem quadro, o canvas nem é tocado.
          ctx ??= canvas.getContext('2d')
          ctx?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
          drawn = header.seq
        }
      } finally {
        bmp.close()
      }
    }).catch(() => { /* imagem ruim ou desenho que falhou: fica a anterior */ }).finally(() => {
      busy = false
      const next = waiting
      waiting = null
      if (next && !disposed) start(next.image, next.header)
    })
  }

  return {
    push(image, header) {
      if (disposed || header.seq <= drawn) return
      if (busy) { waiting = { image, header }; return }
      start(image, header)
    },
    lastSeq: () => drawn,
    takeWaiting() {
      const w = waiting
      waiting = null
      return w
    },
    reset() { epoch++; drawn = -1; waiting = null },
    dispose() { disposed = true; waiting = null },
  }
}
