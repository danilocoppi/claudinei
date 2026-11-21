/**
 * Combinação de teclas dos atalhos configuráveis: ler, mostrar, casar com um
 * evento e gravar a partir de um.
 *
 * O texto guardado é como `Mod+Shift+K`: modificadores na ordem Mod, Ctrl, Alt,
 * Shift, e uma tecla entre A–Z, 0–9, Enter, Space e F1–F12. `Mod` é ⌘ no Mac e
 * Ctrl nos outros; `Ctrl` é sempre a tecla Control. Fora do Mac os dois são a
 * mesma tecla, e a gravação guarda `Mod`.
 */

/** O que importa de um evento de teclado (keydown) para casar ou gravar. */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & {
  code?: string
  isComposing?: boolean
}

/** `key`: 'A'..'Z' | '0'..'9' | 'Enter' | 'Space' | 'F1'..'F12'. */
export interface Combo { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string }

/** A gramática, igual à do servidor (`KEYBINDING_COMBO` em server/src/prefs.ts). */
export const COMBO_RE = /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|Enter|Space|F[1-9]|F1[0-2])$/

const LATIN_LETTER = /^\p{Script=Latin}$/u
const LETTER = /^\p{L}$/u
const F_KEY = /^F([1-9]|1[0-2])$/

/** Teclas que só modificam: apertadas sozinhas, a gravação continua esperando. */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'])

/**
 * Mac, iPhone ou iPad. Avaliado a cada chamada, sem guardar: os testes simulam o
 * Mac trocando `navigator.platform`.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return [nav.userAgentData?.platform, nav.platform].some((p) => !!p && /Mac|iPhone|iPad/.test(p))
}

export function parseCombo(s: string): Combo | null {
  const m = COMBO_RE.exec(s)
  if (!m) return null
  return { mod: !!m[1], ctrl: !!m[2], alt: !!m[3], shift: !!m[4], key: m[5] }
}

export function stringifyCombo(c: Combo): string {
  const parts: string[] = []
  if (c.mod) parts.push('Mod')
  if (c.ctrl) parts.push('Ctrl')
  if (c.alt) parts.push('Alt')
  if (c.shift) parts.push('Shift')
  parts.push(c.key)
  return parts.join('+')
}

/** Fora do Mac Ctrl é o próprio Mod: `Ctrl+K` e `Mod+Ctrl+K` viram `Mod+K`. */
function canonical(c: Combo, mac: boolean): Combo {
  return mac ? c : { ...c, mod: c.mod || c.ctrl, ctrl: false }
}

/** A forma única da combinação nesta plataforma; null fora da gramática. */
export function canonicalCombo(s: string, mac: boolean): string | null {
  const c = parseCombo(s)
  return c ? stringifyCombo(canonical(c, mac)) : null
}

/** As duas combinações são a mesma tecla nesta plataforma (fora da gramática, nunca). */
export function sameCombo(a: string, b: string, mac: boolean): boolean {
  const ca = canonicalCombo(a, mac)
  return ca !== null && ca === canonicalCombo(b, mac)
}

/**
 * Como a combinação aparece na tela. Fora do Mac, nomes com '+' ("Ctrl+Enter");
 * no Mac, os símbolos na ordem da Apple (⌃⌥⇧⌘) e a tecla ("⌘↩"). `space` é o
 * nome traduzido da barra de espaço. Fora da gramática, o texto volta como veio.
 */
export function formatCombo(s: string, opts: { mac: boolean; space?: string }): string {
  const c = parseCombo(s)
  if (!c) return s
  const space = opts.space ?? 'Space'
  if (opts.mac) {
    const key = c.key === 'Enter' ? '↩' : c.key === 'Space' ? space : c.key
    return (c.ctrl ? '⌃' : '') + (c.alt ? '⌥' : '') + (c.shift ? '⇧' : '') + (c.mod ? '⌘' : '') + key
  }
  const parts: string[] = []
  if (c.mod || c.ctrl) parts.push('Ctrl')
  if (c.alt) parts.push('Alt')
  if (c.shift) parts.push('Shift')
  parts.push(c.key === 'Space' ? space : c.key)
  return parts.join('+')
}

/** A tecla da gramática pela posição física (`code`), ou null. */
function keyFromCode(code: string | undefined): string | null {
  if (!code) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (code === 'Enter' || code === 'NumpadEnter') return 'Enter'
  if (code === 'Space') return 'Space'
  if (F_KEY.test(code)) return code
  return null
}

/**
 * A tecla da gramática que o evento aperta, ou null.
 * - No Mac com Option, só a posição: o Option troca o que a tecla escreve
 *   (Option+Z dá 'Ω', Option+A dá 'å', Option+1 dá '¡').
 * - Enter, Espaço e F1–F12 pelo nome; dígitos pela posição (`DigitN`), porque em
 *   alguns layouts o número só sai com Shift; o teclado numérico não conta.
 * - Letra latina pela própria letra (no Dvorak a posição do U dá 'g', e Ctrl+G
 *   segue com o navegador); letra de outro alfabeto ou tecla morta, pela posição.
 *   Pontuação e letra latina fora de A–Z (ç, ß) não valem.
 */
function keyFromEvent(e: KeyLike, mac: boolean): string | null {
  if (mac && e.altKey) return keyFromCode(e.code)
  if (e.key === 'Enter') return 'Enter'
  if (e.code === 'Space' || e.key === ' ') return 'Space'
  if (F_KEY.test(e.key)) return e.key
  if (e.code && /^Digit[0-9]$/.test(e.code)) return e.code.slice(5)
  if (LATIN_LETTER.test(e.key)) {
    const up = e.key.toUpperCase()
    return /^[A-Z]$/.test(up) ? up : null
  }
  if (e.key === 'Dead' || LETTER.test(e.key)) {
    return e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : null
  }
  return null
}

/** Os modificadores que o evento traz, como Combo (Super fora do Mac fica de fora). */
function modsFromEvent(e: KeyLike, mac: boolean): Omit<Combo, 'key'> {
  return mac
    ? { mod: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }
    : { mod: e.ctrlKey, ctrl: false, alt: e.altKey, shift: e.shiftKey }
}

/**
 * O evento é esta combinação: modificadores exatos, nem a mais nem a menos, e a
 * tecla pela regra de `keyFromEvent`. Em composição (IME), nunca.
 */
export function matchCombo(e: KeyLike, combo: string, mac: boolean): boolean {
  if (e.isComposing) return false
  const parsed = parseCombo(combo)
  if (!parsed) return false
  const c = canonical(parsed, mac)
  // Fora do Mac a tecla Super/Windows não faz parte de nenhuma combinação.
  if (!mac && e.metaKey) return false
  const m = modsFromEvent(e, mac)
  if (m.mod !== c.mod || m.ctrl !== c.ctrl || m.alt !== c.alt || m.shift !== c.shift) return false
  return keyFromEvent(e, mac) === c.key
}

/**
 * A combinação que o evento grava. 'modifier' quando só um modificador foi
 * apertado (a gravação continua esperando); null quando a tecla está fora da
 * gramática ou quando vem com Super fora do Mac. As recusas de uso (letra sem
 * modificador, Ctrl+Alt, reservadas) ficam com quem resolve os atalhos.
 */
export function comboFromEvent(e: KeyLike, mac: boolean): string | 'modifier' | null {
  if (MODIFIER_KEYS.has(e.key)) return 'modifier'
  if (e.isComposing) return null
  if (!mac && e.metaKey) return null
  const key = keyFromEvent(e, mac)
  if (key === null) return null
  return stringifyCombo({ ...modsFromEvent(e, mac), key })
}

/**
 * O keyup solta a combinação: a tecla principal ou um dos seus modificadores.
 * Mod é 'Meta' no Mac e 'Control' fora. A tecla principal vale pelo nome ou pela
 * posição — o keyup não diz se o Option ainda estava apertado.
 */
export function isComboRelease(
  e: Pick<KeyboardEvent, 'key'> & { code?: string },
  combo: string,
  mac: boolean,
): boolean {
  const c = parseCombo(combo)
  if (!c) return false
  switch (e.key) {
    case 'Meta': return mac && c.mod
    case 'Control': return c.ctrl || (!mac && c.mod)
    case 'Alt': return c.alt
    case 'Shift': return c.shift
  }
  const plain = { key: e.key, code: e.code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
  return keyFromEvent(plain, false) === c.key || keyFromCode(e.code) === c.key
}
