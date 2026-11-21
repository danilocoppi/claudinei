/**
 * Reconcilia as preferências com o servidor depois do login: a aparência e os
 * atalhos. Se ele discordar do cache, ele vence; se estiver fora do ar ou for
 * antigo (sem `keybindings`), fica o que havia (o cache ou os padrões), sem erro.
 */
import { fetchPrefs } from './api'
import { useStore } from './store'

export async function syncPrefs(): Promise<void> {
  try {
    const r = await fetchPrefs()
    const store = useStore.getState()
    // Como sempre foi: a aparência do servidor vale, saneada (ausente vira o padrão).
    store.applyAppearance(r.appearance)
    const kb: unknown = r.keybindings
    if (kb && typeof kb === 'object' && !Array.isArray(kb)) store.setKeybindings(r.keybindings)
  } catch {
    // Rede fora ou resposta estranha: os atalhos seguem os do cache.
  }
}
