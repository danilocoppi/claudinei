/**
 * Quem manda no auto-scroll do chat é a barra de rolagem, não um botão.
 *
 * Subir para ler é o gesto que SOLTA a tela; voltar ao fim é o que a prende de
 * novo. É a regra de todo chat e de todo `tail -f`, e a mais ágil possível —
 * não custa clique nenhum, e é o gesto que a pessoa já ia fazer de qualquer jeito.
 */

/**
 * Folga em pixels para "estar no fim".
 *
 * Não é frescura: a altura do conteúdo muda entre o cálculo e a pintura enquanto
 * a resposta chega, e sem essa margem um sub-pixel de sobra soltaria a tela
 * sozinho no meio do streaming — exatamente o oposto do que se quer.
 */
export const SLACK = 80

export function isAtBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = SLACK,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}
