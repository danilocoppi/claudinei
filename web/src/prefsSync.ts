/**
 * Reconcilia as preferências com o servidor depois do login: a aparência e os
 * atalhos. Se ele discordar do cache, ele vence; se estiver fora do ar ou for
 * antigo (sem `keybindings`), fica o que havia (o cache ou os padrões), sem erro.
 */
import { fetchPrefs, type PrefsResponse } from './api'
import { useStore } from './store'

export async function syncPrefs(): Promise<void> {
  let r: PrefsResponse
  try {
    r = await fetchPrefs()
  } catch {
    // Rede fora ou erro HTTP: a aparência e os atalhos seguem os do cache. Só a
    // busca fica no try; um erro ao aplicar a resposta é defeito e aparece.
    return
  }
  const store = useStore.getState()
  // Como sempre foi: a aparência do servidor vale, saneada (ausente vira o padrão).
  store.applyAppearance(r.appearance)
  const kb: unknown = r.keybindings
  if (kb && typeof kb === 'object' && !Array.isArray(kb)) store.setKeybindings(r.keybindings)
}
