import { describe, it, expect, afterEach, vi } from 'vitest'
import { useStore } from '../store'
import { KEYBINDINGS_CACHE_KEY, readCachedKeybindings } from '../shortcuts/cache'
import { matchShortcut, shortcutCombo } from '../shortcuts/active'
import { syncPrefs } from '../prefsSync'
import { DEFAULT_APPEARANCE } from '../appearance'
import { simulateMac } from './mac'

/**
 * Os atalhos na store: o estado resolvido, o cache em localStorage, a troca de
 * usuário (administrador ou não) e a sincronia com o servidor.
 */
const tecla = (mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>, key: string, code: string) =>
  ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  useStore.getState().setAuth('loading', null)
  useStore.getState().setKeybindings({})
})

describe('atalhos na store', () => {
  it('começa com os padrões', () => {
    expect(useStore.getState().keybindings.resolved['view.zen']).toBe('Alt+Z')
    expect(useStore.getState().keybindings.overrides).toEqual({})
  })

  it('setKeybindings resolve, grava o cache e matchShortcut usa a combinação nova', () => {
    useStore.getState().setKeybindings({ 'view.zen': 'Alt+M' })
    expect(useStore.getState().keybindings.resolved['view.zen']).toBe('Alt+M')
    expect(shortcutCombo('view.zen')).toBe('Alt+M')
    expect(matchShortcut(tecla({ altKey: true }, 'm', 'KeyM'), 'view.zen')).toBe(true)
    expect(matchShortcut(tecla({ altKey: true }, 'z', 'KeyZ'), 'view.zen')).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_CACHE_KEY)!)).toEqual({ 'view.zen': 'Alt+M' })
    expect(readCachedKeybindings()).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('cache corrompido vale {}', () => {
    localStorage.setItem(KEYBINDINGS_CACHE_KEY, '{')
    expect(readCachedKeybindings()).toEqual({})
    localStorage.setItem(KEYBINDINGS_CACHE_KEY, '[1,2]')
    expect(readCachedKeybindings()).toEqual({})
    localStorage.removeItem(KEYBINDINGS_CACHE_KEY)
    expect(readCachedKeybindings()).toEqual({})
  })

  it('sem atalho, matchShortcut é sempre false', () => {
    useStore.getState().setKeybindings({ 'view.zen': null })
    expect(shortcutCombo('view.zen')).toBeNull()
    expect(matchShortcut(tecla({ altKey: true }, 'z', 'KeyZ'), 'view.zen')).toBe(false)
  })

  it('setAuth com não administrador tira o uso; administrador devolve', () => {
    expect(useStore.getState().keybindings.resolved['view.usage']).toBe('Mod+U')
    useStore.getState().setAuth('ready', { setupRequired: false, id: 2, username: 'ana', isAdmin: false })
    expect(useStore.getState().keybindings.resolved['view.usage']).toBeNull()
    expect(matchShortcut(tecla({ ctrlKey: true }, 'u', 'KeyU'), 'view.usage')).toBe(false)
    // As escolhas seguem as mesmas: só o resolvido muda.
    useStore.getState().setKeybindings({ 'view.zen': 'Alt+M' })
    expect(useStore.getState().keybindings.resolved['view.usage']).toBeNull()
    useStore.getState().setAuth('ready', { setupRequired: false, id: 1, username: 'root', isAdmin: true })
    expect(useStore.getState().keybindings.resolved['view.usage']).toBe('Mod+U')
    expect(useStore.getState().keybindings.resolved['view.zen']).toBe('Alt+M')
  })

  it('syncPrefs leva os atalhos do servidor para a store', async () => {
    const fetchSpy = vi.fn(async () => json({ appearance: DEFAULT_APPEARANCE, keybindings: { 'view.zen': 'Alt+M' } }))
    vi.stubGlobal('fetch', fetchSpy)
    await syncPrefs()
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe('/api/prefs')
    expect(useStore.getState().keybindings.resolved['view.zen']).toBe('Alt+M')
    expect(readCachedKeybindings()).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('servidor sem keybindings ou fora do ar: fica o que havia', async () => {
    useStore.getState().setKeybindings({ 'view.zen': 'Alt+M' })
    // Servidor antigo: só a aparência.
    vi.stubGlobal('fetch', vi.fn(async () => json({ appearance: DEFAULT_APPEARANCE })))
    await expect(syncPrefs()).resolves.toBeUndefined()
    expect(useStore.getState().keybindings.resolved['view.zen']).toBe('Alt+M')
    // Fora do ar.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(syncPrefs()).resolves.toBeUndefined()
    expect(useStore.getState().keybindings.resolved['view.zen']).toBe('Alt+M')
    expect(readCachedKeybindings()).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('simulateMac: Mod+F passa a ser ⌘F e o desfazer volta ao Ctrl', () => {
    const ctrlF = tecla({ ctrlKey: true }, 'f', 'KeyF')
    const cmdF = tecla({ metaKey: true }, 'f', 'KeyF')
    expect(matchShortcut(ctrlF, 'chat.find')).toBe(true)
    const undo = simulateMac()
    try {
      expect(matchShortcut(cmdF, 'chat.find')).toBe(true)
      expect(matchShortcut(ctrlF, 'chat.find')).toBe(false)
    } finally {
      undo()
    }
    expect(matchShortcut(ctrlF, 'chat.find')).toBe(true)
    expect(matchShortcut(cmdF, 'chat.find')).toBe(false)
  })
})
