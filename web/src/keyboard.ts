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
  if (chatInput && e.target === chatInput) return true
  return !isForeignField(e.target, chatInput) && !inModalOrTerminal(e.target)
}
