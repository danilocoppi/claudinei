import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { AccessHours, AccessWindow } from '../../../shared/access-hours'

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
export const defaultAccessHours = (): AccessHours => ({
  timeZone: 'America/Sao_Paulo', windows: [{ days: [...ALL_DAYS], start: '09:00', end: '18:00' }],
})
export function AccessHoursEditor({ value, onChange }: { value: AccessHours | null; onChange: (value: AccessHours | null) => void }) {
  const { t } = useTranslation()
  const zones = useId()
  const days = t('accessHours.days', { returnObjects: true }) as string[]
  const update = (index: number, patch: Partial<AccessWindow>) => {
    if (value) onChange({ ...value, windows: value.windows.map((w, i) => i === index ? { ...w, ...patch } : w) })
  }
  return <section className="access-hours-editor">
    <label className="users-form__check"><input type="checkbox" checked={!!value}
      onChange={e => onChange(e.target.checked ? defaultAccessHours() : null)} />{t('accessHours.limited')}</label>
    {value && <>
      <p className="access-hours-hint">{t('accessHours.hint')}</p>
      <label>{t('accessHours.timeZone')}<input list={zones} value={value.timeZone}
        onChange={e => onChange({ ...value, timeZone: e.target.value })} /></label>
      <datalist id={zones}>{['America/Sao_Paulo', 'America/Manaus', 'America/Recife', 'Europe/Berlin', 'Europe/Lisbon', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist>
      {value.windows.map((w, index) => {
        const allDay = w.start === '00:00' && w.end === '24:00'
        return <fieldset key={index} className="access-window">
          <legend>{t('accessHours.window', { n: index + 1 })}</legend>
          <div className="access-days">
            {DAY_ORDER.map(day => <button type="button" key={day} aria-pressed={w.days.includes(day)}
              onClick={() => update(index, { days: w.days.includes(day) ? w.days.filter(d => d !== day) : [...w.days, day] })}>{days[day]}</button>)}
            <button type="button" onClick={() => update(index, { days: [...ALL_DAYS] })}>{t('accessHours.allDays')}</button>
          </div>
          <label className="users-form__check"><input type="checkbox" checked={allDay}
            onChange={e => update(index, e.target.checked ? { start: '00:00', end: '24:00' } : { start: '09:00', end: '18:00' })} />{t('accessHours.allDay')}</label>
          {!allDay && <div className="access-times">
            <label>{t('accessHours.start')}<input type="time" step="60" value={w.start} onChange={e => update(index, { start: e.target.value })} /></label>
            <label>{t('accessHours.end')}<input type="time" step="60" value={w.end === '24:00' ? '00:00' : w.end} onChange={e => update(index, { end: e.target.value })} /></label>
          </div>}
          {!allDay && w.end < w.start && <p className="access-hours-hint">{t('accessHours.overnight')}</p>}
          <button type="button" className="ghost" disabled={value.windows.length === 1}
            onClick={() => onChange({ ...value, windows: value.windows.filter((_, i) => i !== index) })}>{t('accessHours.removeWindow')}</button>
        </fieldset>
      })}
      <button type="button" className="ghost" disabled={value.windows.length >= 64}
        onClick={() => onChange({ ...value, windows: [...value.windows, { days: [...ALL_DAYS], start: '09:00', end: '18:00' }] })}>{t('accessHours.addWindow')}</button>
    </>}
  </section>
}
