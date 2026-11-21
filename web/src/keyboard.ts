import type { ShortcutScope } from './shortcuts/registry'

/**
 * Um campo de digitação que não é o do chat. Com o foco nele, os atalhos globais
 * do chat (Ctrl+Espaço, Ctrl+Enter) são desse campo — a busca da lateral, um
 * modal, o editor de arquivo, o terminal — e não fazem nada no chat.
 */
export function isForeignField(target: EventTarget | null, own: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement) || target === own) return false
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || !!target.closest('[contenteditable]:not([contenteditable="false"])')
}

/**
 * O foco está no terminal interativo (o xterm recebe as teclas num textarea
 * dentro de `.xterm`). Lá as teclas são do shell ou do programa que roda nele:
 * Alt+Z, por exemplo, é do TUI, não da página.
 */
export function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.xterm')
}

/** Foco num modal (o `.modal-overlay` dos modais do app ou um diálogo) ou no terminal interativo. */
function inModalOrTerminal(target: EventTarget | null): boolean {
  return target instanceof Element
    && !!target.closest('.modal-overlay, [role="dialog"], [aria-modal="true"], .xterm, [data-terminal]')
}

/** Foco num modal: o `.modal-overlay` dos modais do app ou um diálogo. */
function inModal(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.modal-overlay, [role="dialog"], [aria-modal="true"]')
}

/** O foco está no campo de mensagem (sem campo montado, nunca). */
function isChatInput(target: EventTarget | null, chatInput: HTMLElement | null): boolean {
  return chatInput !== null && target === chatInput
}

/** Campo de mensagem ou fora de qualquer outro campo de texto. */
function inPage(target: EventTarget | null, chatInput: HTMLElement | null): boolean {
  return !isForeignField(target, chatInput)
}

/** Como a página, e fora de modal e do terminal: a regra de sempre do Ctrl+F. */
function inConversation(target: EventTarget | null, chatInput: HTMLElement | null): boolean {
  return isChatInput(target, chatInput) || (!isForeignField(target, chatInput) && !inModalOrTerminal(target))
}

/** Fora de qualquer campo de texto, inclusive o de mensagem. */
function outsideFields(target: EventTarget | null): boolean {
  return !isForeignField(target, null)
}

/**
 * O foco está onde o atalho do escopo escuta (ver `ShortcutScope` no registro).
 * Só o foco: o que depende do estado (o aviso do desfazer na tela, o uso só para
 * administrador, a barra de busca já aberta) fica com quem escuta.
 */
export function inScope(scope: ShortcutScope, target: EventTarget | null, chatInput: HTMLElement | null): boolean {
  switch (scope) {
    case 'field': return isChatInput(target, chatInput)
    case 'page': return inPage(target, chatInput)
    case 'conversation': return inConversation(target, chatInput)
    case 'outsideFields': return outsideFields(target)
    case 'outsideFieldsAndModals': return outsideFields(target) && !inModal(target)
    case 'allButTerminal': return !isTerminalTarget(target)
  }
}

/**
 * Ctrl+F (⌘+F) abre a busca do Claudinei? Só com o foco no chat, no campo de
 * mensagem (`chatInput`: o campo faz parte do chat, exceção ao isForeignField)
 * ou em nada. Em outro campo de texto, num modal, no editor de arquivo ou no
 * terminal interativo, o atalho é do navegador. Com a barra já aberta, também:
 * o segundo Ctrl+F cai na busca do navegador.
 */
export function shouldOpenFind(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'target'>,
  chatInput: HTMLElement | null,
  barOpen: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'f' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false
  if (barOpen) return false
  return inScope('conversation', e.target, chatInput)
}
