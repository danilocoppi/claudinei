import { useEffect } from 'react'
import { fetchEngines } from './api'
import { useStore } from './store'

/** Uma aba aberta por dias também precisa receber novos modelos e seus nomes. */
export function useEngineCatalog(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let pending = false
    let attemptedAt = -Infinity
    const refresh = () => {
      if (disposed || document.hidden || pending || Date.now() - attemptedAt < 60_000) return
      attemptedAt = Date.now()
      pending = true
      void fetchEngines()
        .then((engines) => { if (!disposed) useStore.getState().setEngines(engines) })
        .catch(() => { /* Mantém o último catálogo em falhas transitórias. */ })
        .finally(() => { pending = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 5 * 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [enabled])
}
