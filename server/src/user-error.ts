/**
 * Erro que chega à tela.
 *
 * O texto continua em português em `error` — é o que os logs e os clientes da
 * API sempre leram. O `code` estável e os `params` deixam a interface mostrar a
 * mensagem no idioma escolhido (web/src/i18n, chave `serverErrors.<code>`); sem
 * tradução para o código, a interface cai no texto, como antes.
 */
export type ErrorParams = Record<string, string | number>

export class UserError extends Error {
  constructor(readonly code: string, message: string, readonly params: ErrorParams = {}) {
    super(message)
  }
}

export interface ErrorBody { error: string; code?: string; params?: ErrorParams }

/** Corpo de resposta para um erro capturado: com código se for da tela. */
export function errorBody(err: unknown): ErrorBody {
  const error = err instanceof Error ? err.message : String(err)
  return err instanceof UserError ? { error, code: err.code, params: err.params } : { error }
}

/** Corpo de resposta para um erro decidido na própria rota. */
export const fail = (code: string, message: string, params: ErrorParams = {}): ErrorBody =>
  ({ error: message, code, params })
