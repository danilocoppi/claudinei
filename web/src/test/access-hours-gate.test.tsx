import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import { useAccessHours } from '../useAccessHours'
import { AccessLocked } from '../components/AccessLocked'
import { useStore } from '../store'
import { saveRuns, RUN_KEY } from '../actionRun'
import { accessStatus } from '../../../shared/access-hours'
import type { Me } from '../api'
import i18n from '../i18n'

const start = Date.parse('2026-09-07T09:59:59Z')
const policy = { timeZone: 'UTC', windows: [{ days: [1], start: '09:00', end: '10:00' }] }
const meAt = (now: number): Me => ({ setupRequired: false, id: 2, username: 'ana', accessHours: policy, access: accessStatus(policy, now) })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function Gate() {
  useAccessHours()
  const status = useStore(s => s.authStatus)
  return status === 'locked' ? <AccessLocked /> : status === 'ready' ? <button>Run action</button> : <span>Sign in</span>
}
beforeAll(async () => { await i18n.changeLanguage('en') })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); vi.setSystemTime(start)
  useStore.setState({ authStatus: 'loading', me: null, projects: [], sessions: {}, chat: {}, actionRuns: [] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.removeItem(RUN_KEY) })
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('live access gate', () => {
  it('clears active terminals, chat and saved action windows on login outside the schedule', () => {
    saveRuns([{ actionId: 3, name: 'Deployment', autoClose: false }])
    useStore.setState({ activeLocalId: 'active', view: 'terminal', chat: { active: [{ text: 'private' }] as any },
      actionRuns: [{ actionId: 3, name: 'Deployment', autoClose: false }] })
    useStore.getState().setAuth('ready', meAt(start + 1000))
    expect(useStore.getState()).toMatchObject({ authStatus: 'locked', activeLocalId: undefined, chat: {}, actionRuns: [] })
    expect(localStorage.getItem(RUN_KEY)).toBeNull()
    useStore.getState().setAuth('ready', meAt(start))
    expect(useStore.getState().actionRuns).toEqual([])
  })

  it('locks at the boundary with a failed network, and unlocks only with a fresh server permission', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(meAt(Date.now())))
    useStore.getState().setAuth('ready', meAt(start))
    render(<Gate />); await flush()
    expect(screen.getByRole('button', { name: 'Run action' })).toBeTruthy()
    fetch.mockRejectedValue(new Error('offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1050) })
    expect(screen.queryByRole('button', { name: 'Run action' })).toBeNull()
    expect(screen.getByText('Outside your access hours')).toBeTruthy()
    expect(screen.getByText('UTC')).toBeTruthy()
    vi.setSystemTime(Date.parse('2026-09-14T09:00:00Z'))
    await act(async () => { window.dispatchEvent(new Event('focus')) }); await flush()
    expect(useStore.getState().authStatus).toBe('locked')
    fetch.mockResolvedValue(response(meAt(Date.now())))
    await act(async () => { window.dispatchEvent(new Event('claudinei:check-access')) }); await flush()
    expect(useStore.getState().authStatus).toBe('ready')
  })

  it('locks at the boundary even while /me never returns', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    useStore.getState().setAuth('ready', meAt(start))
    render(<Gate />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1050) })
    expect(screen.queryByRole('button', { name: 'Run action' })).toBeNull()
    expect(screen.getByText('Outside your access hours')).toBeTruthy()
  })

  it('does not let a delayed allowed response undo a newer server denial', async () => {
    let resolve!: (value: Response) => void
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(r => { resolve = r }))
      .mockImplementation(async () => response(meAt(start + 1000)))
    useStore.getState().setAuth('ready', meAt(start))
    render(<Gate />)
    await act(async () => { window.dispatchEvent(new Event('claudinei:access-restricted')) })
    await act(async () => { resolve(response(meAt(start))) }); await flush()
    expect(useStore.getState().authStatus).toBe('locked')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('handles policy additions/removal via focus and stops polling when unmounted', async () => {
    const unlimited = { ...meAt(start), accessHours: null, access: accessStatus(null, start) }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(unlimited))
    useStore.getState().setAuth('ready', unlimited)
    const mounted = render(<Gate />); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000) })
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockImplementation(async () => response(meAt(start + 1000)))
    await act(async () => { window.dispatchEvent(new Event('focus')) }); await flush()
    expect(useStore.getState().authStatus).toBe('locked')
    fetch.mockImplementation(async () => response(unlimited))
    await act(async () => { window.dispatchEvent(new Event('claudinei:check-access')) }); await flush()
    expect(useStore.getState().authStatus).toBe('ready')
    mounted.unmount(); const calls = fetch.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); window.dispatchEvent(new Event('focus')) })
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('returns an expired login to the login screen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: 'unauthorized' }, 401))
    useStore.getState().setAuth('ready', meAt(start)); render(<Gate />); await flush()
    expect(useStore.getState()).toMatchObject({ authStatus: 'login', me: null })
  })
})
