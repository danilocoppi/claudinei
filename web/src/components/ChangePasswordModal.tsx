import { useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { changePassword } from '../api'

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (next !== confirm) { setError(t('auth.passwordsDontMatch')); return }
    try {
      await changePassword(current, next)
      setDone(true)
      setTimeout(onClose, 900)
    } catch (err) {
      const msg = (err as Error).message
      setError(msg === 'wrong_current_password' ? t('auth.wrongCurrentPassword') : msg)
    }
  }

  // Portal: a .sidebar tem backdrop-filter (vira containing block de
  // position:fixed) — sem portal o overlay fica preso dentro dela.
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="glass" style={{ width: 380, maxWidth: 'calc(100vw - 32px)', borderRadius: 16, padding: 20, cursor: 'default' }}
            onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 style={{ marginTop: 0 }}>{t('auth.changePassword')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{t('auth.currentPassword')}</div>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </label>
          <label>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{t('auth.newPassword')}</div>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{t('auth.confirmPassword')}</div>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          {error && <span style={{ color: 'var(--err)' }}>{error}</span>}
          {done && <span style={{ color: 'var(--ok)' }}>{t('auth.passwordChanged')}</span>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="ghost" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" disabled={!current || !next}>{t('common.save')}</button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  )
}
