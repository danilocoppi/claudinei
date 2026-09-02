import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { cookieOpts } from '../src/auth/plugin.js'

/**
 * Endurecimento para acesso externo (itens do laudo de risco).
 *
 * Estes só ligam atrás de proxy — que é o único cenário em que existe TLS nesta
 * arquitetura (o app não termina HTTPS; quem faz isso é o nginx/Caddy na frente).
 * Ligá-los em acesso HTTP local quebraria o login: o navegador simplesmente não
 * manda um cookie `Secure` por HTTP.
 */
describe('flags do cookie de sessão', () => {
  it('sem proxy: sem Secure, senão o cookie não voltaria por HTTP local', () => {
    expect(cookieOpts(false)).toMatchObject({ httpOnly: true, sameSite: 'strict', secure: false })
  })

  it('com proxy: Secure ligado — o TLS termina no proxy e o cookie não pode vazar em claro', () => {
    expect(cookieOpts(true)).toMatchObject({ httpOnly: true, sameSite: 'strict', secure: true })
  })

  /** Não são negociáveis em nenhum modo: XSS não lê o cookie, e CSRF não o envia. */
  it('httpOnly e sameSite valem sempre', () => {
    for (const opts of [cookieOpts(false), cookieOpts(true)]) {
      expect(opts.httpOnly).toBe(true)
      expect(opts.sameSite).toBe('strict')
      expect(opts.path).toBe('/')
    }
  })
})

describe('cabeçalhos de segurança', () => {
  let db: Db
  let auth: AuthService

  beforeEach(() => {
    db = openDb(':memory:')
    auth = createAuthService({ db })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  })

  const makeApp = (behindProxy: boolean) =>
    buildApp({ config: loadConfig({}), db, auth, behindProxy, manager: createSessionManager({ db, broadcast: () => {} }) })

  const headersDe = async (behindProxy: boolean) => {
    const app = await makeApp(behindProxy)
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '127.0.0.1' })
    await app.close()
    return res.headers as Record<string, string>
  }

  /**
   * Clickjacking: sem isto, um site hostil embute o Claudinei num iframe
   * invisível e coleta cliques de quem já está logado — e aqui um clique roda
   * comando. Vale sempre, inclusive local.
   */
  it('recusa ser embutido em iframe, e não deixa o navegador adivinhar tipo', async () => {
    const h = await headersDe(false)
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['referrer-policy']).toBeTruthy()
  })

  /** HSTS só faz sentido onde há HTTPS: prometer isso em HTTP local trancaria o
   *  navegador num esquema que o app não serve. */
  it('HSTS só atrás de proxy', async () => {
    expect((await headersDe(false))['strict-transport-security']).toBeUndefined()
    expect((await headersDe(true))['strict-transport-security']).toMatch(/max-age=\d+/)
  })
})

/**
 * CSP: a rede de contenção contra XSS. Um script injetado neste app não rouba
 * "só" dados — ele fala com uma API que executa comandos.
 *
 * `'unsafe-inline'` em style-src é inevitável aqui: o React escreve `style="..."`
 * a cada `style={{}}`, e o xterm injeta uma folha própria no head. Em script-src
 * NÃO entra — que é onde ele realmente importaria.
 */
describe('Content-Security-Policy', () => {
  let db: Db
  let auth: AuthService

  beforeEach(() => {
    db = openDb(':memory:')
    auth = createAuthService({ db })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  })

  const csp = async (url: string) => {
    const app = await buildApp({
      config: loadConfig({}), db, auth,
      manager: createSessionManager({ db, broadcast: () => {} }),
    })
    const res = await app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' })
    await app.close()
    return { header: (res.headers as any)['content-security-policy'] as string | undefined, code: res.statusCode }
  }

  it('script só da própria origem, e nada de eval', async () => {
    const { header } = await csp('/api/auth/me')
    expect(header).toContain("script-src 'self'")
    expect(header, 'unsafe-eval abriria a porta que a CSP veio fechar').not.toContain('unsafe-eval')
  })

  it('bloqueia ser embutido, igual ao X-Frame-Options', async () => {
    expect((await csp('/api/auth/me')).header).toContain("frame-ancestors 'none'")
  })

  /** O WebSocket é o transporte do chat e dos terminais: sem isto, tudo cai. */
  it('permite o WebSocket da própria origem', async () => {
    const h = (await csp('/api/auth/me')).header!
    expect(h).toMatch(/connect-src[^;]*'self'/)
    expect(h).toMatch(/connect-src[^;]*ws/)
  })
})

/**
 * Os cabeçalhos também não podem depender de auth configurada.
 *
 * O hook nasceu dentro do `registerAuth`, que só roda `if (deps.auth)` — então
 * no modo pré-setup (zero usuários, antes do primeiro admin) a aplicação era
 * servida SEM nenhum deles. É uma janela curta, mas é justamente a janela em que
 * qualquer visitante pode criar o admin.
 */
describe('cabeçalhos sem auth configurada', () => {
  it('valem mesmo antes do primeiro usuário', async () => {
    const db = openDb(':memory:')
    const app = await buildApp({
      config: loadConfig({}), db,
      manager: createSessionManager({ db, broadcast: () => {} }),
    })
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1' })
    const h = res.headers as Record<string, string>
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
    await app.close()
  })
})

/**
 * `Secure` e HSTS seguem o TRANSPORTE, não a topologia.
 *
 * Nasceram presos a `behindProxy` porque, na época, proxy era o único jeito de
 * ter TLS. Com HTTPS nativo isso ficou errado nos dois sentidos: sem proxy mas
 * com TLS próprio, o cookie sairia sem `Secure` numa conexão que É segura.
 */
describe('transporte seguro sem proxy', () => {
  let db: Db
  let auth: AuthService

  beforeEach(() => {
    db = openDb(':memory:')
    auth = createAuthService({ db })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
  })

  it('HTTPS nativo marca o cookie como Secure e manda HSTS', async () => {
    const app = await buildApp({
      config: loadConfig({}), db, auth, secureTransport: true,
      manager: createSessionManager({ db, broadcast: () => {} }),
    })
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1',
      payload: { username: 'root', password: 'abcd1234' },
    })
    const c = res.cookies.find((x: any) => x.name === 'claudinei_token') as any
    expect(c.secure, 'cookie sem Secure numa conexão HTTPS').toBe(true)
    expect((res.headers as any)['strict-transport-security']).toMatch(/max-age/)
    await app.close()
  })

  /** HTTP simples continua sem Secure — senão o login local pararia de funcionar. */
  it('HTTP puro continua sem Secure', async () => {
    const app = await buildApp({
      config: loadConfig({}), db, auth,
      manager: createSessionManager({ db, broadcast: () => {} }),
    })
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1',
      payload: { username: 'root', password: 'abcd1234' },
    })
    const c = res.cookies.find((x: any) => x.name === 'claudinei_token') as any
    expect(c.secure).toBeFalsy()
    expect((res.headers as any)['strict-transport-security']).toBeUndefined()
    await app.close()
  })
})
