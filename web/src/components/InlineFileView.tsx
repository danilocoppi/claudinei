import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileContentUrl } from '../files'
import { useStore } from '../store'
import { FileBody } from './FileViewerModal'

// Altura do painel como PROPORÇÃO da janela (persiste entre inlines e reloads).
const FRAC_KEY = 'claudinei:inlineFileFrac'
const FRAC_DEFAULT = 0.42
const clampFrac = (f: number) => Math.min(0.8, Math.max(0.15, f))
const initialFrac = (): number => {
  try {
    const v = Number(localStorage.getItem(FRAC_KEY))
    if (Number.isFinite(v) && v > 0) return clampFrac(v)
  } catch { /* storage indisponível: usa o padrão */ }
  return FRAC_DEFAULT
}

/**
 * Painel de arquivo INLINE: dockado entre o chat e o input, fica visível
 * enquanto o operador continua mandando comandos (diferente do popup, que
 * cobre tudo). Escopado por sessão — trocar de terminal esconde, voltar
 * mostra de novo; o ✕ fecha de vez.
 *
 * A borda de cima é uma alça (mesmo padrão do SidebarResizer): arrastar pra
 * cima expande, pra baixo encolhe; duplo clique restaura; a proporção fica no
 * localStorage e vale para os próximos inlines.
 */
export function InlineFileView({ localId }: { localId: string }) {
  const { t } = useTranslation()
  const inlineFile = useStore((s) => s.inlineFile)
  const closeFileInline = useStore((s) => s.closeFileInline)
  const [frac, setFrac] = useState(initialFrac)
  const drag = useRef<{ startY: number; startF: number } | null>(null)

  if (!inlineFile || inlineFile.localId !== localId) return null
  const { path, kind, projectId } = inlineFile
  const url = fileContentUrl(path, projectId)
  const name = path.split('/').pop() || path

  const persist = (f: number) => {
    try { localStorage.setItem(FRAC_KEY, f.toFixed(3)) } catch { /* só não persiste */ }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    drag.current = { startY: e.clientY, startF: frac }
    let last = frac
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return
      // subir o mouse (clientY menor) = painel maior
      last = clampFrac(drag.current.startF + (drag.current.startY - ev.clientY) / window.innerHeight)
      setFrac(last)
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
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const reset = () => { setFrac(FRAC_DEFAULT); persist(FRAC_DEFAULT) }

  return (
    <div className="inline-file" data-testid="inline-file-view" style={{ maxHeight: `${(frac * 100).toFixed(1)}vh` }}>
      <div
        className="inline-file__resizer"
        role="separator"
        aria-orientation="horizontal"
        title={t('fileViewer.resizeHint')}
        onMouseDown={onMouseDown}
        onDoubleClick={reset}
      />
      <div className="inline-file__header">
        <span className="inline-file__name">{name}</span>
        <span className="inline-file__path">{path}</span>
        <button
          type="button" className="ghost inline-file__close"
          aria-label={t('fileViewer.close')} title={t('fileViewer.close')}
          onClick={closeFileInline}
        >
          ✕
        </button>
      </div>
      <div className="inline-file__body">
        <FileBody kind={kind} url={url} name={name} compact />
      </div>
    </div>
  )
}
