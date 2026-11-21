import { useEffect } from 'react'
import { useStore } from './store'
import { inShortcutScope, matchShortcut } from './shortcuts/active'

/**
 * O atalho do Zen (`view.zen`, Alt+Z por padrão) liga e desliga o modo. Vale
 * também com o foco no campo do chat — é de lá que se escreve no Zen —, mas não
 * no terminal interativo, onde a tecla é do shell ou do programa que roda nele
 * (o escopo do registro). Tecla que alguém já tratou (`defaultPrevented`) não é
 * do Zen.
 */
export function useZenShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !matchShortcut(e, 'view.zen')) return
      if (!inShortcutScope('view.zen', e.target, null)) return
      e.preventDefault()
      // Tecla segurada: só o primeiro aperto conta, senão o modo pisca.
      if (e.repeat) return
      useStore.getState().toggleZen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
