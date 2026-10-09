/**
 * Sequências que o xterm do navegador manda sozinho ao PTY, ou que só movem o
 * cursor: respostas a consultas do programa (OSC, DCS, posição do cursor,
 * atributos), foco, mouse, setas e teclas de função. A ordem importa: o mouse no
 * formato antigo carrega três bytes crus depois do `CSI M`, que podem ser
 * imprimíveis e passariam por texto se o CSI genérico viesse antes.
 */
const NOT_TYPED = [
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, // OSC (ex.: resposta de cor do fundo)
  /\x1b[P_^X][\s\S]*?\x1b\\/g, // DCS, APC, PM, SOS
  /\x1b\[M[\s\S]{3}/g, // mouse X10/normal
  /\x1b\[[0-?]*[ -/]*[@-~]/g, // CSI: foco, mouse SGR, setas, relatórios, marcadores de colagem
  /\x1bO[\s\S]/g, // SS3: setas e F1–F4 no modo aplicação
]

/**
 * O que chegou do terminal foi a pessoa digitando? Sobra algum byte depois de
 * tirar as sequências automáticas e de navegação: letra, Enter, Backspace,
 * Ctrl+tecla, Esc sozinho, o texto de uma colagem.
 */
export function isTyping(data: string): boolean {
  let rest = data
  for (const re of NOT_TYPED) rest = rest.replace(re, '')
  return rest.length > 0
}
