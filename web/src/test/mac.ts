import { vi } from 'vitest'
import { useStore } from '../store'

/**
 * Faz o teste rodar "no Mac": `navigator.platform` vira 'MacIntel' e os atalhos
 * da store são resolvidos de novo (Mod passa a ser ⌘). Devolve quem desfaz: volta
 * a plataforma e resolve outra vez.
 */
export function simulateMac(): () => void {
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const reresolve = () => useStore.getState().setKeybindings(useStore.getState().keybindings.overrides)
  reresolve()
  return () => {
    platform.mockRestore()
    reresolve()
  }
}
