import { useEffect } from 'react'
import { isForeignField } from './keyboard'
import { useStore } from './store'

const LATIN_LETTER = /^\p{Script=Latin}$/u

/**
 * Ctrl+U, sem Alt, Meta nem Shift. Vale a letra da tecla; a posição (`code` 'KeyU') só entra
 * quando a tecla não dá letra latina (cirílico, grego…). Num layout latino como o Dvorak,
 * a posição do U dá 'g', e Ctrl+G é do navegador (buscar o próximo), não desta página.
 */
export function isUsageShortcut(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false
  if (e.key === 'u' || e.key === 'U') return true
  return e.code === 'KeyU' && !LATIN_LETTER.test(e.key)
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
