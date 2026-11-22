import { useEffect } from 'react'
import { inShortcutScope, matchShortcut } from '../shortcuts/active'
import { activeTerminal, toggleBrowserView } from './columnStore'

/**
 * O atalho do Navegador (`view.browser`, Alt+B por padrão) abre e fecha a vista
 * Navegador do terminal do chat à vista, como o botão do cabeçalho. Vale no
 * campo do chat e fora dele, mas não no terminal interativo, onde a tecla é do
 * shell (o escopo do registro). Tecla que alguém já tratou (`defaultPrevented`)
 * não é dele; sem chat à vista, a tecla segue para a página.
 */
export function useBrowserShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !matchShortcut(e, 'view.browser')) return
      if (!inShortcutScope('view.browser', e.target, null)) return
      const target = activeTerminal()
      if (!target) return
      e.preventDefault()
      // Tecla segurada: só o primeiro aperto conta, senão a vista pisca.
      if (e.repeat) return
      void toggleBrowserView(target.projectId, target.engine)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
