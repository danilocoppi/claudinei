import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessStatus, isWithinAccessHours, validateAccessHours, type AccessHours } from '../../shared/access-hours.js'
import { openDb } from '../src/db.js'
import { createUsersService } from '../src/auth/users.js'

const hours: AccessHours = { timeZone: 'America/Sao_Paulo', windows: [
  { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
] }
const allowed = (policy: AccessHours | null, date: string) => isWithinAccessHours(policy, Date.parse(date))

describe('weekly access hours', () => {
  it.each([
    ['2026-09-07T11:59:59.999Z', false], ['2026-09-07T12:00:00Z', true],
    ['2026-09-07T14:59:59.999Z', true], ['2026-09-07T15:00:00Z', false],
    ['2026-09-07T17:00:00Z', true], ['2026-09-07T21:00:00Z', false],
    ['2026-09-06T12:00:00Z', false],
  ])('uses the policy timezone and half-open intervals: %s', (date, expected) => expect(allowed(hours, date)).toBe(expected))

  it('handles overnight windows and the Saturday/Sunday boundary', () => {
    const overnight = { timeZone: 'UTC', windows: [{ days: [6], start: '22:00', end: '02:00' }] }
    expect(allowed(overnight, '2026-09-05T21:59:59Z')).toBe(false)
    expect(allowed(overnight, '2026-09-05T22:00:00Z')).toBe(true)
    expect(allowed(overnight, '2026-09-06T01:59:59Z')).toBe(true)
    expect(allowed(overnight, '2026-09-06T02:00:00Z')).toBe(false)
    expect(allowed(overnight, '2026-09-07T01:00:00Z')).toBe(false)
  })

  it('supports full days, every day, and overlapping windows', () => {
    const allDay = { timeZone: 'UTC', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] }
    for (let d = 6; d <= 12; d++) expect(allowed(allDay, `2026-09-${String(d).padStart(2, '0')}T23:59:59Z`)).toBe(true)
    expect(allowed({ ...hours, windows: [...hours.windows, { days: [1], start: '11:00', end: '15:00' }] }, '2026-09-07T16:00:00Z')).toBe(true)
    expect(accessStatus(null, 1234)).toEqual({ allowed: true, serverNow: 1234, checkAt: null })
  })

  it('uses civil time through DST skips and repeated hours', () => {
    const dst = { timeZone: 'Europe/Berlin', windows: [{ days: [0], start: '02:00', end: '03:00' }] }
    expect(allowed(dst, '2026-03-29T01:00:00Z')).toBe(false) // 03:00, 02:00 did not occur
    expect(allowed(dst, '2026-10-25T00:30:00Z')).toBe(true) // first 02:30
    expect(allowed(dst, '2026-10-25T01:30:00Z')).toBe(true) // second 02:30
    expect(allowed(dst, '2026-10-25T02:00:00Z')).toBe(false)
  })

  it.each([
    {}, false, [], { ...hours, timeZone: 'not/a-zone' }, { ...hours, windows: [] },
    ...[{ days: [], start: '09:00', end: '18:00' }, { days: [7], start: '09:00', end: '18:00' },
      { days: ['1'], start: '09:00', end: '18:00' }, { days: [1], start: '9:00', end: '18:00' },
      { days: [1], start: '24:00', end: '18:00' }, { days: [1], start: '09:00', end: '09:00' },
      { days: [1], start: '09:00', end: '18:60' }].map(w => ({ ...hours, windows: [w] })),
  ])('rejects invalid policy %#', value => expect(() => validateAccessHours(value)).toThrow(/invalid_access_/))
})

describe('persistence and atomic updates', () => {
  it('migrates existing users as unrestricted and persists policy across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-migration-')), path = join(dir, 'test.db')
    let db = openDb(path)
    try {
      const id = createUsersService(db).create({ username: 'existing', password: 'password1' }).id
      db.exec('ALTER TABLE users DROP COLUMN access_hours'); db.close(); db = openDb(path)
      expect(createUsersService(db).get(id)?.accessHours).toBeNull()
      createUsersService(db).update(id, { accessHours: hours }); db.close(); db = openDb(path)
      expect(createUsersService(db).get(id)?.accessHours).toEqual(hours)
      createUsersService(db).update(id, { accessHours: null })
      expect(createUsersService(db).access(id).allowed).toBe(true)
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not partially change credentials or policy after a failed update', () => {
    const db = openDb(':memory:')
    try {
      const users = createUsersService(db), user = users.create({ username: 'user', password: 'password1', accessHours: hours })
      const before = users.getByUsername('user')
      expect(() => users.update(user.id, { password: 'password2', accessHours: null, projectIds: [999] })).toThrow()
      expect(users.getByUsername('user')).toEqual(before)
      expect(users.get(user.id)?.accessHours).toEqual(hours)
      expect(() => users.create({ username: 'failed', password: 'password1', projectIds: [999] })).toThrow()
      expect(users.getByUsername('failed')).toBeUndefined()
    } finally { db.close() }
  })
})
