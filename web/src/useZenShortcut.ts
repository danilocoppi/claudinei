import { useEffect } from 'react'
import { isTerminalTarget } from './keyboard'
import { useStore } from './store'

const LATIN_LETTER = /^\p{Script=Latin}$/u
const LETTER = /^\p{L}$/u

/**
 * Alt+Z, sem Ctrl, Meta nem Shift. Vale a letra da tecla; a posição (`code` 'KeyZ')
 * só entra quando a tecla dá uma letra de outro alfabeto — no macOS, Option+Z
 * escreve 'Ω', e no cirílico a mesma tecla dá 'я'. Pontuação não conta: no Dvorak
 * a posição do Z dá ';', e Alt+; não é este atalho.
 */
export function isZenShortcut(e: KeyboardEvent): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
  if (e.key === 'z' || e.key === 'Z') return true
  return e.code === 'KeyZ' && LETTER.test(e.key) && !LATIN_LETTER.test(e.key)
}

/**
 * Alt+Z liga e desliga o modo Zen. Vale também com o foco no campo do chat — é
 * de lá que se escreve no Zen —, mas não no terminal interativo, onde Alt+Z é
 * do shell ou do programa que roda nele.
 */
export function useZenShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isZenShortcut(e) || e.isComposing) return
      if (isTerminalTarget(e.target)) return
      e.preventDefault()
      useStore.getState().toggleZen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
