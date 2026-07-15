import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { LOCALES } from '../i18n'

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = LOCALES.find((l) => l.code === i18n.language) ?? LOCALES[0]

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left })
    setOpen((o) => !o)
  }

  return (
    <>
      <button ref={btnRef} className="lang-switcher" title={t('lang.label')} aria-label={t('lang.label')} onClick={toggle}>
        {current.flag}
      </button>
      {open && createPortal(
        <div className="lang-menu__overlay" onClick={() => setOpen(false)}>
          <div className="lang-menu glass" style={{ top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
            {LOCALES.map((l) => (
              <div key={l.code}
                   className={`lang-menu__item ${l.code === current.code ? 'active' : ''}`}
                   onClick={() => { void i18n.changeLanguage(l.code); setOpen(false) }}>
                <span className="lang-menu__flag">{l.flag}</span>
                <span className="lang-menu__name">{l.name}</span>
                {l.code === current.code && <span className="lang-menu__check">✓</span>}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
