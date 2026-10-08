import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, error, children, confirmDisabled }: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
  error?: string
  /** Conteúdo entre a mensagem e o erro (ex.: o que será afetado e um "estou ciente"). */
  children?: ReactNode
  confirmDisabled?: boolean
}) {
  const { t } = useTranslation()
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); onClose() } }}>
      <div className="glass" style={{ width: 400, maxWidth: 'calc(100vw - 32px)', borderRadius: 16, padding: 20, cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {/* pre-line: respeita o \n de mensagens como a do link externo (URL em linha
            própria); anywhere: URL/token comprido quebra em vez de vazar do modal. */}
        <p style={{ color: 'var(--text-dim)', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{message}</p>
        {children}
        {error && <p style={{ color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button style={{ background: 'linear-gradient(135deg,#ff6b8b,#c0563b)' }} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel ?? t('common.confirm')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
