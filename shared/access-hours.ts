/** Weekdays follow Date: Sunday = 0. Overnight windows belong to their start day. */
export interface AccessWindow { days: number[]; start: string; end: string }
export interface AccessHours { timeZone: string; windows: AccessWindow[] }
export interface AccessStatus { allowed: boolean; serverNow: number; checkAt: number | null }

const minuteOf = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const formatters = new Map<string, Intl.DateTimeFormat>()
const formatter = (timeZone: string) => {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    if (formatters.size >= 64) formatters.clear()
    formatters.set(timeZone, f)
  }
  return f
}

export function validateAccessHours(value: unknown): AccessHours | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_access_hours')
  const { timeZone, windows } = value as Partial<AccessHours>
  if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error('invalid_access_timezone')
  try { formatter(timeZone) } catch { throw new Error('invalid_access_timezone') }
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > 64) throw new Error('invalid_access_windows')
  return { timeZone, windows: windows.map(w => {
    if (!w || typeof w !== 'object' || !Array.isArray(w.days) || w.days.length < 1 || w.days.length > 7 ||
        w.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('invalid_access_days')
    if (typeof w.start !== 'string' || typeof w.end !== 'string' || !clockTime.test(w.start) ||
        (!clockTime.test(w.end) && w.end !== '24:00') || w.start === w.end) throw new Error('invalid_access_time')
    return { days: [...new Set(w.days)].sort(), start: w.start, end: w.end }
  }) }
}

export function isWithinAccessHours(hours: AccessHours | null | undefined, now: number): boolean {
  if (!hours) return true
  const parts = formatter(hours.timeZone).formatToParts(now)
  const part = (type: string) => parts.find(p => p.type === type)!.value
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'))
  const minute = Number(part('hour')) * 60 + Number(part('minute'))
  return hours.windows.some(w => {
    const start = minuteOf(w.start), end = minuteOf(w.end)
    return end > start
      ? w.days.includes(day) && minute >= start && minute < end
      : (w.days.includes(day) && minute >= start) || (w.days.includes((day + 6) % 7) && minute < end)
  })
}

export function accessStatus(hours: AccessHours | null | undefined, now: number): AccessStatus {
  return { allowed: isWithinAccessHours(hours, now), serverNow: now, checkAt: hours ? (Math.floor(now / 60_000) + 1) * 60_000 : null }
}
