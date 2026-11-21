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
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onCloseRef.current()
  }, [])
}
