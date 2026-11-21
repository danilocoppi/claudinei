import { onTestFinished, vi } from 'vitest'
import { useStore } from '../store'

/**
 * Faz o teste rodar "no Mac": `navigator.platform` vira 'MacIntel' e os atalhos
 * da store são resolvidos de novo pelo `setKeybindings` com as mesmas escolhas
 * (Mod passa a ser ⌘). Devolve quem desfaz: volta a plataforma e resolve outra
 * vez. O desfazer também fica registrado no `onTestFinished`, para um teste que
 * falha no meio não deixar a store resolvida como Mac; chamá-lo duas vezes não
 * faz nada a mais.
 */
export function simulateMac(): () => void {
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const reresolve = () => useStore.getState().setKeybindings(useStore.getState().keybindings.overrides)
  reresolve()
  let undone = false
  const undo = () => {
    if (undone) return
    undone = true
    platform.mockRestore()
    reresolve()
  }
  onTestFinished(undo)
  return undo
}
