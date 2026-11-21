/**
 * Os atalhos valendo agora, lidos da store: casar um evento, conferir o escopo e
 * mostrar a combinação. Cada ouvinte pergunta pelo próprio id; o casamento é uma
 * consulta ao mapa `resolved`, sem ouvinte novo.
 */
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { inScope } from '../keyboard'
import { formatCombo, isMac, matchCombo, type KeyLike } from './combo'
import { editableById, type ShortcutId } from './registry'

/** A combinação que vale para o id, fora do React; null quando a ação está sem atalho. */
export function shortcutCombo(id: ShortcutId): string | null {
  return useStore.getState().keybindings.resolved[id] ?? null
}

/** O evento é o atalho do id nesta plataforma. Ação sem atalho nunca casa. */
export function matchShortcut(e: KeyLike, id: ShortcutId): boolean {
  const combo = shortcutCombo(id)
  return combo !== null && matchCombo(e, combo, isMac())
}

/** O foco está onde o atalho do id escuta (o escopo do registro). */
export function inShortcutScope(id: ShortcutId, target: EventTarget | null, chatInput: HTMLElement | null): boolean {
  return inScope(editableById(id).scope, target, chatInput)
}

/** A combinação do id como aparece na tela ("Ctrl+Enter", "⌘↩"); null sem atalho. */
export function useShortcutLabel(id: ShortcutId): string | null {
  const { t } = useTranslation()
  const combo = useStore((s) => s.keybindings.resolved[id] ?? null)
  return combo === null ? null : formatCombo(combo, { mac: isMac(), space: t('shortcuts.keySpace') })
}
