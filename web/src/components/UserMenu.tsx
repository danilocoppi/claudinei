import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { logout } from '../api'
import { ChangePasswordModal } from './ChangePasswordModal'
import { ManageUsersModal } from './ManageUsersModal'

/** Menu 👤 ao lado do logo: instalar o app (quando o navegador oferece),
 *  trocar senha, gerenciar usuários (admin) e sair. */
export function UserMenu() {
  const { t } = useTranslation()
  const me = useStore((s) => s.me)
  const setAuth = useStore((s) => s.setAuth)
  const installPrompt = useStore((s) => s.installPrompt)
  const clearInstallPrompt = useStore((s) => s.clearInstallPrompt)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [modal, setModal] = useState<'password' | 'users' | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!me?.username) return null // auth desativada (pré-setup): sem menu

  const isAdmin = me.isAdmin !== false

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left })
    setOpen((o) => !o)
  }

  const signOut = async () => {
    setOpen(false)
    try { await logout() } catch { /* cookie some de qualquer jeito */ }
    setAuth('login', null)
  }

  // Instalar app (PWA): o item só existe quando o navegador ofereceu a instalação
  // (beforeinstallprompt, capturado no main.tsx). O evento é de uso único: limpa
  // depois — se o usuário recusar, o navegador reoferece mais tarde.
  const installApp = async () => {
    setOpen(false)
    if (!installPrompt) return
    try {
      await installPrompt.prompt()
      await installPrompt.userChoice
    } finally {
      clearInstallPrompt()
    }
  }

  return (
    <>
      <button ref={btnRef} className="user-menu__btn" title={me.username} onClick={toggle}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
        </svg>
        <span className="user-menu__name">{me.username}</span>
      </button>
      {open && createPortal(
        <div className="user-menu__overlay" onClick={() => setOpen(false)}>
          <div className="user-menu__popover glass" style={{ top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
            {installPrompt && (
              <>
                <div className="user-menu__item" onClick={() => void installApp()}>⬇ {t('pwa.install')}</div>
                <div className="user-menu__sep" role="separator" />
              </>
            )}
            <div className="user-menu__item" onClick={() => { setModal('password'); setOpen(false) }}>{t('auth.changePassword')}</div>
            {isAdmin && <div className="user-menu__item" onClick={() => { setModal('users'); setOpen(false) }}>{t('auth.manageUsers')}</div>}
            <div className="user-menu__item" onClick={() => void signOut()}>{t('auth.signOut')}</div>
          </div>
        </div>,
        document.body,
      )}
      {modal === 'password' && <ChangePasswordModal onClose={() => setModal(null)} />}
      {modal === 'users' && <ManageUsersModal onClose={() => setModal(null)} />}
    </>
  )
}
