/**
 * Registro dos atalhos de teclado: os editáveis (com padrão e escopo), os fixos
 * (que a aba mostra com o selo "fixo") e as listas de combinações reservadas e
 * das que o navegador usa mas a página consegue tomar.
 *
 * Atalho novo = uma linha em `EDITABLE`, o rótulo em `shortcuts.labels` nas três
 * línguas e o casamento no ouvinte. O servidor não conhece os ids.
 */

export type ShortcutId =
  | 'chat.send'
  | 'chat.queue'
  | 'chat.voice'
  | 'chat.stash'
  | 'chat.find'
  | 'view.zen'
  | 'view.usage'
  | 'triage.undo'

/**
 * Onde o atalho escuta:
 * - `field`: só no campo de mensagem;
 * - `page`: no campo de mensagem ou fora de qualquer outro campo de texto e de modal;
 * - `conversation`: como `page`, e fora do terminal;
 * - `outsideFields`: fora de qualquer campo, inclusive o de mensagem;
 * - `outsideFieldsAndModals`: como `outsideFields`, e fora de modal;
 * - `allButTerminal`: em todo lugar, menos o terminal.
 */
export type ShortcutScope = 'field' | 'page' | 'conversation' | 'outsideFields' | 'outsideFieldsAndModals' | 'allButTerminal'

/**
 * Os lugares onde uma tecla pode cair: o campo de mensagem, os outros campos de
 * texto (busca, formulários), os editores de arquivo, fora de campos e o terminal.
 */
export type Place = 'chatInput' | 'fields' | 'editors' | 'outside' | 'terminal'

export interface EditableShortcut {
  id: ShortcutId
  labelKey: string
  default: string
  scope: ShortcutScope
  editable: true
  adminOnly?: true
}

/**
 * Atalho que não se edita. `combos` são as combinações na gramática que ele ocupa
 * (para recusar quem quiser usá-las no mesmo lugar); `keysLabel` é o que a aba
 * mostra quando as teclas estão fora da gramática (setas, Esc).
 */
export interface FixedShortcut {
  id: string
  labelKey: string
  combos: string[]
  keysLabel?: string
  places: readonly Place[]
  platform?: 'mac'
  editable: false
}

/** Os editáveis, na ordem da aba e da resolução (a escolha de quem vem antes vence). */
export const EDITABLE: readonly EditableShortcut[] = [
  { id: 'chat.send', labelKey: 'shortcuts.labels.send', default: 'Mod+Enter', scope: 'page', editable: true },
  { id: 'chat.queue', labelKey: 'shortcuts.labels.queue', default: 'Alt+Enter', scope: 'field', editable: true },
  // Control também no Mac: ⌘Espaço é do Spotlight.
  { id: 'chat.voice', labelKey: 'shortcuts.labels.voice', default: 'Ctrl+Space', scope: 'page', editable: true },
  { id: 'chat.stash', labelKey: 'shortcuts.labels.stash', default: 'Mod+S', scope: 'field', editable: true },
  { id: 'chat.find', labelKey: 'shortcuts.labels.find', default: 'Mod+F', scope: 'conversation', editable: true },
  { id: 'view.zen', labelKey: 'shortcuts.labels.zen', default: 'Alt+Z', scope: 'allButTerminal', editable: true },
  { id: 'view.usage', labelKey: 'shortcuts.labels.usage', default: 'Mod+U', scope: 'outsideFields', editable: true, adminOnly: true },
  { id: 'triage.undo', labelKey: 'shortcuts.labels.undo', default: 'Mod+Z', scope: 'outsideFieldsAndModals', editable: true },
]

const ALL_PLACES: readonly Place[] = ['chatInput', 'fields', 'editors', 'outside', 'terminal']
const TEXT_PLACES: readonly Place[] = ['chatInput', 'fields', 'editors']

export const FIXED: readonly FixedShortcut[] = [
  { id: 'fixed.enter', labelKey: 'shortcuts.labels.enter', combos: ['Enter'], places: ['chatInput'], editable: false },
  { id: 'fixed.newline', labelKey: 'shortcuts.labels.newline', combos: ['Shift+Enter'], places: ['chatInput'], editable: false },
  { id: 'fixed.history', labelKey: 'shortcuts.labels.history', combos: [], keysLabel: '↑ ↓', places: ['chatInput'], editable: false },
  // Quem cola sem formatação é o navegador; com outra tecla ele colaria normal.
  { id: 'fixed.pastePlain', labelKey: 'shortcuts.labels.pastePlain', combos: ['Mod+Shift+V'], places: ['chatInput'], editable: false },
  { id: 'fixed.editorSave', labelKey: 'shortcuts.labels.editorSave', combos: ['Mod+S'], places: ['editors'], editable: false },
  { id: 'fixed.findNav', labelKey: 'shortcuts.labels.findNav', combos: ['Enter', 'Shift+Enter'], places: ['fields'], editable: false },
  { id: 'fixed.escape', labelKey: 'shortcuts.labels.escape', combos: [], keysLabel: 'Esc', places: ALL_PLACES, editable: false },
  // Copiar e selecionar valem também fora de campos (o texto da conversa).
  { id: 'fixed.clipboard', labelKey: 'shortcuts.labels.clipboard', combos: ['Mod+C', 'Mod+V', 'Mod+X', 'Mod+A'], places: ALL_PLACES, editable: false },
  { id: 'fixed.undoText', labelKey: 'shortcuts.labels.undoText', combos: ['Mod+Z', 'Mod+Y', 'Mod+Shift+Z'], places: TEXT_PLACES, editable: false },
  // Edição de texto do macOS (Control+A vai ao começo da linha, Control+K apaga até o fim…).
  {
    id: 'fixed.macEdit',
    labelKey: 'shortcuts.labels.macEdit',
    combos: ['Ctrl+A', 'Ctrl+B', 'Ctrl+D', 'Ctrl+E', 'Ctrl+F', 'Ctrl+H', 'Ctrl+K', 'Ctrl+N', 'Ctrl+P', 'Ctrl+U'],
    places: TEXT_PLACES,
    platform: 'mac',
    editable: false,
  },
]

export const SCOPE_PLACES: Record<ShortcutScope, readonly Place[]> = {
  field: ['chatInput'],
  page: ['chatInput', 'outside'],
  conversation: ['chatInput', 'outside'],
  outsideFields: ['outside'],
  outsideFieldsAndModals: ['outside'],
  allButTerminal: ['chatInput', 'fields', 'editors', 'outside'],
}

const MOD_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => `Mod+${d}`)

/**
 * Combinações que a página nem recebe (o navegador ou o sistema tomam antes).
 * Ctrl+Tab e ⌘Tab nem entram: Tab está fora da gramática.
 */
export const RESERVED: { mac: readonly string[]; other: readonly string[] } = {
  mac: [
    'Mod+W', 'Mod+T', 'Mod+N', 'Mod+Q', 'Mod+H', 'Mod+M',
    'Mod+Shift+W', 'Mod+Shift+T', 'Mod+Shift+N',
    'Mod+Space',
    ...MOD_DIGITS,
    'F1', 'F5', 'F11', 'F12', 'Ctrl+F5',
  ],
  other: [
    'Mod+W', 'Mod+T', 'Mod+N',
    'Mod+Shift+W', 'Mod+Shift+T', 'Mod+Shift+N', 'Mod+Shift+Q',
    'Alt+F4', 'Mod+F4',
    ...MOD_DIGITS,
    'F1', 'F5', 'F11', 'F12', 'Mod+F5',
  ],
}

/** Do navegador, mas a página consegue tomar: aceitas com aviso amarelo. */
export const BROWSER_WARN: { mac: readonly string[]; other: readonly string[] } = {
  mac: ['Mod+R', 'Mod+L', 'Mod+P', 'Mod+D', 'Mod+G', 'Mod+J', 'Mod+O'],
  other: ['Mod+R', 'Mod+L', 'Mod+P', 'Mod+D', 'Mod+G', 'Mod+J', 'Mod+O', 'Alt+D', 'Alt+E', 'Alt+F'],
}

const BY_ID = new Map<string, EditableShortcut>(EDITABLE.map((e) => [e.id, e]))

export function isShortcutId(id: string): id is ShortcutId {
  return BY_ID.has(id)
}

export function editableById(id: ShortcutId): EditableShortcut {
  const e = BY_ID.get(id)
  if (!e) throw new Error(`atalho desconhecido: ${id}`)
  return e
}
