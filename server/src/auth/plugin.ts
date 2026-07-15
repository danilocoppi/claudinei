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
  }
}

export const COOKIE_NAME = 'claudinei_token'

// Flags do cookie de sessão — usado tanto pelas rotas que fazem login/troca de
// senha (routes.ts) quanto pelo hook de sliding refresh abaixo, pra nunca
// divergir os dois pontos que emitem o cookie.
export const COOKIE_OPTS = { httpOnly: true, sameSite: 'strict' as const, path: '/', maxAge: 7 * 24 * 3600 }

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

export function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')
}

export async function registerAuth(app: FastifyInstance, deps: { auth: AuthService }): Promise<void> {
  await app.register(cookie)
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
      if (!isLoopbackIp(req.ip)) {
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
        req.authUser = { kind: 'service' }
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
                reply.setCookie(COOKIE_NAME, deps.auth.tokens.signUser(id, ver), COOKIE_OPTS)
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
