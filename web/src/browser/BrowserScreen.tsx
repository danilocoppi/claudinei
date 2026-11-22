import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserClientMsg, FrameHeader } from '../../../shared/browser'
import { matchShortcut } from '../shortcuts/active'
import { toViewport } from './coords'
import { createPainter } from './painter'

/** Um quadro que chegou pelo socket. */
export type Frame = { header: FrameHeader; image: Blob }
export type FrameSink = (f: Frame) => void

/** A espera do `resize` depois da última mudança da área. */
const RESIZE_WAIT_MS = 250

/**
 * O `resize` da aba: mede `el` (a área estável da vista, que inclui as faixas
 * variáveis acima da tela) e manda o tamanho em px CSS arredondados 250 ms
 * depois da última mudança, só se mudou. Uma faixa que aparece ou some (aviso
 * de senha, servidores, última ação, avisos) não muda a medida: só o palco da
 * tela encolhe pela escala, e a página do agente não reflui.
 */
export function useResizeSender(el: HTMLElement | null, send: (m: BrowserClientMsg) => void): void {
  useLayoutEffect(() => {
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let sent = ''
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect
      if (!r) return
      const rw = Math.round(r.width)
      const rh = Math.round(r.height)
      if (!(rw > 0 && rh > 0)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const k = `${rw}x${rh}`
        if (k === sent) return
        sent = k
        send({ type: 'resize', width: rw, height: rh })
      }, RESIZE_WAIT_MS)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [el, send])
}
/** O intervalo mínimo entre dois `move` (e entre duas rolagens): no máximo 20 por segundo. */
const MOVE_MS = 50
/** A marca da ação do agente some no primeiro quadro depois disto. */
const MARK_MS = 1500
/** O `text` acima disso é ignorado pelo servidor: vai em pedaços. */
const TEXT_MAX = 10000
/** Dois cliques mais perto que isto (tempo e distância) somam no `clickCount`. */
const DOUBLE_MS = 500
const DOUBLE_PX = 4
/** Arrastar o dedo menos que isto ainda é um toque. */
const TAP_PX = 8

type Props = {
  viewportWidth: number
  viewportHeight: number
  /** O bastão é deste operador: só aí o `move` sai. */
  you: boolean
  /** A vista está visível: fora dela nenhum quadro é decodificado (o último fica guardado). */
  visible: boolean
  /** A ação do agente: posição em px do viewport e o instante (`Date.now()` do servidor). */
  mark: { x: number; y: number; at: number } | null
  send(m: BrowserClientMsg): void
  /** Onde o socket entrega os quadros. */
  frameRef: React.MutableRefObject<FrameSink | null>
  /** Quem fecha o socket chama antes: solta as teclas que a página acha que estão apertadas. */
  releaseRef: React.MutableRefObject<(() => void) | null>
  onIntersect(on: boolean): void
}

const BUTTONS = ['left', 'middle', 'right'] as const

/** Ctrl+V, ⌘V (com ou sem Shift) e Shift+Insert: o colar do navegador do operador. */
export function isPasteKey(e: KeyboardEvent): boolean {
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Insert') return true
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')
}

/**
 * A tecla que vai como `text`, e não como `key`: um único caractere fora de
 * U+0020–U+007E (o teclado americano do Playwright não o conhece) ou montado
 * com AltGr (no Windows o AltGr chega como Ctrl+Alt, e a página não o digitaria).
 */
export function isTextKey(e: KeyboardEvent): boolean {
  const chars = [...e.key]
  if (chars.length !== 1) return false
  const c = chars[0].codePointAt(0)!
  return c < 0x20 || c > 0x7e || !!e.getModifierState?.('AltGraph')
}

/**
 * Agenda `run` para no máximo uma vez a cada `ms`: a primeira chamada roda na
 * hora; as seguintes, dentro do intervalo, viram uma só no fim dele (com o
 * estado mais recente, que `run` lê). Um `setTimeout`, nunca um laço de quadros.
 */
function throttle(run: () => void, ms: number) {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = () => { timer = null; last = Date.now(); run() }
  return {
    schedule() {
      if (timer) return
      const wait = last + ms - Date.now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    cancel() { if (timer) clearTimeout(timer); timer = null },
  }
}

/**
 * A tela do navegador: um `<canvas>` do tamanho do viewport, que só desenha
 * quando chega quadro (sem laço de quadros, sem transição), e um `<textarea>`
 * invisível por cima, que recebe teclado, colar e composição. Com o foco nele,
 * toda tecla vai à página, menos a combinação de `view.browser`, que sobe ao
 * atalho global. Clicar fora devolve o teclado ao Claudinei.
 *
 * A área mede a si mesma (`ResizeObserver`) só para a escala: o canvas cabe
 * nela sem passar da escala 1. O `resize` da aba sai da área estável da coluna
 * (`useResizeSender`). O `IntersectionObserver` diz se a tela está na vista.
 * O que cobre a tela (diálogo, página travada, navegador fechado) fica fora
 * daqui, na coluna: as props são estáveis e o `memo` evita redesenhar a tela a
 * cada `state`.
 */
export const BrowserScreen = memo(function BrowserScreen(p: Props) {
  const { t } = useTranslation()
  const areaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const keysRef = useRef<HTMLTextAreaElement>(null)
  const [area, setArea] = useState<{ w: number; h: number } | null>(null)
  /** O `at` da marca que já foi apagada. */
  const [markGone, setMarkGone] = useState<number | null>(null)

  // As props que os ouvintes nativos leem na hora, sem se reinscrever.
  const live = useRef(p)
  live.current = p

  // A medida da área (só a escala do palco: o `resize` sai da coluna, ver `useResizeSender`).
  const { onIntersect } = p
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect
      if (!r) return
      const rw = Math.round(r.width)
      const rh = Math.round(r.height)
      if (rw > 0 && rh > 0) setArea((cur) => (cur && cur.w === rw && cur.h === rh ? cur : { w: rw, h: rh }))
    })
    ro.observe(el)
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last) onIntersect(last.isIntersecting)
    })
    io.observe(el)
    return () => {
      ro.disconnect()
      io.disconnect()
    }
  }, [onIntersect])

  // O pintor e a entrega dos quadros. Com a tela invisível, o quadro só fica
  // guardado (sem decodificar); ao voltar, o último guardado é desenhado.
  const heldRef = useRef<Frame | null>(null)
  const painterRef = useRef<ReturnType<typeof createPainter> | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const painter = createPainter(canvas)
    painterRef.current = painter
    p.frameRef.current = (f) => {
      if (!live.current.visible) { heldRef.current = f; return }
      painter.push(f.image, f.header)
      const m = live.current.mark
      if (m && Date.now() - m.at >= MARK_MS) setMarkGone((cur) => (cur === m.at ? cur : m.at))
    }
    const frameRef = p.frameRef
    return () => {
      if (frameRef.current) frameRef.current = null
      painter.dispose()
      painterRef.current = null
      heldRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const painter = painterRef.current
    if (!painter) return
    if (!p.visible) {
      // O que esperava a vez também não é decodificado.
      const w = painter.takeWaiting()
      if (w && (!heldRef.current || heldRef.current.header.seq < w.header.seq)) heldRef.current = w
      return
    }
    const held = heldRef.current
    heldRef.current = null
    if (held) p.frameRef.current?.(held)
  }, [p.visible, p.frameRef])

  // O teclado, o colar e a composição: ouvintes nativos no textarea.
  useEffect(() => {
    const ta = keysRef.current
    if (!ta) return
    /** As teclas que a página recebeu apertadas (pelo `code`, ou pela `key`). */
    const pressed = new Map<string, { key: string; code: string }>()
    const composing = (e: KeyboardEvent) => e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified' || e.keyCode === 229
    /**
     * O último `keydown` foi deixado ao navegador do operador (composição, ou o
     * 229/Unidentified do teclado virtual do celular): o `input` sem composição
     * que vier depois traz o texto (no Android, espaço e pontuação chegam assim).
     */
    let skipped = false
    const keyMsg = (phase: 'down' | 'up', k: { key: string; code: string }, e?: KeyboardEvent): BrowserClientMsg => ({
      type: 'key', phase, key: k.key, code: k.code,
      alt: !!e?.altKey, ctrl: !!e?.ctrlKey, meta: !!e?.metaKey, shift: !!e?.shiftKey,
    })
    const sendText = (text: string) => {
      for (let i = 0; i < text.length; i += TEXT_MAX) live.current.send({ type: 'text', text: text.slice(i, i + TEXT_MAX) })
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // A combinação do Navegador sai da página: sobe ao atalho global, que fecha a vista.
      if (matchShortcut(e, 'view.browser')) return
      e.stopPropagation()
      // Na composição (IME, tecla morta, teclado virtual) o navegador do operador monta o texto;
      // o fim dela (ou o `input` que vier) vai como `text`.
      if (composing(e)) { skipped = true; return }
      skipped = false
      // Colar: o `keydown` não é cancelado, para o navegador do operador soltar o `paste`
      // (com a área de transferência dele), que vai como `text`. A tecla não vai à página.
      if (isPasteKey(e)) return
      e.preventDefault()
      // Caractere fora do teclado americano (ç, €, °, ª…) ou montado com AltGr: o Playwright
      // não o conhece como tecla ("Unknown key"); vai como `text`, sem `up` depois.
      if (isTextKey(e)) { sendText(e.key); return }
      const k = { key: e.key, code: e.code }
      pressed.set(e.code || e.key, k)
      live.current.send(keyMsg('down', k, e))
    }
    const onKeyUp = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (composing(e)) return
      e.preventDefault()
      const id = e.code || e.key
      const k = pressed.get(id)
      if (!k) return
      pressed.delete(id)
      live.current.send(keyMsg('up', { key: e.key, code: e.code }, e))
    }
    const release = () => {
      for (const k of pressed.values()) live.current.send(keyMsg('up', k))
      pressed.clear()
    }
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (text) sendText(text)
    }
    const onCompositionEnd = (e: CompositionEvent) => {
      // O `input` que alguns navegadores soltam depois do fim da composição não repete o texto.
      skipped = false
      if (e.data) sendText(e.data)
      ta.value = ''
    }
    // Sem composição, a tecla já foi como `key` e o que cair no campo é descartado; a
    // exceção é o `keydown` deixado ao navegador (229/Unidentified do teclado virtual):
    // aí o texto vem só aqui, no `data` do `input`.
    const onInput = (e: Event) => {
      const ie = e as InputEvent
      if (ie.isComposing) return
      if (skipped && ie.data && (!ie.inputType || ie.inputType === 'insertText')) sendText(ie.data)
      skipped = false
      ta.value = ''
    }
    ta.addEventListener('keydown', onKeyDown)
    ta.addEventListener('keyup', onKeyUp)
    ta.addEventListener('blur', release)
    ta.addEventListener('paste', onPaste)
    ta.addEventListener('compositionend', onCompositionEnd)
    ta.addEventListener('input', onInput)
    p.releaseRef.current = release
    const releaseRef = p.releaseRef
    return () => {
      ta.removeEventListener('keydown', onKeyDown)
      ta.removeEventListener('keyup', onKeyUp)
      ta.removeEventListener('blur', release)
      ta.removeEventListener('paste', onPaste)
      ta.removeEventListener('compositionend', onCompositionEnd)
      ta.removeEventListener('input', onInput)
      if (releaseRef.current === release) releaseRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // O ponteiro: mouse, rolagem e toque. Ouvintes nativos no canvas (a rolagem
  // precisa de `passive: false` para o `preventDefault`).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const pos = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect()
      return toViewport(clientX, clientY, r, { width: live.current.viewportWidth, height: live.current.viewportHeight })
    }
    /** Px da tela → px do viewport (o arrasto do dedo). */
    const scale = () => {
      const r = canvas.getBoundingClientRect()
      return r.width > 0 ? live.current.viewportWidth / r.width : 1
    }
    let lastDown = { at: -Infinity, x: 0, y: 0, button: '', count: 0 }
    let down: { button: (typeof BUTTONS)[number]; count: number } | null = null

    let movePos: { x: number; y: number } | null = null
    const mover = throttle(() => {
      if (!movePos || !live.current.you) return
      live.current.send({ type: 'pointer', phase: 'move', x: movePos.x, y: movePos.y, button: down?.button ?? 'left' })
      movePos = null
    }, MOVE_MS)

    let wheel = { x: 0, y: 0, dx: 0, dy: 0 }
    const roller = throttle(() => {
      if (!wheel.dx && !wheel.dy) return
      live.current.send({ type: 'wheel', x: wheel.x, y: wheel.y, dx: Math.round(wheel.dx), dy: Math.round(wheel.dy) })
      wheel = { ...wheel, dx: 0, dy: 0 }
    }, MOVE_MS)

    let touch: { id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null = null
    const isTouch = (e: PointerEvent) => e.pointerType === 'touch'

    const onPointerDown = (e: PointerEvent) => {
      if (isTouch(e)) {
        touch = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false }
        return
      }
      e.preventDefault()
      // Os botões laterais (voltar/avançar do mouse) não são da página: o servidor só conhece três.
      if (e.button < 0 || e.button > 2) return
      keysRef.current?.focus({ preventScroll: true })
      const button = BUTTONS[e.button]
      const { x, y } = pos(e.clientX, e.clientY)
      const now = Date.now()
      const near = now - lastDown.at < DOUBLE_MS && lastDown.button === button
        && Math.abs(x - lastDown.x) <= DOUBLE_PX && Math.abs(y - lastDown.y) <= DOUBLE_PX
      // 1, 2, 3, 1, 2, 3…: o servidor recusa `clickCount` acima de 4 (e o clique sumiria).
      const count = near ? (lastDown.count % 3) + 1 : 1
      lastDown = { at: now, x, y, button, count }
      down = { button, count }
      try { canvas.setPointerCapture?.(e.pointerId) } catch { /* ponteiro já solto */ }
      live.current.send({ type: 'pointer', phase: 'down', x, y, button, clickCount: count })
    }
    const onPointerUp = (e: PointerEvent) => {
      if (isTouch(e)) {
        const t0 = touch
        touch = null
        if (!t0 || t0.id !== e.pointerId) return
        if (t0.moved) { roller.schedule(); return }
        // Um toque: clique.
        keysRef.current?.focus({ preventScroll: true })
        const { x, y } = pos(e.clientX, e.clientY)
        live.current.send({ type: 'pointer', phase: 'down', x, y, button: 'left', clickCount: 1 })
        live.current.send({ type: 'pointer', phase: 'up', x, y, button: 'left', clickCount: 1 })
        return
      }
      if (e.button < 0 || e.button > 2) { e.preventDefault(); return }
      if (!down) return
      const { x, y } = pos(e.clientX, e.clientY)
      const d = down
      down = null
      // O `move` pendente é descartado: o `up` leva a posição (o servidor move antes de soltar).
      mover.cancel()
      movePos = null
      live.current.send({ type: 'pointer', phase: 'up', x, y, button: d.button, clickCount: d.count })
    }
    const onPointerMove = (e: PointerEvent) => {
      if (isTouch(e)) {
        if (!touch || touch.id !== e.pointerId) return
        if (!touch.moved && Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) < TAP_PX) return
        touch.moved = true
        // Arrastar vira rolagem, com os deltas invertidos (o dedo sobe, a página desce).
        const k = scale()
        const { x, y } = pos(e.clientX, e.clientY)
        wheel = { x, y, dx: wheel.dx + (touch.lastX - e.clientX) * k, dy: wheel.dy + (touch.lastY - e.clientY) * k }
        touch.lastX = e.clientX
        touch.lastY = e.clientY
        roller.schedule()
        return
      }
      // Sem o bastão, o servidor não aplica: nem sai.
      if (!live.current.you) return
      movePos = pos(e.clientX, e.clientY)
      mover.schedule()
    }
    const onPointerCancel = (e: PointerEvent) => {
      if (isTouch(e)) touch = null
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? live.current.viewportHeight : 1
      const { x, y } = pos(e.clientX, e.clientY)
      wheel = { x, y, dx: wheel.dx + e.deltaX * unit, dy: wheel.dy + e.deltaY * unit }
      roller.schedule()
    }
    // O menu de contexto do navegador do operador não abre: o botão direito é da página.
    const onContextMenu = (e: Event) => e.preventDefault()
    // Sem isto o clique no canvas tiraria o foco do textarea (e selecionaria texto).
    const onMouseDown = (e: MouseEvent) => e.preventDefault()
    // Os botões laterais do mouse não voltam nem avançam o Claudinei.
    const onMouseUp = (e: MouseEvent) => { if (e.button > 2) e.preventDefault() }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('auxclick', onMouseUp)
    return () => {
      mover.cancel()
      roller.cancel()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('auxclick', onMouseUp)
    }
  }, [])

  const vw = p.viewportWidth
  const vh = p.viewportHeight
  // A tela cabe na área sem passar da escala 1 (nítida); sem medida ainda, o tamanho do viewport.
  const k = area ? Math.min(1, area.w / vw, area.h / vh) : 1
  const showMark = p.mark && markGone !== p.mark.at ? p.mark : null

  return (
    <div ref={areaRef} className="browser-screen">
      <div className="browser-screen__stage" style={{ width: Math.floor(vw * k), height: Math.floor(vh * k) }}>
        <canvas ref={canvasRef} className="browser-screen__canvas" width={vw} height={vh} />
        {showMark && (
          <span className="browser-screen__mark" data-testid="browser-action-mark" aria-hidden="true"
                style={{ left: `${(showMark.x / vw) * 100}%`, top: `${(showMark.y / vh) * 100}%` }} />
        )}
        <textarea ref={keysRef} className="browser-screen__keys" data-testid="browser-keys" aria-label={t('browser.screen')}
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
      </div>
    </div>
  )
})
