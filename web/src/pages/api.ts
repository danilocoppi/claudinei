import { req } from '../api'
import type { PageNetwork, VisualPageDto } from '../../../shared/visual-pages'

/**
 * Rotas das respostas visuais (server/src/pages/routes.ts). Os erros saem do
 * `req` com `status`: 403 (sem acesso) e 404 (apagada) o store trata como
 * página indisponível.
 */
const enc = encodeURIComponent

/** As páginas da conversa atual do terminal, na ordem em que foram criadas. */
export const listPages = (localId: string) =>
  req<VisualPageDto[]>(`/api/sessions/${enc(localId)}/pages`)

export const getPage = (id: string) =>
  req<VisualPageDto>(`/api/pages/${enc(id)}`)

/** Endereço com token novo (10 min) para o cartão, a tela cheia ou a nova aba. */
export const viewPage = (id: string) =>
  req<{ url: string }>(`/api/pages/${enc(id)}/view`, { method: 'POST' })

export const fetchPagesSettings = () =>
  req<{ network: PageNetwork }>('/api/visual-pages/settings')

/** Só admin. Vale na próxima abertura de cada página. */
export const savePagesSettings = (network: PageNetwork) =>
  req<{ network: PageNetwork }>('/api/visual-pages/settings', { method: 'PUT', body: JSON.stringify({ network }) })
