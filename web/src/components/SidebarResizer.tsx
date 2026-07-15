import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const KEY = 'claudinei:sidebarWidth'
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 250
const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)))

function initialWidth(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    if (Number.isFinite(v) && v > 0) return clamp(v)
  } catch { /* storage indisponível: usa o padrão */ }
  return SIDEBAR_DEFAULT
}

/**
 * Alça de redimensionar a sidebar: fica sobre a borda direita dela; clicar e
 * arrastar ajusta a largura (clamp 180–520px), duplo clique restaura o padrão.
 * A largura vai na CSS var `--sidebar-w` (raiz) — `.sidebar` lê via var() — e
 * persiste em localStorage. A Sidebar em si não sabe de nada disso.
 */
export function SidebarResizer() {
  const { t } = useTranslation()
  const [width, setWidth] = useState(initialWidth)
  const drag = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`)
  }, [width])

  const persist = (w: number) => {
    try { localStorage.setItem(KEY, String(w)) } catch { /* só não persiste */ }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    drag.current = { startX: e.clientX, startW: width }
    let last = width
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return
      last = clamp(drag.current.startW + ev.clientX - drag.current.startX)
      setWidth(last)
    }
    const onUp = () => {
      drag.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      persist(last)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // feedback durante o arrasto inteiro (mesmo fora da alça) e sem selecionar texto
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const reset = () => { setWidth(SIDEBAR_DEFAULT); persist(SIDEBAR_DEFAULT) }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      title={t('sidebar.resizeHint')}
      onMouseDown={onMouseDown}
      onDoubleClick={reset}
    />
  )
}
