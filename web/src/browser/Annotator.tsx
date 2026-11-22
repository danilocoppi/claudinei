import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { requestAppend } from '../branch/sideStore'
import { toViewport } from './coords'
import {
  accentColor, addMark, drawAnnotation, normRect, sendAnnotation, undoMark, type AnnotationState, type Mark,
} from './annotate'

type Viewport = { width: number; height: number }
type Tool = 'rect' | 'arrow' | 'text' | 'crop'

type Props = {
  /** O PNG do congelado; null enquanto ele não chega. */
  still: Blob | null
  viewport: Viewport
  url: string
  /** A sessão principal do terminal, cujo campo recebe a anotação. */
  localId?: string
  /** Sair (Cancelar, Escape, mandado, ou o congelado que não decodificou): quem chama descongela. */
  onExit(error?: string): void
}

const TOOLS: Tool[] = ['rect', 'arrow', 'text', 'crop']
/** O escurecido fora do recorte. */
const SHADE = 'rgba(0, 0, 0, 0.45)'

/**
 * A anotação sobre a tela congelada: o PNG do `freeze` é a base de um canvas
 * do tamanho do viewport; retângulo, seta, texto, recorte e desfazer, numa cor
 * só (`--accent`, lida uma vez). Sem laço de quadros nem animação: o canvas só
 * é redesenhado num evento (ponteiro, marca nova, desfazer). "Mandar ao campo"
 * sobe o recorte e acrescenta o texto com o token ao campo da principal.
 *
 * O bitmap do congelado é fechado ao desmontar (qualquer saída).
 */
export function Annotator({ still, viewport: vp, url, localId, onExit }: Props) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const colorRef = useRef('')
  const [ready, setReady] = useState(false)
  const [s, setS] = useState<AnnotationState>({ marks: [], crop: null })
  const [tool, setTool] = useState<Tool>('rect')
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [area, setArea] = useState<{ w: number; h: number } | null>(null)
  /** O arrasto em curso: o canto de partida e o ponto atual (px do viewport). */
  const drag = useRef<{ tool: Tool; x1: number; y1: number; x2: number; y2: number } | null>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // A cor, uma vez; e o foco, para Escape e Mod+Z (e para as teclas não irem à página).
  useLayoutEffect(() => {
    if (rootRef.current) colorRef.current = accentColor(rootRef.current)
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  // O congelado vira bitmap uma vez; fechado ao sair.
  useEffect(() => {
    if (!still) return
    let live = true
    let bmp: ImageBitmap | null = null
    createImageBitmap(still).then((b) => {
      if (!live) { b.close(); return }
      bmp = b
      bitmapRef.current = b
      setReady(true)
    }).catch(() => { if (live) onExitRef.current(t('browser.annotate.freezeFailed')) })
    return () => {
      live = false
      bitmapRef.current = null
      bmp?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still])

  // A área mede a si mesma: o canvas cabe nela sem passar da escala 1.
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect
      if (!r || !(r.width > 0 && r.height > 0)) return
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      setArea((cur) => (cur && cur.w === w && cur.h === h ? cur : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** Redesenha base, marcas, o arrasto em curso e o recorte. Só chamado por evento. */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const bmp = bitmapRef.current
    if (!canvas || !bmp) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const color = colorRef.current
    const d = drag.current
    const marks: Mark[] = d && (d.tool === 'rect' || d.tool === 'arrow')
      ? [...s.marks, { kind: d.tool, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }]
      : s.marks
    ctx.clearRect(0, 0, vp.width, vp.height)
    drawAnnotation(ctx, bmp, marks, vp, color)
    const crop = d?.tool === 'crop' ? normRect(d.x1, d.y1, d.x2, d.y2, vp) : s.crop
    if (crop) {
      ctx.fillStyle = SHADE
      ctx.fillRect(0, 0, vp.width, crop.y)
      ctx.fillRect(0, crop.y + crop.h, vp.width, vp.height - crop.y - crop.h)
      ctx.fillRect(0, crop.y, crop.x, crop.h)
      ctx.fillRect(crop.x + crop.w, crop.y, vp.width - crop.x - crop.w, crop.h)
      ctx.setLineDash([6, 4])
      ctx.lineWidth = 2
      ctx.strokeStyle = color
      ctx.strokeRect(crop.x + 1, crop.y + 1, crop.w - 2, crop.h - 2)
      ctx.setLineDash([])
    }
  }, [s, vp])
  useEffect(() => { if (ready) redraw() }, [ready, redraw])

  const pos = (e: ReactPointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return toViewport(e.clientX, e.clientY, r, vp)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || e.button !== 0 || sending) return
    e.preventDefault()
    const p = pos(e)
    if (tool === 'text') { setTextAt(p); return }
    drag.current = { tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y }
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* ponteiro já solto */ }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) return
    const p = pos(e)
    d.x2 = p.x
    d.y2 = p.y
    redraw()
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    const p = pos(e)
    d.x2 = p.x
    d.y2 = p.y
    if (d.tool === 'crop') {
      // Um clique sem arrasto tira o recorte.
      const crop = normRect(d.x1, d.y1, d.x2, d.y2, vp)
      setS((cur) => ({ ...cur, crop }))
    } else if (Math.abs(d.x2 - d.x1) >= 2 || Math.abs(d.y2 - d.y1) >= 2) {
      setS((cur) => addMark(cur, { kind: d.tool as 'rect' | 'arrow', x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }))
    } else {
      redraw()
    }
  }
  const onPointerCancel = () => {
    if (!drag.current) return
    drag.current = null
    redraw()
  }

  const commitText = (text: string) => {
    const at = textAt
    setTextAt(null)
    if (at && text.trim()) setS((cur) => addMark(cur, { kind: 'text', x: at.x, y: at.y, text: text.trim() }))
    rootRef.current?.focus({ preventScroll: true })
  }

  const undo = () => setS(undoMark)

  const send = async () => {
    const bmp = bitmapRef.current
    if (!bmp || !localId || sending) return
    setError(null)
    setSending(true)
    try {
      // Cancelado no meio do upload: nada vai ao campo (o anexo órfão some na rotação dos uploads).
      await sendAnnotation({
        localId, still: bmp, s, url, viewport: vp, color: colorRef.current,
        append: (...args) => { if (alive.current) requestAppend(...args) },
      })
      if (alive.current) onExitRef.current()
    } catch (err) {
      if (alive.current) setError(t('browser.annotate.sendFailed', { detail: (err as Error).message }))
    } finally {
      if (alive.current) setSending(false)
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onExitRef.current()
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      e.stopPropagation()
      undo()
    }
  }

  const k = area ? Math.min(1, area.w / vp.width, area.h / vp.height) : 1

  return (
    <div ref={rootRef} className="browser-annot" data-testid="annotate" role="dialog" aria-label={t('browser.annotate.label')}
         tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="browser-annot__bar">
        {TOOLS.map((tl) => (
          <button key={tl} type="button" className="ghost browser-annot__btn" aria-pressed={tool === tl}
                  disabled={!ready} onClick={() => setTool(tl)}>
            {t(`browser.annotate.${tl}`)}
          </button>
        ))}
        <button type="button" className="ghost browser-annot__btn" disabled={!ready || !s.marks.length} onClick={undo}>
          {t('browser.annotate.undo')}
        </button>
        <span className="browser-annot__gap" />
        <button type="button" className="ghost browser-annot__btn" onClick={() => onExitRef.current()}>
          {t('browser.annotate.cancel')}
        </button>
        <button type="button" className="browser-annot__btn browser-annot__send" disabled={!ready || !localId || sending}
                onClick={() => { void send() }}>
          {t('browser.annotate.send')}
        </button>
      </div>
      {error && <div className="browser-annot__error" role="alert">{error}</div>}
      <div ref={areaRef} className="browser-annot__area">
        {!ready && <p className="browser-annot__waiting">{t('browser.annotate.waiting')}</p>}
        <div className="browser-annot__stage" hidden={!ready}
             style={{ width: Math.floor(vp.width * k), height: Math.floor(vp.height * k) }}>
          <canvas ref={canvasRef} className={`browser-annot__canvas browser-annot__canvas--${tool}`} data-testid="annotate-canvas"
                  width={vp.width} height={vp.height}
                  onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancel} />
          {textAt && (
            <TextField at={textAt} vp={vp} label={t('browser.annotate.textField')} onDone={commitText}
                       onCancel={() => { setTextAt(null); rootRef.current?.focus({ preventScroll: true }) }} />
          )}
        </div>
      </div>
    </div>
  )
}

/** O campo do texto, no ponto clicado: Enter (ou sair do campo) põe a marca; Escape desiste. */
function TextField({ at, vp, label, onDone, onCancel }: {
  at: { x: number; y: number }; vp: Viewport; label: string; onDone(text: string): void; onCancel(): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useLayoutEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  const finish = (fn: () => void) => { if (done.current) return; done.current = true; fn() }
  return (
    <input ref={ref} className="browser-annot__text" aria-label={label} autoComplete="off" spellCheck={false}
           style={{ left: `${(at.x / vp.width) * 100}%`, top: `${(at.y / vp.height) * 100}%` }}
           onKeyDown={(e) => {
             if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(() => onDone(e.currentTarget.value)) }
             else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(onCancel) }
             else e.stopPropagation()
           }}
           onBlur={(e) => finish(() => onDone(e.currentTarget.value))} />
  )
}
