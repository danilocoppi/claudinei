import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileContentUrl, isHtmlPath } from '../files'
import { useStore } from '../store'
import { ConfirmDialog } from './ConfirmDialog'
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
  const sujo = useStore((s) => s.fileEditDirty)
  const [confirmando, setConfirmando] = useState(false)
  const [frac, setFrac] = useState(initialFrac)
  const drag = useRef<{ startY: number; startF: number; last: number } | null>(null)

  if (!inlineFile || inlineFile.localId !== localId) return null
  const { path, kind, projectId } = inlineFile
  const url = fileContentUrl(path, projectId)
  const name = path.split('/').pop() || path
  // HTML renderizado e PDF são iframes: não têm altura própria, então com só um
  // teto (max-height) o painel ficava do tamanho do iframe e arrastar a alça não
  // mudava nada na tela. Eles recebem a altura escolhida; texto e markdown
  // continuam só com teto, para um arquivo curto não abrir num painel vazio.
  const embutido = kind === 'pdf' || (kind === 'code' && isHtmlPath(name))
  const altura = `${(frac * 100).toFixed(1)}vh`

  const persist = (f: number) => {
    try { localStorage.setItem(FRAC_KEY, f.toFixed(3)) } catch { /* só não persiste */ }
  }

  // O arrasto CAPTURA o ponteiro na alça em vez de escutar a window. Escutando a
  // window, bastava o ponteiro passar por cima de um iframe (a página de um HTML,
  // um PDF) para o movimento e o "soltar" irem para o documento do iframe: o
  // painel parava de acompanhar e a página ficava presa com cursor de resize e
  // sem seleção de texto. Com a captura, tudo volta para a alça, esteja o
  // ponteiro onde estiver.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.clientY, startF: frac, last: frac }
    // feedback durante o arrasto inteiro (mesmo fora da alça) e sem selecionar texto
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // subir o ponteiro (clientY menor) = painel maior
    drag.current.last = clampFrac(drag.current.startF + (drag.current.startY - e.clientY) / window.innerHeight)
    setFrac(drag.current.last)
  }
  const encerrar = () => {
    if (!drag.current) return
    const ultimo = drag.current.last
    drag.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    persist(ultimo)
  }

  const reset = () => { setFrac(FRAC_DEFAULT); persist(FRAC_DEFAULT) }

  return (
    <div
      className={`inline-file${embutido ? ' inline-file--embed' : ''}`}
      data-testid="inline-file-view"
      style={embutido ? { height: altura } : { maxHeight: altura }}
    >
      <div
        className="inline-file__resizer"
        role="separator"
        aria-orientation="horizontal"
        title={t('fileViewer.resizeHint')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={encerrar}
        // A captura também se perde sem "soltar" (alt-tab, a janela some): sem
        // isto, a página ficaria presa no modo de arrasto até o próximo clique.
        onLostPointerCapture={encerrar}
        onDoubleClick={reset}
      />
      <div className="inline-file__header">
        <span className="inline-file__name">{name}</span>
        <span className="inline-file__path">{path}</span>
        <button
          type="button" className="ghost inline-file__close"
          aria-label={t('fileViewer.close')} title={t('fileViewer.close')}
          onClick={() => { if (sujo) setConfirmando(true); else closeFileInline() }}
        >
          ✕
        </button>
      </div>
      <div className="inline-file__body">
        <FileBody kind={kind} url={url} name={name} path={path} projectId={projectId} compact />
      </div>
      {/* Mesma proteção do popup: fechar com edição pendente descartaria o
          texto, que não vive em lugar nenhum além do editor. */}
      {confirmando && (
        <ConfirmDialog
          title={t('fileViewer.discardTitle')}
          message={t('fileViewer.discardBody')}
          confirmLabel={t('fileViewer.discard')}
          onConfirm={() => { setConfirmando(false); closeFileInline() }}
          onClose={() => setConfirmando(false)}
        />
      )}
    </div>
  )
}
