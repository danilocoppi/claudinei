import { useState } from 'react'
import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { AccessHoursEditor } from '../components/AccessHoursEditor'
import { ManageUsersModal } from '../components/ManageUsersModal'
import { useStore } from '../store'
import type { AccessHours } from '../../../shared/access-hours'
import i18n from '../i18n'

beforeAll(async () => { await i18n.changeLanguage('en') })
afterEach(() => vi.restoreAllMocks())
const policy: AccessHours = { timeZone: 'UTC', windows: [{ days: [1], start: '09:00', end: '12:00' }] }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

describe('access hours editor', () => {
  it('edits independent windows, weekdays, full days and overnight hours', () => {
    const changed = vi.fn()
    function Editor() {
      const [value, setValue] = useState<AccessHours | null>(policy)
      return <AccessHoursEditor value={value} onChange={next => { setValue(next); changed(next) }} />
    }
    render(<Editor />)
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/Sao_Paulo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add time window' }))
    const first = within(screen.getByRole('group', { name: 'Window 1' }))
    const second = within(screen.getByRole('group', { name: 'Window 2' }))
    fireEvent.click(first.getByRole('button', { name: 'Tue' }))
    fireEvent.change(first.getByLabelText('From'), { target: { value: '22:00' } })
    fireEvent.change(first.getByLabelText('Until'), { target: { value: '02:00' } })
    expect(first.getByText(/following day/)).toBeTruthy()
    fireEvent.click(second.getByLabelText('All day (24 hours)'))
    expect(changed).toHaveBeenLastCalledWith({ timeZone: 'America/Sao_Paulo', windows: [
      { days: [1, 2], start: '22:00', end: '02:00' },
      { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' },
    ] })
    fireEvent.click(second.getByRole('button', { name: 'Remove window' }))
    expect(screen.getAllByRole('group')).toHaveLength(1)
    fireEvent.click(first.getByRole('button', { name: 'Every day' }))
    expect(changed.mock.lastCall?.[0].windows[0].days).toHaveLength(7)
    fireEvent.click(screen.getByLabelText('Limited access'))
    expect(changed).toHaveBeenLastCalledWith(null)
    expect(screen.queryByLabelText('Time zone')).toBeNull()
  })

  it.each([false, true])('saves the schedule alongside the existing terminal grants (remove=%s)', async remove => {
    useStore.setState({ projects: [{ id: 3, name: 'Alfa', path: '/a' } as any] })
    const user = { id: 2, username: 'ana', isAdmin: false, projectIds: [3], accessHours: policy }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => json(init?.method === 'PATCH' ? user : [user]))
    render(<ManageUsersModal onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    if (remove) fireEvent.click(screen.getByLabelText('Limited access'))
    else fireEvent.change(screen.getByLabelText('Until'), { target: { value: '13:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const call = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(call[0]).toBe('/api/auth/users/2')
    expect(JSON.parse(call[1]!.body as string)).toEqual({ isAdmin: false, projectIds: [3], accessHours: remove ? null : {
      timeZone: 'UTC', windows: [{ days: [1], start: '09:00', end: '13:00' }],
    } })
  })

  it('rejects an empty weekday selection before sending an admin update', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([
      { id: 2, username: 'ana', isAdmin: false, projectIds: [], accessHours: policy },
    ]))
    render(<ManageUsersModal onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/select at least one weekday/)).toBeTruthy()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })
})
