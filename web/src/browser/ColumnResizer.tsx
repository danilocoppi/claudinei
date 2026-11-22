import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  /** A largura em uso quando o arrasto começa. */
  width: number
  /** A largura pedida (já limitada por quem chama), a cada movimento. */
  onMove(px: number): void
  /** Soltou: a largura a gravar. */
  onCommit(px: number): void
}

/**
 * O puxador na borda esquerda da coluna da direita: arrastar para a esquerda
 * alarga. A largura acompanha cada `pointermove` (sem rAF: um setState por
 * evento) e só é gravada no `pointerup`. Fica no `window` durante o arrasto,
 * para o ponteiro poder sair da tira fina.
 */
export function ColumnResizer({ width, onMove, onCommit }: Props) {
  const { t } = useTranslation()
  const stop = useRef<(() => void) | null>(null)
  // Desmontar no meio do arrasto (trocar de terminal) não deixa ouvinte nem cursor para trás.
  useEffect(() => () => stop.current?.(), [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    let last = width
    const move = (ev: PointerEvent) => {
      last = width + startX - ev.clientX
      onMove(last)
    }
    const up = () => {
      end()
      onCommit(last)
    }
    const end = () => {
      stop.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    stop.current = end
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    // Durante o arrasto inteiro (mesmo fora da tira) e sem selecionar texto.
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div className="column-resizer" role="separator" aria-orientation="vertical"
         title={t('browser.column.resize')} onPointerDown={onPointerDown} />
  )
}
