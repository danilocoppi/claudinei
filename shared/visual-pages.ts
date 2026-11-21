/**
 * Respostas visuais: o agente publica uma página HTML que aparece na conversa.
 * Tipos e reconhecedores usados pelo servidor e pela web.
 */

/** Id da página: `pg_` + 16 hex minúsculos (`randomBytes(8)`). */
export const PAGE_ID_RE = /\bpg_[0-9a-f]{16}\b/

/** `type` da mensagem que o script de altura manda ao cartão por `postMessage`. */
export const PAGE_HEIGHT_MESSAGE = 'claudinei-page-height'

/** Rede liberada para a página: só os CDNs conhecidos (padrão) ou aberta. */
export type PageNetwork = 'cdn' | 'open'

export interface VisualPageDto {
  id: string
  projectId: number
  engine: string
  localId: string
  conversationId: string | null
  turnId: number | null
  turnKey: string | null
  title: string
  height: number | null
  bytes: number
  source: 'html' | 'path'
  createdAt: string
}

/** O primeiro id de página do texto, ou null. */
export function pageIdIn(text: string): string | null {
  return PAGE_ID_RE.exec(text)?.[0] ?? null
}

/** O nome da ferramenta é o `show_page` do hermes, com ou sem prefixo do motor. */
export function isShowPageName(name: string): boolean {
  return /(?:^|[^A-Za-z0-9])show_page$/.test(name)
}
