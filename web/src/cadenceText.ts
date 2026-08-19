import type { Cadence } from './api'

type T = (key: string, opts?: Record<string, unknown>) => string

/**
 * A cadência em uma frase. Fica no FRONT, e não no servidor, porque é texto de
 * interface e precisa dos três idiomas — o servidor só devolve os horários das
 * próximas execuções, que não têm idioma.
 */
export function describeCadence(c: Cadence, t: T): string {
  const days = (list?: number[]) =>
    list?.length ? list.map((d) => t(`schedules.weekday.d${d}` as 'schedules.weekday.d0')).join(', ') : ''

  switch (c.kind) {
    case 'every': {
      const parts = [t(`schedules.everyUnit.${c.unit}` as 'schedules.everyUnit.minutes', { n: c.n })]
      if (c.weekdays?.length) parts.push(days(c.weekdays))
      if (c.from && c.to) parts.push(t('schedules.between', { from: c.from, to: c.to }))
      return parts.join(' · ')
    }
    case 'daily':
      return [t('schedules.daily', { at: c.at }), days(c.weekdays)].filter(Boolean).join(' · ')
    case 'weekly':
      return t('schedules.weekly', { days: days(c.weekdays), at: c.at })
    case 'monthly':
      return t('schedules.monthly', { day: c.day, at: c.at })
    case 'cron':
      return t('schedules.cron', { expr: c.expr })
  }
}

/** Cadência inicial de cada modo, para o seletor trocar a frase sem perder o que dá. */
export function defaultCadence(kind: Cadence['kind'], prev?: Cadence): Cadence {
  const at = prev && 'at' in prev ? prev.at : '09:00'
  switch (kind) {
    case 'every': return { kind: 'every', n: 15, unit: 'minutes' }
    case 'daily': return { kind: 'daily', at }
    case 'weekly': return { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], at }
    case 'monthly': return { kind: 'monthly', day: 1, at }
    case 'cron': return { kind: 'cron', expr: '0 9 * * *' }
  }
}
