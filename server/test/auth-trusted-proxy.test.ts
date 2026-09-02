import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { isTrustedLocal, isLocalRequest } from '../src/auth/plugin.js'

/**
 * O gate "veio da própria máquina" atrás de um proxy reverso.
 *
 * `isLocalRequest` lê o IP do SOCKET — e faz certo, contra header falsificável.
 * Mas quando um nginx/Caddy termina o TLS e encaminha, quem conecta no socket é
 * o PROXY, em 127.0.0.1. Então toda requisição externa "parece local", e o setup
 * do primeiro admin (que confia nesse gate) fica aberto para a rede inteira —
 * verificado por exploração antes desta correção.
 *
 * `isTrustedLocal` separa as duas perguntas: "o socket é loopback?" continua
 * sendo `isLocalRequest`; "esta requisição merece os privilégios de estar na
 * máquina?" passa a exigir TAMBÉM que não haja proxy na frente. Ligado o
 * `--behind-proxy`, loopback deixa de ser prova de dono.
 */
describe('isTrustedLocal', () => {
  const req = (ip: string, behindProxy?: boolean) =>
    ({ socket: { remoteAddress: ip }, behindProxy }) as never

  it('sem proxy: loopback é confiável, rede não', () => {
    expect(isTrustedLocal(req('127.0.0.1'))).toBe(true)
    expect(isTrustedLocal(req('::1'))).toBe(true)
    expect(isTrustedLocal(req('192.168.0.10'))).toBe(false)
  })

  it('com proxy: nem loopback é confiável — é onde o proxy conecta', () => {
    expect(isTrustedLocal(req('127.0.0.1', true))).toBe(false)
    expect(isTrustedLocal(req('::1', true))).toBe(false)
  })

  /** A pergunta factual sobre o transporte não muda com o proxy. */
  it('isLocalRequest continua respondendo só sobre o socket', () => {
    expect(isLocalRequest(req('127.0.0.1'))).toBe(true)
    expect(isLocalRequest(req('127.0.0.1', true))).toBe(true)
  })
})

describe('setup do primeiro admin atrás de proxy', () => {
  let db: Db
  let auth: AuthService

  beforeEach(() => {
    db = openDb(':memory:')
    auth = createAuthService({ db })
  })

  const makeApp = (behindProxy: boolean) =>
    buildApp({ config: loadConfig({}), db, manager: createSessionManager({ db, broadcast: () => {} }), auth, behindProxy })

  /** O furo: sem a defesa, esta chamada — vinda de loopback, como o proxy — criava
   *  o admin para um atacante remoto. */
  it('bloqueia o setup mesmo vindo de loopback quando há proxy', async () => {
    const app = await makeApp(true)
    const res = await app.inject({
      method: 'POST', url: '/api/auth/setup', remoteAddress: '127.0.0.1',
      payload: { username: 'invasor', password: 'abcd1234' },
    })
    expect(res.statusCode).toBe(403)
    expect(auth.configured()).toBe(false)
    await app.close()
  })

  /** Sem proxy, o setup local segue funcionando: é o fluxo do dono na própria máquina. */
  it('permite o setup local quando não há proxy', async () => {
    const app = await makeApp(false)
    const res = await app.inject({
      method: 'POST', url: '/api/auth/setup', remoteAddress: '127.0.0.1',
      payload: { username: 'dono', password: 'abcd1234' },
    })
    expect(res.statusCode).toBe(201)
    expect(auth.configured()).toBe(true)
    await app.close()
  })
})

describe('rotas de execução no host atrás de proxy', () => {
  let db: Db
  let auth: AuthService

  beforeEach(() => {
    db = openDb(':memory:')
    auth = createAuthService({ db })
  })

  /**
   * `/api/local-apps` responde `local:false` atrás de proxy — a UI esconde os
   * botões de abrir pasta/VS Code/terminal, e o servidor recusa a execução. São
   * as portas que rodam binário no host; loopback-via-proxy não as merece.
   */
  it('local-apps reporta local:false mesmo vindo de loopback', async () => {
    // um admin autenticado, para isolar o efeito do proxy (e não do login)
    const app = await buildApp({
      config: loadConfig({}), db, auth, behindProxy: true,
      manager: createSessionManager({ db, broadcast: () => {} }),
    })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1', payload: { username: 'root', password: 'abcd1234' } })
    const cookie = login.cookies.find((c: any) => c.name === 'claudinei_token')
    const res = await app.inject({
      method: 'GET', url: '/api/local-apps', remoteAddress: '127.0.0.1',
      cookies: { claudinei_token: cookie!.value },
    })
    expect(res.json().local).toBe(false)
    await app.close()
  })
})

/**
 * A decoração `behindProxy` tem de existir mesmo SEM auth configurada.
 *
 * Ela morava dentro do `if (deps.auth)` do buildApp. Num app sem auth — o modo
 * pré-setup, antes do primeiro usuário —, `req.behindProxy` ficava undefined e
 * `isTrustedLocal` degradava para `isLocalRequest`: atrás de proxy, tudo volta a
 * parecer local. Descoberto porque o `!comando` executou num teste de WS que não
 * passava `auth`.
 */
describe('a flag vale mesmo sem auth configurada', () => {
  it('rotas de host recusam atrás de proxy num app sem auth', async () => {
    const db = openDb(':memory:')
    const app = await buildApp({
      config: loadConfig({}), db, behindProxy: true,
      manager: createSessionManager({ db, broadcast: () => {} }),
    })
    // sem `auth`, o hook de autenticação nem existe — o gate de host tem de
    // continuar valendo por conta própria
    const res = await app.inject({ method: 'GET', url: '/api/local-apps', remoteAddress: '127.0.0.1' })
    expect(res.json().local, 'sem auth, a flag de proxy foi ignorada').toBe(false)
    await app.close()
  })
})
