import { useEffect } from 'react'
import { isForeignField } from './keyboard'
import { useStore } from './store'

/** Ctrl+U, sem Alt, Meta nem Shift (pela tecla ou pela posição, para layouts que não dão 'u'). */
export function isUsageShortcut(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.key === 'u' || e.key === 'U' || e.code === 'KeyU')
}

/**
 * Ctrl+U abre a página de uso, na mesma regra do Ctrl+Espaço: com o foco num
 * campo de texto o atalho é desse campo — inclusive o terminal, cujo xterm
 * recebe as teclas num textarea — e aqui nada acontece. Fora disso, o atalho
 * vence o "ver código-fonte" do navegador.
 */
export function useUsageShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isUsageShortcut(e) || e.isComposing) return
      if (isForeignField(e.target, null)) return
      e.preventDefault()
      useStore.getState().openUsage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
