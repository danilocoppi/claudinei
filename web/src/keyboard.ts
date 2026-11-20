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
