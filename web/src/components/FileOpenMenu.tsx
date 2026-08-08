import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { copyText } from '../clipboard'
import { revealFile } from '../api'
import { isLocalHost, toFullPath, toRelativePath } from '../filePaths'

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
  const projects = useStore((s) => s.projects)

  if (!menu) return null
  const name = menu.path.split('/').pop() || menu.path
  // clamp: o menu (~200×220 com os itens de copiar) não pode nascer estourando a
  // borda da janela
  const x = Math.max(8, Math.min(menu.x, window.innerWidth - 210))
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - 240))

  // O path do chat vem ora relativo, ora absoluto: normaliza para as duas formas.
  const projectPath = projects.find((p) => p.id === menu.projectId)?.path
  const relative = toRelativePath(menu.path, projectPath)
  const full = toFullPath(menu.path, projectPath)

  const copyAndClose = (text: string) => { closeFileMenu(); void copyText(text) }

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
        <div className="sess-pop__item" onClick={() => copyAndClose(relative)} title={relative}>
          <span aria-hidden="true">🏷</span><span>{t('fileViewer.copyPath')}</span>
        </div>
        <div className="sess-pop__item" onClick={() => copyAndClose(full)} title={full}>
          <span aria-hidden="true">📋</span><span>{t('fileViewer.copyFullPath')}</span>
        </div>
        {/* Só em acesso local: o gerenciador de arquivos abre na máquina do
            SERVIDOR — de outro dispositivo, o clique não faria nada visível. */}
        {isLocalHost() && (
          <div className="sess-pop__item" onClick={() => { closeFileMenu(); void revealFile(menu.path, menu.projectId).catch(() => {}) }}>
            <span aria-hidden="true">📂</span><span>{t('fileViewer.revealInFolder')}</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
