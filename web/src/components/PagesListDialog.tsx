import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { usePagesStore } from '../pages/pagesStore'
import { PageCard } from './PageCard'
import { useDialogKeys } from './undo/useDialogKeys'
import '../pages/pages.css'

/**
 * "Páginas desta conversa": todas as páginas do terminal, em ordem de criação,
 * cada uma no seu `PageCard` (lugar 'list'). É o caminho para as que ficaram
 * sem lugar na conversa (terminal interativo, turno sem texto, página antiga
 * não carregada).
 *
 * "Ver página" abre ali mesmo, como a viva: a regra de uma viva por vez é do
 * store, e a mesma página no chat continua parada. A tela cheia é a do
 * `PageFullscreenHost` do ChatView, que fica por cima deste diálogo; a nova aba,
 * a do cartão. Fechar a lista solta a viva que estava nela.
 *
 * Sem `.modal-overlay` (traz desfoque, AGENTS.md); foco, Tab e Esc pelo
 * `useDialogKeys`, como os diálogos do desfazer.
 */
export function PagesListDialog({ localId, onClose }: { localId: string; onClose(): void }) {
  const { t } = useTranslation()
  const pages = usePagesStore(s => s.byLocal[localId])
  const dialog = useRef<HTMLDivElement>(null)
  const onKeyDown = useDialogKeys(dialog, onClose)

  useEffect(() => () => {
    const { livePlace, setLive } = usePagesStore.getState()
    if (livePlace === 'list') setLive(null)
  }, [])

  const title = t('pages.listTitle')
  return createPortal(
    <div className="pages-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialog} className="pages-dialog" role="dialog" aria-modal="true" aria-label={title}
           tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="pages-dialog__head">
          <h3 className="pages-dialog__title">{title}</h3>
          <button type="button" className="ghost pages-dialog__close"
                  aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>✕</button>
        </div>
        <div className="pages-dialog__body">
          {pages && pages.length > 0
            ? pages.map(p => <PageCard key={p.id} pageId={p.id} localId={localId} page={p} place="list" />)
            : <div className="pages-dialog__empty">{t('pages.listEmpty')}</div>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
