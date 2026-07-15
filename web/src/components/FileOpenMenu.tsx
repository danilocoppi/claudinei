import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'

/**
 * Menu de contexto do link de arquivo: escolher entre abrir no POPUP
 * (FileViewerModal, como sempre) ou INLINE (painel dockado acima do input do
 * chat, que deixa continuar conversando com a engine enquanto lê).
 * Montado uma única vez (App.tsx); inerte sem `store.fileMenu`.
 */
export function FileOpenMenu() {
  const { t } = useTranslation()
  const menu = useStore((s) => s.fileMenu)
  const closeFileMenu = useStore((s) => s.closeFileMenu)
  const openFile = useStore((s) => s.openFile)
  const openFileInline = useStore((s) => s.openFileInline)

  if (!menu) return null
  const name = menu.path.split('/').pop() || menu.path
  // clamp: o menu (~200×110) não pode nascer estourando a borda da janela
  const x = Math.max(8, Math.min(menu.x, window.innerWidth - 210))
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - 120))

  return createPortal(
    <div className="sess-pop__overlay" onClick={() => closeFileMenu()}>
      <div className="sess-pop glass" style={{ left: x, top: y, minWidth: 200 }} onClick={(e) => e.stopPropagation()}>
        <div className="sess-pop__eyebrow" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div className="sess-pop__item" onClick={() => { closeFileMenu(); openFile(menu.path, menu.kind, menu.projectId) }}>
          <span aria-hidden="true">🗗</span><span>{t('fileViewer.openPopup')}</span>
        </div>
        {menu.localId && (
          <div className="sess-pop__item" onClick={() => { closeFileMenu(); openFileInline(menu.localId!, menu.path, menu.kind, menu.projectId) }}>
            <span aria-hidden="true">📎</span><span>{t('fileViewer.openInline')}</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
