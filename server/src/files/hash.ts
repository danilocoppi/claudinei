import { createHash } from 'node:crypto'

/**
 * Identidade do conteúdo de um arquivo, para detectar que ele mudou no disco
 * entre a leitura e a gravação (o agente escreveu no mesmo arquivo que o
 * operador estava editando). Calculado sobre os BYTES: o cliente devolve o
 * valor recebido, nunca recalcula — assim um arquivo com bytes que não são
 * UTF-8 válido não vira conflito eterno por causa do U+FFFD da decodificação.
 */
export const hashContent = (dados: Buffer | string): string =>
  createHash('sha256').update(dados).digest('hex')
