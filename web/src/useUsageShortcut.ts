import { useEffect } from 'react'
import { useStore } from './store'
import { inShortcutScope, matchShortcut } from './shortcuts/active'

/**
 * O atalho do uso (`view.usage`, Mod+U por padrão) abre a página de uso, só
 * fora de campos de texto (o escopo do registro): com o foco num campo o atalho
 * é desse campo — inclusive o terminal, cujo xterm recebe as teclas num
 * textarea — e aqui nada acontece. Fora disso, o atalho vence o "ver
 * código-fonte" do navegador. Só para administrador: quem chama decide.
 */
export function useUsageShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchShortcut(e, 'view.usage')) return
      if (!inShortcutScope('view.usage', e.target, null)) return
      e.preventDefault()
      useStore.getState().openUsage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
