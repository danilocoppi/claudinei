import { useEffect } from 'react'
import { fetchMe } from './api'
import { useStore } from './store'
import { isWithinAccessHours } from '../../shared/access-hours'

/** The server authorizes access. This gate keeps an already open UI in sync;
 * estimates use a monotonic clock so changing the computer clock cannot extend
 * the displayed window. Unlocking always requires a fresh server response.
 */
export function useAccessHours() {
  const status = useStore(s => s.authStatus)
  const userId = useStore(s => s.me?.id)
  useEffect(() => {
    if (status !== 'ready' && status !== 'locked') return
    let disposed = false, busy = false, revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: AbortController | undefined
    let requestTimeout: ReturnType<typeof setTimeout> | undefined
    let observed = performance.now()
    const restrict = () => {
      const s = useStore.getState()
      if (s.me && (s.authStatus === 'ready' || s.authStatus === 'locked')) s.setAuth('locked', s.me)
    }
    const refresh = async () => {
      if (disposed) return
      clearTimeout(timer)
      const previous = useStore.getState().me
      let delay = 30_000
      if (previous?.access && previous.accessHours) {
        const estimatedNow = previous.access.serverNow + performance.now() - observed
        if (!isWithinAccessHours(previous.accessHours, estimatedNow)) restrict()
        delay = Math.min(delay, 60_000 - estimatedNow % 60_000 + 25)
      }
      // Keep the local cutoff running even while a network request is stalled.
      timer = setTimeout(refresh, delay)
      if (busy) return
      busy = true
      const startedRevision = revision
      request = new AbortController()
      requestTimeout = setTimeout(() => request?.abort(), 10_000)
      try {
        const me = await fetchMe(request.signal)
        if (disposed || startedRevision !== revision) return
        observed = performance.now()
        useStore.getState().setAuth(me.setupRequired ? 'setup' : 'ready', me)
        if (me.access?.checkAt) delay = Math.min(delay, Math.max(100, me.access.checkAt - me.access.serverNow + 25))
      } catch (error) {
        // /me belongs to the auth routes, whose 401s are intentionally not
        // broadcast by the API helper (login handles its own errors).
        if (!disposed && (error as { status?: number }).status === 401) useStore.getState().setAuth('login', null)
      }
      finally {
        clearTimeout(requestTimeout)
        busy = false
        if (!disposed) {
          clearTimeout(timer)
          timer = setTimeout(refresh, startedRevision !== revision ? 0 : delay)
        }
      }
    }
    const denied = () => { revision++; restrict(); void refresh() }
    const visible = () => { if (!document.hidden) void refresh() }
    window.addEventListener('claudinei:access-restricted', denied)
    window.addEventListener('claudinei:check-access', refresh)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    void refresh()
    return () => {
      disposed = true; clearTimeout(timer); clearTimeout(requestTimeout); request?.abort()
      window.removeEventListener('claudinei:access-restricted', denied)
      window.removeEventListener('claudinei:check-access', refresh)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [status, userId])
}
