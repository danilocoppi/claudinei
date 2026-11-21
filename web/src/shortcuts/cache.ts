/**
 * Cache dos atalhos em localStorage, no molde do `cacheAppearance`: as escolhas
 * valem desde a primeira tecla, antes de o `GET /api/prefs` responder. Guarda as
 * escolhas (`overrides`), não o resolvido: quem resolve é a store, com o sistema
 * e o administrador do momento.
 */
import type { Overrides } from './resolve'

export const KEYBINDINGS_CACHE_KEY = 'claudinei:keybindings'

export function cacheKeybindings(o: Overrides): void {
  try { localStorage.setItem(KEYBINDINGS_CACHE_KEY, JSON.stringify(o)) } catch { /* só não adianta a primeira carga */ }
}

/** As escolhas guardadas; ausente, corrompido ou fora da forma vale `{}`. */
export function readCachedKeybindings(): Overrides {
  try {
    const raw = localStorage.getItem(KEYBINDINGS_CACHE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Overrides = {}
    for (const [id, v] of Object.entries(parsed)) {
      if (v === null || typeof v === 'string') out[id] = v
    }
    return out
  } catch {
    return {}
  }
}
