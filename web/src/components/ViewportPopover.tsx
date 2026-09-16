import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Ajusta o menu pelo tamanho real, inclusive depois de carregar itens assíncronos. */
export function ViewportPopover({ x, y, minWidth, children }: {
  x: number
  y: number
  minWidth: number
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = ref.current!
    const viewport = window.visualViewport
    const place = () => {
      const margin = 8
      const left = (viewport?.offsetLeft ?? 0) + margin
      const top = (viewport?.offsetTop ?? 0) + margin
      const width = Math.max(0, (viewport?.width ?? window.innerWidth) - margin * 2)
      const height = Math.max(0, (viewport?.height ?? window.innerHeight) - margin * 2)
      menu.style.minWidth = `${Math.min(minWidth, width)}px`
      menu.style.maxWidth = `${width}px`
      menu.style.maxHeight = `${height}px`
      const rect = menu.getBoundingClientRect()
      menu.style.left = `${Math.max(left, Math.min(x, left + width - rect.width))}px`
      menu.style.top = `${Math.max(top, Math.min(y, top + height - rect.height))}px`
    }

    place()
    const observer = new ResizeObserver(place)
    observer.observe(menu)
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
  }, [x, y, minWidth])

  return (
    <div ref={ref} className="sess-pop glass"
         style={{ width: 'max-content', overflowY: 'auto', overscrollBehavior: 'contain' }}
         onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}
