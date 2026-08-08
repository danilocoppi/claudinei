import type { ClaudeEvent } from '../claude/events.js'

/**
 * Evento `user` sintético para a UI mostrar, na hora, uma mensagem que o SERVIDOR
 * injetou na sessão (task despachada por outro terminal).
 *
 * Existe porque nenhuma engine devolve a mensagem que recebe, e a UI só desenha o
 * que ela mesma inseriu ao digitar (addLocalUserText). Uma injeção do servidor não
 * passa por nenhum dos dois caminhos, então sem isto ela só aparecia quando o
 * histórico era relido. O evento não vai para o transcript da engine — logo não
 * duplica quando o histórico recarrega.
 */
export function userEchoEvent(text: string): ClaudeEvent {
  return {
    kind: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    raw: { type: 'user' },
  } as ClaudeEvent
}
