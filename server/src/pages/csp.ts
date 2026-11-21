import type { PageNetwork } from '../../../shared/visual-pages.js'

/**
 * Política da página visual servida. A página roda em sandbox sem
 * `allow-same-origin` (origem opaca: sem sessão e sem a API do Claudinei).
 * Na rede padrão (`cdn`) só carrega das três CDNs e do Google Fonts, e nada
 * conecta; com a rede liberada (`open`), carrega e conecta a qualquer lugar.
 */

export const PAGE_CDNS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com'] as const

const SANDBOX = 'sandbox allow-scripts'

function directives(network: PageNetwork): string[] {
  if (network === 'open') {
    return ["default-src * data: blob: 'unsafe-inline' 'unsafe-eval'", 'connect-src *', "form-action 'none'", "base-uri 'none'"]
  }
  const cdn = PAGE_CDNS.join(' ')
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn} https://fonts.googleapis.com`,
    `font-src data: ${cdn} https://fonts.gstatic.com`,
    `img-src data: blob: ${cdn}`,
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ]
}

/** O cabeçalho `Content-Security-Policy` da página servida. */
export function pageCsp(network: PageNetwork): string {
  return [SANDBOX, ...directives(network)].join('; ')
}

/** A mesma política para um `<meta http-equiv>`, que não aceita a diretiva `sandbox`. */
export function metaCsp(network: PageNetwork): string {
  return directives(network).join('; ')
}

export const PAGE_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), display-capture=()'
