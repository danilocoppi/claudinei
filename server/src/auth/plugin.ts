// Hook global de autenticação: com usuários cadastrados, TODA rota /api|/ws
// exige JWT (cookie do navegador ou bearer do hermes) — rota nova nasce
// fechada. Com 0 usuários (pré-setup) só loopback entra, sem credenciais.
import cookie from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'
import type { AuthService } from './index.js'

export type AuthUser =
  | { kind: 'user'; id: number; username: string; isAdmin: boolean; projectIds: number[] }
  | { kind: 'service' }

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser
    /**
     * Há um proxy reverso na frente? Fixo por processo (--behind-proxy), decorado
     * no request. Quando true, `isTrustedLocal` deixa de tratar loopback como
     * "dono na máquina" — porque loopback passa a ser o endereço do proxy.
     */
    behindProxy?: boolean
  }
}

export const COOKIE_NAME = 'claudinei_token'

// Flags do cookie de sessão — usado tanto pelas rotas que fazem login/troca de
// senha (routes.ts) quanto pelo hook de sliding refresh abaixo, pra nunca
// divergir os dois pontos que emitem o cookie.
export const COOKIE_OPTS = { httpOnly: true, sameSite: 'strict' as const, path: '/', maxAge: 7 * 24 * 3600 }

/**
 * As flags do cookie para este processo.
 *
 * `secure` depende de haver TLS — e nesta arquitetura o app NUNCA termina HTTPS:
 * quem faz isso é o proxy na frente. Por isso a flag acompanha `behindProxy`, e
 * não um valor fixo: marcada em acesso HTTP local, o navegador simplesmente não
 * devolveria o cookie e o login pararia de funcionar.
 */
export function cookieOpts(behindProxy: boolean) {
  return { ...COOKIE_OPTS, secure: behindProxy }
}

/**
 * A política de conteúdo do app.
 *
 * `'unsafe-inline'` aparece em `style-src` e só ali: o React escreve
 * `style="..."` a cada `style={{}}` e o xterm injeta a própria folha no head —
 * sem isso a interface fica sem estilo. Em `script-src` ele NÃO entra, que é
 * onde protegeria de fato; `'unsafe-eval'` também não (o bundle de produção do
 * Vite não precisa).
 *
 * `connect-src` inclui ws/wss porque o chat e os terminais vivem em WebSocket.
 * `img-src` inclui data:/blob: por causa dos ícones embutidos e das prévias de
 * upload.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * true quando já passamos da METADE da validade do token (iat..exp) — sinal
 * pra re-emitir um cookie fresco num usuário ativo, sem forçar login a cada 7
 * dias. Pura (sem I/O) pra ser testável isoladamente sem precisar forjar JWT.
 */
export function shouldRefresh(iat: number, exp: number, nowSec: number): boolean {
  return nowSec >= iat + (exp - iat) / 2
}

// Rotas alcançáveis sem token quando a auth está ativa (o /me resolve o token
// se houver, mas responde 401 amigável em vez de ser barrado no hook).
const PUBLIC = new Set([
  'POST /api/auth/login',
  'POST /api/auth/setup',
  'POST /api/auth/logout',
  'GET /api/auth/me',
])

// Escopo do token de serviço: só as APIs que o hermes MCP consome
// (list/ask/board em /api/hermes/*; dispatch/list_tasks em /api/orchestrator/*).
const SERVICE_PREFIXES = ['/api/hermes/', '/api/orchestrator/']

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * 127.0.0.0/8 inteiro, mais as formas de IPv6. O `startsWith('127.')` de antes
 * também dizia sim para `127.0.0.1.evil.com` — inalcançável na prática (o que
 * chega aqui é endereço, não nome), mas um teste que compara texto não é lugar
 * para "na prática".
 */
export function isLoopbackIp(ip: string): boolean {
  if (ip === '::1') return true
  const m = IPV4.exec(ip.startsWith('::ffff:') ? ip.slice(7) : ip)
  if (!m) return false
  const octetos = m.slice(1).map(Number)
  return octetos.every((o) => o <= 255) && octetos[0] === 127
}

/**
 * A requisição veio da PRÓPRIA máquina do servidor?
 *
 * Lê o par TCP, não `req.ip`: com `trustProxy` ligado o Fastify troca o `req.ip`
 * pelo `X-Forwarded-For`, e a decisão de segurança passaria a vir de um cabeçalho
 * que qualquer um escreve. O app hoje não liga `trustProxy` — mas o que este gate
 * libera (abrir editor, revelar arquivo, rodar `!comando`) é forte demais para
 * depender de uma opção continuar desligada.
 */
export function isLocalRequest(req: { socket?: { remoteAddress?: string } }): boolean {
  const par = req.socket?.remoteAddress
  return !!par && isLoopbackIp(par)
}

/**
 * A requisição merece os privilégios de estar NA máquina do servidor?
 *
 * Não é a mesma pergunta que `isLocalRequest`. Aquela é factual sobre o
 * transporte ("o socket é loopback?") e continua certa contra header
 * falsificável. Esta é sobre CONFIANÇA: atrás de um proxy reverso, quem conecta
 * no socket local é o próprio proxy, então "loopback" pára de significar "o dono
 * na frente do computador" e passa a significar "qualquer um na internet". As
 * rotas que rodam binário no host, e o setup do primeiro admin, dependem desta —
 * não da outra.
 */
export function isTrustedLocal(req: { socket?: { remoteAddress?: string }; behindProxy?: boolean }): boolean {
  return isLocalRequest(req) && !req.behindProxy
}

export async function registerAuth(app: FastifyInstance, deps: { auth: AuthService; insecure?: boolean; behindProxy?: boolean }): Promise<void> {
  await app.register(cookie)
  // Valor fixo por processo (não muda por request), então decorate com default
  // estático basta — sem hook. Disponível já no 1º onRequest, inclusive no gate
  // de setup abaixo.
  app.decorateRequest('behindProxy', !!deps.behindProxy)

  /**
   * Cabeçalhos de segurança em toda resposta.
   *
   * `X-Frame-Options`/`frame-ancestors`: sem eles, um site hostil embute o
   * Claudinei num iframe invisível e colhe cliques de quem já está logado — e um
   * clique aqui roda comando. `nosniff` impede o navegador de reinterpretar uma
   * resposta como script. HSTS só atrás de proxy: prometer HTTPS onde o app
   * serve HTTP trancaria o navegador fora de uma instalação local.
   */
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Frame-Options', 'DENY')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    if (deps.behindProxy) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    // Só se a rota não tiver posto a sua: as de arquivo respondem com
    // `sandbox`, que é MAIS restritivo e proposital — sobrescrever afrouxaria
    // justamente onde se serve conteúdo que o usuário enviou.
    if (!reply.getHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', CSP)
    }
    return payload
  })
  app.addHook('onRequest', async (req, reply) => {
    const rawPath = req.url.split('?')[0]
    // find-my-way (router do Fastify) decodifica percent-encoding ANTES de
    // casar a rota — ex: GET /%61pi/projects roteia para o handler real de
    // /api/projects. Comparar a string crua aqui permitia bypass total do
    // hook (achado de review: /%61pi escapava de guarded/PUBLIC/SERVICE_PREFIXES
    // sem exigir credencial). decodeURIComponent decodifica uma única vez,
    // igual ao router — não fazer loop de decode.
    let path: string
    try {
      path = decodeURIComponent(rawPath)
    } catch {
      return reply.code(400).send({ error: 'bad_request' })
    }
    const guarded = path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/')

    if (deps.auth.users.count() === 0) {
      // Pré-setup: sem credenciais no mundo — só o próprio computador entra.
      // Exceção: --insecure (rede confiável, por conta e risco) libera também
      // a LAN, cumprindo o que o guard de exposição promete para a flag.
      // isTrustedLocal, não isLocalRequest: atrás de proxy, loopback é o proxy —
      // liberar o setup aqui abriria a criação do 1º admin para a rede inteira.
      if (!isTrustedLocal(req) && !deps.insecure) {
        return reply.code(403).send({ error: 'setup_required_localhost_only' })
      }
      return
    }

    // Resolve o token mesmo em rota pública (o /me usa req.authUser se houver).
    const authz = req.headers.authorization
    const bearer = authz?.startsWith('Bearer ') ? authz.slice(7) : undefined
    const token = req.cookies?.[COOKIE_NAME] ?? bearer
    const payload = token ? deps.auth.tokens.verify(token) : null
    if (payload) {
      if (payload.sub === 'service') {
        // ver ≠ service_token_version atual = token de serviço revogado
        // (revoke-all). Tokens antigos sem ver contam como versão 0.
        if ((payload.ver ?? 0) === deps.auth.users.serviceTokenVersion()) {
          req.authUser = { kind: 'service' }
        }
      } else {
        const id = Number(payload.sub)
        const ver = payload.ver
        // ver ≠ token_version atual = token revogado (revoke-all / senha trocada)
        if (ver !== undefined && deps.auth.users.tokenVersion(id) === ver) {
          const u = deps.auth.users.get(id)
          if (u) {
            req.authUser = { kind: 'user', id: u.id, username: u.username, isAdmin: u.isAdmin, projectIds: u.projectIds }
            // Sliding refresh: usuário ativo além da metade da validade do
            // token ganha um cookie novo (mesmo TTL) — só o token de SERVIÇO
            // (ramo acima, sub === 'service') fica de fora disso.
            if (payload.iat !== undefined && payload.exp !== undefined) {
              const nowSec = Math.floor(Date.now() / 1000)
              if (shouldRefresh(payload.iat, payload.exp, nowSec)) {
                reply.setCookie(COOKIE_NAME, deps.auth.tokens.signUser(id, ver), cookieOpts(!!deps.behindProxy))
              }
            }
          }
        }
      }
    }

    if (!guarded || PUBLIC.has(`${req.method} ${path}`)) return
    if (!req.authUser) return reply.code(401).send({ error: 'unauthorized' })
    if (req.authUser.kind === 'service' && !SERVICE_PREFIXES.some((p) => path.startsWith(p))) {
      return reply.code(403).send({ error: 'service_token_scope' })
    }
  })
}
