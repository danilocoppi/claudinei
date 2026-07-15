import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, error }: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
  error?: string
}) {
  const { t } = useTranslation()
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); onClose() } }}>
      <div className="glass" style={{ width: 400, maxWidth: 'calc(100vw - 32px)', borderRadius: 16, padding: 20, cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <p style={{ color: 'var(--text-dim)' }}>{message}</p>
        {error && <p style={{ color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button style={{ background: 'linear-gradient(135deg,#ff6b8b,#c0563b)' }} onClick={onConfirm}>{confirmLabel ?? t('common.confirm')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
