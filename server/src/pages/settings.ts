import type { SettingsService } from '../settings.js'
import type { PageNetwork } from '../../../shared/visual-pages.js'

/** Chave global (kv `settings`) da rede liberada às páginas visuais. */
export const PAGE_NETWORK_KEY = 'visualPagesNetwork'

/**
 * A rede das páginas, lida do banco a cada chamada. Só `'open'` libera; o
 * resto (ausente, vazio, valor desconhecido) vale `'cdn'`, o padrão fechado.
 */
export function readNetwork(settings: Pick<SettingsService, 'get'>): PageNetwork {
  return settings.get(PAGE_NETWORK_KEY) === 'open' ? 'open' : 'cdn'
}
