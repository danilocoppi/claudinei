/**
 * Um campo de digitação que não é o do chat. Com o foco nele, os atalhos globais
 * do chat (Ctrl+Espaço, Ctrl+Enter) são desse campo — a busca da lateral, um
 * modal, o editor de arquivo, o terminal — e não fazem nada no chat.
 */
export function isForeignField(target: EventTarget | null, own: HTMLElement | null): boolean {
  if (!(target instanceof HTMLElement) || target === own) return false
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || !!target.closest('[contenteditable]:not([contenteditable="false"])')
}
