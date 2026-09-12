import { randomBytes } from 'node:crypto'

/**
 * Concessões de leitura para a prévia RENDERIZADA de um HTML.
 *
 * A prévia roda num iframe `sandbox` sem `allow-same-origin` — é o que impede um
 * HTML com script (inclusive um gerado por agente) de falar com a API do
 * Claudinei usando a sessão de quem abriu. O preço é que esse documento tem
 * origem opaca: o navegador não manda o cookie de sessão nos subrecursos dele,
 * então o CSS e as imagens da página chegariam como 401.
 *
 * Daí a autorização viajar no próprio caminho da URL, como capacidade: um token
 * aleatório, de vida curta, preso a uma raiz e só de leitura. Ele não amplia o
 * alcance de ninguém — quem o emitiu já podia ler aquela raiz pela rota normal.
 */
export interface PreviewGrant {
  /** Raiz real (pós-symlink) que o token libera. Nada fora dela é servido. */
  root: string
  expiresAt: number
}

export interface PreviewStore {
  issue(root: string): string
  resolve(token: string): PreviewGrant | null
  size(): number
}

/** Curto de propósito: a janela de uso é "enquanto a prévia está aberta". */
export const PREVIEW_TTL_MS = 10 * 60_000
export const PREVIEW_BASE = '/api/files/preview'

export function createPreviewStore(opts?: {
  ttlMs?: number
  now?: () => number
  makeToken?: () => string
}): PreviewStore {
  const ttl = opts?.ttlMs ?? PREVIEW_TTL_MS
  const now = opts?.now ?? Date.now
  // 32 bytes: adivinhar não é um vetor, e o token nunca é logado.
  const makeToken = opts?.makeToken ?? (() => randomBytes(32).toString('base64url'))
  const grants = new Map<string, PreviewGrant>()

  const limpar = (t: number) => {
    for (const [k, g] of grants) if (g.expiresAt <= t) grants.delete(k)
  }

  return {
    issue(root) {
      const t = now()
      limpar(t) // sem isso, cada prévia aberta ficaria para sempre na memória do processo
      const token = makeToken()
      grants.set(token, { root, expiresAt: t + ttl })
      return token
    },
    resolve(token) {
      const g = grants.get(token)
      if (!g) return null
      if (g.expiresAt <= now()) { grants.delete(token); return null }
      return g
    },
    size: () => grants.size,
  }
}

/**
 * URL do documento — o caminho do disco vira caminho de URL.
 *
 * É o coração da feature: com a hierarquia espelhada, quem resolve
 * `../fotos/p.png` é o próprio navegador, e o HTML é servido CRU (nada de
 * reescrever `src`/`href` no servidor, que é onde esse tipo de coisa quebra).
 */
export function previewUrl(token: string, file: string): string {
  const partes = file.replace(/\\/g, '/').split('/').filter(Boolean)
  return `${PREVIEW_BASE}/${token}/${partes.map(encodeURIComponent).join('/')}`
}

/**
 * Caminho absoluto a partir do resto da URL (o que vem depois do token).
 *
 * Recusa `..` em vez de normalizar: aqui a normalização silenciosa seria uma
 * forma educada de aceitar travessia. Quem manda `..` não quer o que a rota
 * oferece. (O confinamento à raiz é checado depois, com realpath — isto é a
 * primeira barreira, não a única.)
 */
export function pathFromPreviewUrl(rest: string): string | null {
  if (!rest || rest.includes('\0')) return null
  const partes = rest.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  if (partes.length === 0 || partes.some((p) => p === '..')) return null
  // Windows chega como `C:/Users/...`; no resto do mundo a barra inicial some no split.
  return /^[A-Za-z]:$/.test(partes[0]) ? partes.join('/') : `/${partes.join('/')}`
}
