import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { logout } from '../api'
import { BrandMark } from './BrandMark'

export function AccessLocked() {
  const { t } = useTranslation()
  const me = useStore(s => s.me)
  const days = t('accessHours.days', { returnObjects: true }) as string[]
  return <div className="auth-screen"><section className="auth-card glass" role="status" aria-live="polite">
    <div className="auth-card__logo"><BrandMark size={22} /> Claudinei</div>
    <h1>{t('accessHours.blocked')}</h1>
    <p>{t('accessHours.blockedHint')}</p>
    {me?.accessHours && <>
      <p><strong>{t('accessHours.timeZone')}:</strong> {me.accessHours.timeZone}</p>
      <ul className="access-hours-list">{me.accessHours.windows.map((w, i) => <li key={i}>
        <strong>{w.days.length === 7 ? t('accessHours.allDays') : w.days.map(d => days[d]).join(', ')}</strong>
        {' · '}{w.start === '00:00' && w.end === '24:00' ? t('accessHours.allDay') : `${w.start}–${w.end}`}
        {w.end < w.start ? ` (${t('accessHours.nextDay')})` : ''}
      </li>)}</ul>
    </>}
    <button type="button" onClick={() => window.dispatchEvent(new Event('claudinei:check-access'))}>{t('accessHours.check')}</button>
    <button type="button" className="ghost" onClick={() => { void logout().finally(() => useStore.getState().setAuth('login', null)) }}>{t('auth.signOut')}</button>
  </section></div>
}
