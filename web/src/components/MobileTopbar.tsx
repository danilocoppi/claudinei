import { useTranslation } from 'react-i18next'

/**
 * Barra superior do layout MOBILE (some no desktop via CSS): ☰ abre/fecha a
 * gaveta da sidebar e o título mostra o contexto atual (projeto ou visão).
 */
export function MobileTopbar({ open, onToggle, title }: { open: boolean; onToggle: () => void; title: string }) {
  const { t } = useTranslation()
  return (
    <div className="mobile-topbar">
      <button
        type="button"
        className="mobile-topbar__menu"
        aria-label={t('mobile.menu')}
        aria-expanded={open}
        onClick={onToggle}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
        </svg>
      </button>
      <span className="mobile-topbar__title">{title}</span>
    </div>
  )
}
