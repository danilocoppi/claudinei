import { uploadFile } from '../api'
import { requestAppend } from '../branch/sideStore'
import i18n from '../i18n'

/**
 * A anotação da tela do navegador, sem React: as marcas, o recorte, o desenho
 * (o mesmo na tela da anotação e na imagem mandada) e o "Mandar ao campo".
 * As coordenadas são px CSS do viewport da aba (as do congelado).
 */

export type Mark =
  | { kind: 'rect' | 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'text'; x: number; y: number; text: string }

export interface AnnotationState { marks: Mark[]; crop: { x: number; y: number; w: number; h: number } | null }

type Viewport = { width: number; height: number }
type Crop = NonNullable<AnnotationState['crop']>

/** A espessura do traço, a ponta da seta e a letra do texto (px do viewport). */
const LINE = 3
const HEAD = 16
const FONT = '600 18px system-ui, sans-serif'

export function addMark(s: AnnotationState, m: Mark): AnnotationState {
  return { ...s, marks: [...s.marks, m] }
}

/** Tira a última marca (o recorte fica). */
export function undoMark(s: AnnotationState): AnnotationState {
  return s.marks.length ? { ...s, marks: s.marks.slice(0, -1) } : s
}

/**
 * A linha que acompanha o anexo no campo, na língua da interface: o operador a
 * lê (e pode editar) antes de mandar, e o agente a recebe como parte da fala dele.
 */
export function annotationText(url: string, viewport: Viewport): string {
  return i18n.t('browser.annotate.message', { url, width: viewport.width, height: viewport.height })
}

const dois = (n: number) => String(n).padStart(2, '0')

/** Nome do anexo, na hora local: `anotacao-HHMMSS.png`. */
export function annotationFileName(now: Date = new Date()): string {
  return `anotacao-${dois(now.getHours())}${dois(now.getMinutes())}${dois(now.getSeconds())}.png`
}

/**
 * O retângulo entre dois cantos quaisquer, grampeado ao viewport e em px
 * inteiros. Null quando sobra menos de 2 px num dos lados (um clique, não um arrasto).
 */
export function normRect(x1: number, y1: number, x2: number, y2: number, vp: Viewport): Crop | null {
  const clamp = (v: number, max: number) => Math.min(Math.max(Math.round(v), 0), max)
  const ax = clamp(Math.min(x1, x2), vp.width)
  const ay = clamp(Math.min(y1, y2), vp.height)
  const bx = clamp(Math.max(x1, x2), vp.width)
  const by = clamp(Math.max(y1, y2), vp.height)
  return bx - ax >= 2 && by - ay >= 2 ? { x: ax, y: ay, w: bx - ax, h: by - ay } : null
}

/** Uma marca no contexto, na cor dada. */
function drawMark(ctx: CanvasRenderingContext2D, m: Mark, color: string): void {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = LINE
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (m.kind === 'text') {
    ctx.font = FONT
    ctx.textBaseline = 'top'
    // Um contorno escuro sob a letra: legível sobre fundo claro ou escuro.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.strokeText(m.text, m.x, m.y)
    ctx.fillText(m.text, m.x, m.y)
  } else if (m.kind === 'rect') {
    ctx.strokeRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1))
  } else {
    const a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1)
    ctx.beginPath()
    ctx.moveTo(m.x1, m.y1)
    ctx.lineTo(m.x2, m.y2)
    ctx.moveTo(m.x2 - HEAD * Math.cos(a - Math.PI / 7), m.y2 - HEAD * Math.sin(a - Math.PI / 7))
    ctx.lineTo(m.x2, m.y2)
    ctx.lineTo(m.x2 - HEAD * Math.cos(a + Math.PI / 7), m.y2 - HEAD * Math.sin(a + Math.PI / 7))
    ctx.stroke()
  }
}

/** A base (o congelado, no tamanho do viewport) e as marcas por cima. */
export function drawAnnotation(ctx: CanvasRenderingContext2D, still: CanvasImageSource, marks: Mark[], vp: Viewport, color: string): void {
  ctx.drawImage(still, 0, 0, vp.width, vp.height)
  for (const m of marks) drawMark(ctx, m, color)
}

/** A cor das marcas: `--accent` do elemento (ou da raiz), lida na hora. */
export function accentColor(el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue('--accent').trim() || '#7c5cff'
}

/**
 * Mandar ao campo: desenha a base e as marcas no recorte (ou no viewport
 * inteiro), gera o PNG, sobe como `anotacao-HHMMSS.png` e acrescenta ao campo
 * da sessão principal (`localId`) o texto "Anotação de <URL> (viewport L×A):"
 * (na língua da interface) com o token do anexo. Rejeita se o PNG ou o upload falharem (nada vai ao campo).
 */
export async function sendAnnotation(o: {
  localId: string; still: ImageBitmap; s: AnnotationState; url: string; viewport: Viewport
  upload?: typeof uploadFile; append?: typeof requestAppend
  /** A cor das marcas (a tela lê `--accent` uma vez e repassa). */
  color?: string
}): Promise<void> {
  const upload = o.upload ?? uploadFile
  const append = o.append ?? requestAppend
  const area = o.s.crop ?? { x: 0, y: 0, w: o.viewport.width, h: o.viewport.height }
  const canvas = document.createElement('canvas')
  canvas.width = area.w
  canvas.height = area.h
  let blob: Blob
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d unavailable')
    ctx.translate(-area.x, -area.y)
    drawAnnotation(ctx, o.still, o.s.marks, o.viewport, o.color ?? accentColor())
    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG failed'))), 'image/png')
    })
  } finally {
    // O canvas fora da tela solta a memória na hora.
    canvas.width = 0
    canvas.height = 0
  }
  const saved = await upload(new File([blob], annotationFileName(), { type: 'image/png' }))
  const tok = `[📎 ${saved.name}]`
  append(o.localId, `${annotationText(o.url, o.viewport)} ${tok}`, [[tok, saved.path]])
}
