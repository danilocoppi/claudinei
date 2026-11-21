import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

// Os diálogos do desfazer abertos, do de baixo para o de cima (a tela de
// desfazer pode abrir por cima do painel de mudanças): só o de cima atende o
// Esc que chega à janela sem dono.
const stack: object[] = []

/**
 * Foco e Esc dos diálogos do desfazer. Ao abrir, o foco entra no diálogo (que
 * precisa de `tabIndex={-1}`); ao fechar, volta para onde estava. O Esc dentro
 * do diálogo fecha e sai marcado (`preventDefault`, sem propagar no React):
 * não chega ao campo do chat, que para o turno no Esc, nem à busca. Com o foco
 * fora de tudo, o Esc que chega à janela fecha só o diálogo de cima.
 *
 * O Tab fica preso no diálogo (ver `trapTab`).
 *
 * Devolve o `onKeyDown` do elemento do diálogo.
 */
export function useDialogKeys(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const me = {}
    stack.push(me)
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || stack[stack.length - 1] !== me) return
      e.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = stack.indexOf(me)
      if (i >= 0) stack.splice(i, 1)
      if (prev?.isConnected) prev.focus({ preventScroll: true })
    }
  }, [ref])

  return useCallback((e: ReactKeyboardEvent) => {
    if (e.key === 'Tab') { trapTab(e, ref.current); return }
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onCloseRef.current()
  }, [ref])
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Prende o Tab no diálogo: no último focável volta ao primeiro; Shift+Tab no
 * primeiro (ou no próprio diálogo, onde o foco entra ao abrir) vai ao último.
 * No meio, o navegador segue sozinho. Sem isso o Shift+Tab saía para o campo do
 * chat, atrás do diálogo.
 */
function trapTab(e: ReactKeyboardEvent, box: HTMLElement | null): void {
  if (!box) return
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert]'))
  if (items.length === 0) { e.preventDefault(); return }
  const first = items[0]
  const last = items[items.length - 1]
  const at = document.activeElement
  if (e.shiftKey && (at === first || at === box || !box.contains(at))) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (at === last || !box.contains(at))) { e.preventDefault(); first.focus() }
}
