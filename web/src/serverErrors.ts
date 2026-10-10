import i18n from './i18n'

/** O que o servidor manda num erro: o texto (pt-BR) e, nos erros da tela, um código. */
export interface ServerErrorBody {
  error?: string
  /** Erros do WebSocket chegam em `message`. */
  message?: string
  code?: string
  params?: Record<string, string | number>
}

/**
 * A mensagem de erro do servidor no idioma da tela.
 *
 * O servidor continua mandando o texto em português (logs e clientes da API);
 * nos erros que chegam à tela, manda também um `code` estável, traduzido em
 * `serverErrors.<code>`. Erros antigos que já eram só um código ("forbidden",
 * "file too large") são traduzidos pelo próprio texto. Sem tradução, fica o
 * texto do servidor, como antes.
 *
 * Fora de propósito do dicionário: os códigos que a tela COMPARA em vez de
 * mostrar (`locked`, `invalid_credentials`, `stale`) — traduzi-los aqui
 * quebraria essas comparações.
 */
export function localizeServerError(body: ServerErrorBody, fallback = ''): string {
  const text = body.error ?? body.message ?? fallback
  const key = typeof body.code === 'string' ? body.code
    : /^[a-z_ ]+$/.test(text) ? text.trim().replace(/ /g, '_') : null
  if (key && i18n.exists(`serverErrors.${key}`)) {
    return i18n.t(`serverErrors.${key}` as 'serverErrors.forbidden', body.params ?? {})
  }
  return text
}
