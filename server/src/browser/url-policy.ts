// Política de endereços do navegador embutido: só `http:`, `https:` e
// `about:blank` (exato), venham da barra de endereço, das ferramentas do agente
// ou do `PreviewPage.goto`. `file:` exporia o disco do servidor; `chrome:` e
// `devtools:` mexem no próprio navegador; `javascript:` e `data:` não fazem falta.

/** A URL aceita, ou null fora da política. */
export function allowedUrl(raw: string): URL | null {
  if (raw === 'about:blank') return new URL(raw)
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
}

/** Endereço com esquema: `algo:` que não seja seguido de porta (`localhost:5173` não tem esquema). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i
/** Hosts que respondem em http puro: localhost, `*.localhost`, IPv4 e IPv6 entre colchetes. */
const LOCAL_HOST = /^(localhost|[^/:?#]+\.localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])(:\d+)?([/?#]|$)/i

/**
 * Completa o que se digita na barra de endereço: sem esquema, local vira http
 * (`localhost:5173` → `http://localhost:5173`) e o resto vira https
 * (`exemplo.com` → `https://exemplo.com`). Com esquema, volta como veio, e a
 * política decide.
 */
export function normalizeAddress(input: string): string {
  const s = input.trim()
  if (!s || HAS_SCHEME.test(s)) return s
  if (s.startsWith('//')) return `https:${s}`
  return LOCAL_HOST.test(s) ? `http://${s}` : `https://${s}`
}

/** A página de erro do próprio Chromium (falha de rede, redirecionamento recusado): não é navegação proibida. */
export const isChromiumErrorPage = (url: string): boolean => url.startsWith('chrome-error://')
