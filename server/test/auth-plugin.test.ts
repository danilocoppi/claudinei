import { describe, it, expect, beforeEach } from 'vitest'
import { createSigner } from 'fast-jwt'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { COOKIE_NAME, shouldRefresh } from '../src/auth/plugin.js'
import { loadOrCreateSecret, USER_TTL_MS } from '../src/auth/tokens.js'

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let auth: AuthService

beforeEach(async () => {
  db = openDb(':memory:')
  auth = createAuthService({ db })
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager, auth })
})

const login = async (username: string, password: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
  const cookie = res.cookies.find((c) => c.name === COOKIE_NAME)
  return { res, cookie: (cookie ? { [COOKIE_NAME]: cookie.value } : {}) as Record<string, string> }
}

describe('pré-setup (0 usuários)', () => {
  it('loopback tem acesso livre (comportamento atual preservado)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(200)
  })

  it('não-loopback leva 403 setup_required_localhost_only em QUALQUER rota', async () => {
    for (const url of ['/api/projects', '/api/health', '/qualquer-asset.js']) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: '192.168.1.50' })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toBe('setup_required_localhost_only')
    }
  })
})

describe('configurado (≥1 usuário)', () => {
  beforeEach(() => { auth.users.create({ username: 'root', password: 'abcd', isAdmin: true }) })

  it('sem token: /api/* → 401; assets do SPA passam; login é público', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401)
    // rota inexistente fora de /api não é barrada pelo hook (404 do fastify, não 401)
    expect((await app.inject({ method: 'GET', url: '/assets/x.js' })).statusCode).toBe(404)
    const { res } = await login('root', 'abcd')
    expect(res.statusCode).toBe(200)
  })

  it('cookie válido passa; token com ver antigo (revogado) → 401', async () => {
    const { cookie } = await login('root', 'abcd')
    expect((await app.inject({ method: 'GET', url: '/api/projects', cookies: cookie })).statusCode).toBe(200)
    auth.users.revokeAll()
    expect((await app.inject({ method: 'GET', url: '/api/projects', cookies: cookie })).statusCode).toBe(401)
  })

  it('token de usuário excluído → 401', async () => {
    const u = auth.users.create({ username: 'ana', password: 'abcd' })
    const { cookie } = await login('ana', 'abcd')
    auth.users.remove(u.id)
    expect((await app.inject({ method: 'GET', url: '/api/sessions', cookies: cookie })).statusCode).toBe(401)
  })

  it('bearer de serviço passa em hermes/orchestrator e 403 no resto', async () => {
    const h = { authorization: `Bearer ${auth.tokens.signService()}` }
    expect((await app.inject({ method: 'GET', url: '/api/hermes/projects', headers: h })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/orchestrator/tasks', headers: h })).statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: h })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('service_token_scope')
  })

  it('path percent-encoded não contorna o hook (/%61pi = /api)', async () => {
    expect((await app.inject({ method: 'GET', url: '/%61pi/projects' })).statusCode).toBe(401)
  })

  it('path com encoding inválido responde 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/%zz' })).statusCode).toBe(400)
  })
})

describe('shouldRefresh (lógica pura da metade da validade)', () => {
  it('antes da metade → false', () => {
    const iat = 1000
    const exp = 2000 // validade de 1000s, metade = 1500
    expect(shouldRefresh(iat, exp, 1499)).toBe(false)
  })

  it('exatamente na metade → true (limite inclusivo)', () => {
    expect(shouldRefresh(1000, 2000, 1500)).toBe(true)
  })

  it('depois da metade (mas ainda não expirado) → true', () => {
    expect(shouldRefresh(1000, 2000, 1999)).toBe(true)
  })

  it('recém emitido (nowSec == iat) → false', () => {
    expect(shouldRefresh(1000, 2000, 1000)).toBe(false)
  })
})

describe('sliding refresh do cookie (hook onRequest)', () => {
  it('token de usuário além da metade da validade → hook reemite Set-Cookie novo; token recém-emitido não reemite', async () => {
    // Precisa do MESMO segredo usado pelo TokenService da app pra forjar um
    // token "velho" válido — por isso secretPath (persistido em disco) em vez
    // do segredo aleatório em memória do createAuthService padrão dos outros testes.
    const secretDir = mkdtempSync(join(tmpdir(), 'auth-secret-'))
    const secretPath = join(secretDir, 'secret')
    const localAuth = createAuthService({ db, secretPath })
    const user = localAuth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
    const manager = createSessionManager({ db, broadcast: () => {} })
    const localApp = await buildApp({ config: loadConfig({}), db, manager, auth: localAuth })

    const secret = loadOrCreateSecret(secretPath)
    const ver = localAuth.users.tokenVersion(user.id)!
    const nowSec = Math.floor(Date.now() / 1000)

    // "velho": emitido a 60% da validade atrás — já passou da metade, ainda não expirou.
    const oldIat = nowSec - Math.floor((USER_TTL_MS / 1000) * 0.6)
    const signOld = createSigner({ key: secret, clockTimestamp: oldIat * 1000, expiresIn: USER_TTL_MS })
    const oldToken = signOld({ sub: String(user.id), ver })

    // "novo": acabou de ser emitido pelo TokenService de verdade.
    const newToken = localAuth.tokens.signUser(user.id, ver)

    const resOld = await localApp.inject({ method: 'GET', url: '/api/projects', cookies: { [COOKIE_NAME]: oldToken } })
    expect(resOld.statusCode).toBe(200)
    const freshCookie = resOld.cookies.find((c) => c.name === COOKIE_NAME)
    expect(freshCookie).toBeTruthy()
    expect(freshCookie!.value).not.toBe(oldToken)
    expect(freshCookie!.httpOnly).toBe(true)
    expect(String(freshCookie!.sameSite).toLowerCase()).toBe('strict')

    const resNew = await localApp.inject({ method: 'GET', url: '/api/projects', cookies: { [COOKIE_NAME]: newToken } })
    expect(resNew.statusCode).toBe(200)
    expect(resNew.cookies.find((c) => c.name === COOKIE_NAME)).toBeUndefined()

    await localApp.close()
  })

  it('token de SERVIÇO não é refreshado mesmo que a rota passe', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'auth-secret-svc-'))
    const secretPath = join(secretDir, 'secret')
    const localAuth = createAuthService({ db, secretPath })
    localAuth.users.create({ username: 'root', password: 'abcd', isAdmin: true })
    const manager = createSessionManager({ db, broadcast: () => {} })
    const localApp = await buildApp({ config: loadConfig({}), db, manager, auth: localAuth })

    const serviceToken = localAuth.tokens.signService()
    const res = await localApp.inject({ method: 'GET', url: '/api/hermes/projects', headers: { authorization: `Bearer ${serviceToken}` } })
    expect(res.statusCode).toBe(200)
    expect(res.cookies.find((c) => c.name === COOKIE_NAME)).toBeUndefined()

    await localApp.close()
  })
})
