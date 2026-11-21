import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  COMBO_RE,
  canonicalCombo,
  comboFromEvent,
  formatCombo,
  isComboRelease,
  isMac,
  matchCombo,
  parseCombo,
  sameCombo,
  stringifyCombo,
  type KeyLike,
} from '../shortcuts/combo'

/**
 * Combinação de teclas: o texto guardado (`Mod+Shift+K`), como ele aparece na
 * tela, como casa com um evento de teclado e como se grava a partir de um.
 */

const ev = (over: Partial<KeyLike>): KeyLike => ({
  key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over,
})

afterEach(() => { vi.restoreAllMocks() })

describe('combo', () => {
  it('parse e stringify vão e voltam; ordem e gramática', () => {
    expect(parseCombo('Mod+Shift+K')).toEqual({ mod: true, ctrl: false, alt: false, shift: true, key: 'K' })
    for (const s of ['Mod+Shift+K', 'Mod+Ctrl+Alt+Shift+F12', 'Alt+Enter', 'Ctrl+Space', 'F2', 'Mod+0']) {
      const c = parseCombo(s)
      expect(c).not.toBeNull()
      expect(stringifyCombo(c!)).toBe(s)
    }
    for (const s of ['Shift+Mod+K', 'Mod+Tab', 'Mod+', 'Mod+k', 'F13', '', 'Mod+Mod+K', 'F0']) {
      expect(parseCombo(s)).toBeNull()
    }
  })

  it('COMBO_RE é a gramática do servidor', () => {
    expect(COMBO_RE.source).toBe('^(Mod\\+)?(Ctrl\\+)?(Alt\\+)?(Shift\\+)?([A-Z0-9]|Enter|Space|F[1-9]|F1[0-2])$')
  })

  it('formatCombo fora do Mac e no Mac', () => {
    expect(formatCombo('Mod+Enter', { mac: false })).toBe('Ctrl+Enter')
    expect(formatCombo('Mod+Enter', { mac: true })).toBe('⌘↩')
    expect(formatCombo('Ctrl+Space', { mac: false, space: 'Espaço' })).toBe('Ctrl+Espaço')
    expect(formatCombo('Ctrl+Space', { mac: true, space: 'Espaço' })).toBe('⌃Espaço')
    expect(formatCombo('Ctrl+Space', { mac: false })).toBe('Ctrl+Space')
    expect(formatCombo('Mod+Shift+K', { mac: true })).toBe('⇧⌘K')
    expect(formatCombo('Alt+Z', { mac: true })).toBe('⌥Z')
    expect(formatCombo('Alt+Z', { mac: false })).toBe('Alt+Z')
    expect(formatCombo('Mod+Ctrl+Alt+Shift+K', { mac: true })).toBe('⌃⌥⇧⌘K')
    // Fora do Mac Mod e Ctrl são a mesma tecla: aparece uma vez só.
    expect(formatCombo('Mod+Ctrl+K', { mac: false })).toBe('Ctrl+K')
  })

  it('canonicalCombo: Ctrl e Mod iguais fora do Mac, diferentes no Mac', () => {
    expect(sameCombo('Ctrl+K', 'Mod+K', false)).toBe(true)
    expect(sameCombo('Ctrl+K', 'Mod+K', true)).toBe(false)
    expect(sameCombo('Mod+Ctrl+K', 'Mod+K', false)).toBe(true)
    expect(sameCombo('Mod+K', 'Mod+Shift+K', false)).toBe(false)
    expect(sameCombo('Mod+k', 'Mod+k', false)).toBe(false)
    expect(canonicalCombo('Ctrl+Alt+K', false)).toBe('Mod+Alt+K')
    expect(canonicalCombo('Ctrl+Alt+K', true)).toBe('Ctrl+Alt+K')
    expect(canonicalCombo('Mod+Tab', false)).toBeNull()
  })

  it('casar fora do Mac', () => {
    expect(matchCombo(ev({ key: 'f', ctrlKey: true }), 'Mod+F', false)).toBe(true)
    expect(matchCombo(ev({ key: 'F', ctrlKey: true }), 'Mod+F', false)).toBe(true)
    expect(matchCombo(ev({ key: 'f', metaKey: true }), 'Mod+F', false)).toBe(false)
    expect(matchCombo(ev({ key: 'f', ctrlKey: true, shiftKey: true }), 'Mod+F', false)).toBe(false)
    expect(matchCombo(ev({ key: 'f' }), 'Mod+F', false)).toBe(false)
    expect(matchCombo(ev({ key: ' ', code: 'Space', ctrlKey: true }), 'Ctrl+Space', false)).toBe(true)
    expect(matchCombo(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), 'Mod+Enter', false)).toBe(true)
    expect(matchCombo(ev({ key: 'F2', code: 'F2' }), 'F2', false)).toBe(true)
    expect(matchCombo(ev({ key: 'F2', code: 'F2' }), 'F12', false)).toBe(false)
  })

  it('casar no Mac', () => {
    expect(matchCombo(ev({ key: 'f', metaKey: true }), 'Mod+F', true)).toBe(true)
    expect(matchCombo(ev({ key: 'f', ctrlKey: true }), 'Mod+F', true)).toBe(false)
    expect(matchCombo(ev({ code: 'Space', key: ' ', ctrlKey: true }), 'Ctrl+Space', true)).toBe(true)
    expect(matchCombo(ev({ code: 'Space', key: ' ', metaKey: true }), 'Ctrl+Space', true)).toBe(false)
  })

  it('layouts', () => {
    // Dvorak: a posição do U dá 'g'; Ctrl+G segue com o navegador.
    expect(matchCombo(ev({ key: 'g', code: 'KeyU', ctrlKey: true }), 'Mod+U', false)).toBe(false)
    expect(matchCombo(ev({ key: 'u', code: 'KeyF', ctrlKey: true }), 'Mod+U', false)).toBe(true)
    // Cirílico: letra de outro alfabeto vale pela posição.
    expect(matchCombo(ev({ key: 'ы', code: 'KeyS', ctrlKey: true }), 'Mod+S', false)).toBe(true)
    // Tecla morta vale pela posição.
    expect(matchCombo(ev({ key: 'Dead', code: 'KeyE', altKey: true }), 'Alt+E', false)).toBe(true)
    // Pontuação não vale.
    expect(matchCombo(ev({ key: ';', code: 'KeyZ', altKey: true }), 'Alt+Z', false)).toBe(false)
    // Letra latina fora de A–Z (ç) não cai na posição.
    expect(matchCombo(ev({ key: 'ç', code: 'KeyZ', altKey: true }), 'Alt+Z', false)).toBe(false)
    // Option no Mac: sempre pela posição.
    expect(matchCombo(ev({ key: 'Ω', code: 'KeyZ', altKey: true }), 'Alt+Z', true)).toBe(true)
    expect(matchCombo(ev({ key: 'å', code: 'KeyA', altKey: true }), 'Alt+A', true)).toBe(true)
    expect(matchCombo(ev({ key: 'z', code: 'KeyY', altKey: true }), 'Alt+Z', true)).toBe(false)
  })

  it('Option no Mac: dígitos, Enter, Espaço e F pela posição', () => {
    expect(matchCombo(ev({ key: '¡', code: 'Digit1', altKey: true }), 'Alt+1', true)).toBe(true)
    expect(matchCombo(ev({ key: 'Enter', code: 'Enter', altKey: true }), 'Alt+Enter', true)).toBe(true)
    expect(matchCombo(ev({ key: 'Enter', code: 'NumpadEnter', altKey: true }), 'Alt+Enter', true)).toBe(true)
    expect(matchCombo(ev({ key: ' ', code: 'Space', altKey: true }), 'Alt+Space', true)).toBe(true)
    expect(matchCombo(ev({ key: 'F3', code: 'F3', altKey: true }), 'Alt+F3', true)).toBe(true)
    expect(matchCombo(ev({ key: '1', code: 'Numpad1', altKey: true }), 'Alt+1', true)).toBe(false)
  })

  it('dígito pela posição', () => {
    expect(matchCombo(ev({ key: '!', code: 'Digit1', altKey: true }), 'Alt+1', false)).toBe(true)
    expect(matchCombo(ev({ key: 'é', code: 'Digit2', ctrlKey: true }), 'Mod+2', false)).toBe(true)
    expect(matchCombo(ev({ key: '1', code: 'Numpad1', altKey: true }), 'Alt+1', false)).toBe(false)
  })

  it('isComposing nunca casa', () => {
    expect(matchCombo(ev({ key: 'f', ctrlKey: true, isComposing: true }), 'Mod+F', false)).toBe(false)
    expect(matchCombo(ev({ key: 'Enter', code: 'Enter', altKey: true, isComposing: true }), 'Alt+Enter', true)).toBe(false)
  })

  it('combinação fora da gramática nunca casa', () => {
    expect(matchCombo(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }), 'Mod+Tab', false)).toBe(false)
  })

  it('gravar fora do Mac', () => {
    expect(comboFromEvent(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), false)).toBe('Mod+K')
    expect(comboFromEvent(ev({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+Enter')
    expect(comboFromEvent(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), false)).toBe('modifier')
    expect(comboFromEvent(ev({ key: 'AltGraph', code: 'AltRight' }), false)).toBe('modifier')
    expect(comboFromEvent(ev({ key: ',', code: 'Comma', ctrlKey: true }), false)).toBeNull()
    expect(comboFromEvent(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }), false)).toBeNull()
    expect(comboFromEvent(ev({ key: 'k', code: 'KeyK', metaKey: true }), false)).toBeNull()
    expect(comboFromEvent(ev({ key: 'F2', code: 'F2' }), false)).toBe('F2')
    expect(comboFromEvent(ev({ key: 'ы', code: 'KeyS', ctrlKey: true }), false)).toBe('Mod+S')
    expect(comboFromEvent(ev({ key: ' ', code: 'Space', ctrlKey: true, altKey: true }), false)).toBe('Mod+Alt+Space')
    expect(comboFromEvent(ev({ key: '@', code: 'Digit2', shiftKey: true, altKey: true }), false)).toBe('Alt+Shift+2')
  })

  it('gravar no Mac', () => {
    expect(comboFromEvent(ev({ key: 'k', code: 'KeyK', metaKey: true }), true)).toBe('Mod+K')
    expect(comboFromEvent(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), true)).toBe('Ctrl+K')
    expect(comboFromEvent(ev({ key: 'Ω', code: 'KeyZ', altKey: true }), true)).toBe('Alt+Z')
    expect(comboFromEvent(ev({ key: 'å', code: 'KeyA', altKey: true }), true)).toBe('Alt+A')
    expect(comboFromEvent(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true)).toBe('modifier')
    expect(comboFromEvent(ev({ key: '≤', code: 'Comma', altKey: true }), true)).toBeNull()
  })

  it('soltura', () => {
    expect(isComboRelease({ key: 'm', code: 'KeyM' }, 'Alt+M', false)).toBe(true)
    expect(isComboRelease({ key: 'Alt' }, 'Alt+M', false)).toBe(true)
    expect(isComboRelease({ key: 'Control' }, 'Alt+M', false)).toBe(false)
    expect(isComboRelease({ key: 'n', code: 'KeyN' }, 'Alt+M', false)).toBe(false)
    expect(isComboRelease({ key: 'Meta' }, 'Mod+Space', true)).toBe(true)
    expect(isComboRelease({ key: 'Control' }, 'Mod+Space', true)).toBe(false)
    expect(isComboRelease({ key: 'Control' }, 'Mod+Space', false)).toBe(true)
    expect(isComboRelease({ key: 'Meta' }, 'Mod+Space', false)).toBe(false)
    expect(isComboRelease({ key: ' ', code: 'Space' }, 'Ctrl+Space', true)).toBe(true)
    expect(isComboRelease({ key: 'Control' }, 'Ctrl+Space', true)).toBe(true)
    expect(isComboRelease({ key: 'Shift' }, 'Ctrl+Space', true)).toBe(false)
    // Option no Mac: a tecla solta pode chegar com outra letra; vale a posição.
    expect(isComboRelease({ key: 'Ω', code: 'KeyZ' }, 'Alt+Z', true)).toBe(true)
    expect(isComboRelease({ key: 'Tab', code: 'Tab' }, 'Mod+Tab', false)).toBe(false)
  })

  it('isMac', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get')
    platform.mockReturnValue('MacIntel')
    expect(isMac()).toBe(true)
    platform.mockReturnValue('iPhone')
    expect(isMac()).toBe(true)
    platform.mockReturnValue('iPad')
    expect(isMac()).toBe(true)
    platform.mockReturnValue('Linux x86_64')
    expect(isMac()).toBe(false)
  })
})
