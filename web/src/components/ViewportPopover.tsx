import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'

/** Ajusta o menu pelo tamanho real, inclusive depois de carregar itens assíncronos. */
export function ViewportPopover({ x, y, minWidth, children, anchorRef, placement = 'bottom', width }: {
  x: number
  y: number
  minWidth: number
  children: ReactNode
  anchorRef?: RefObject<HTMLElement>
  placement?: 'top' | 'bottom'
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = ref.current!
    const viewport = window.visualViewport
    const place = () => {
      const margin = 8
      const left = (viewport?.offsetLeft ?? 0) + margin
      const top = (viewport?.offsetTop ?? 0) + margin
      const availableWidth = Math.max(0, (viewport?.width ?? window.innerWidth) - margin * 2)
      const height = Math.max(0, (viewport?.height ?? window.innerHeight) - margin * 2)
      menu.style.minWidth = `${Math.min(minWidth, availableWidth)}px`
      menu.style.maxWidth = `${availableWidth}px`
      menu.style.width = width ? `${Math.min(width, availableWidth)}px` : 'max-content'
      menu.style.maxHeight = `${height}px`
      const rect = menu.getBoundingClientRect()
      const anchor = anchorRef?.current?.getBoundingClientRect()
      const targetX = anchor?.left ?? x
      const targetY = placement === 'top' ? (anchor?.top ?? y) - rect.height - 6 : (anchor ? anchor.bottom + 6 : y)
      menu.style.left = `${Math.max(left, Math.min(targetX, left + availableWidth - rect.width))}px`
      menu.style.top = `${Math.max(top, Math.min(targetY, top + height - rect.height))}px`
    }

    place()
    const observer = new ResizeObserver(place)
    observer.observe(menu)
    if (anchorRef?.current) observer.observe(anchorRef.current)
    window.addEventListener('resize', place)
    // A área visível também muda com zoom e com o teclado do celular.
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
    }
  }, [x, y, minWidth, anchorRef, placement, width])

  return (
    <div ref={ref} className="sess-pop glass"
         style={{ width: 'max-content', overflowY: 'auto', overscrollBehavior: 'contain' }}
         onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}
