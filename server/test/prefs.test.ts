import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createPrefsService, sanitizeAppearance, DEFAULT_APPEARANCE } from '../src/prefs.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'

let db: Db

beforeEach(() => { db = openDb(':memory:') })

describe('saneamento da aparência', () => {
  it('preenche o que falta com o padrão', () => {
    expect(sanitizeAppearance({})).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE)
  })

  /**
   * Cair no padrão em vez de recusar: um valor que este servidor não conhece — de
   * um cliente mais novo ou de um pacote de tema removido — não pode deixar o
   * usuário preso numa tela que não carrega.
   */
  it('troca por padrão o que não parece uma chave, sem recusar o resto', () => {
    const out = sanitizeAppearance({ theme: 'light-fun', density: 'ESTRANHO; color: red', accent: 42 })
    expect(out.theme).toBe('light-fun')
    expect(out.density).toBe(DEFAULT_APPEARANCE.density)
    expect(out.accent).toBe(DEFAULT_APPEARANCE.accent)
  })

  /** Nada daqui pode escapar de um atributo ou de uma variável de CSS no cliente. */
  it('recusa chave com caractere capaz de escapar do CSS', () => {
    for (const evil of ['a}b', 'a;b', 'a b', 'url(x)', 'A'.repeat(33), '<script>']) {
      expect(sanitizeAppearance({ theme: evil }).theme).toBe(DEFAULT_APPEARANCE.theme)
    }
  })

  it('booleanos só aceitam booleano', () => {
    expect(sanitizeAppearance({ glass: false }).glass).toBe(false)
    expect(sanitizeAppearance({ glass: 'false' }).glass).toBe(true)   // string não vale
  })

  it('descarta campo desconhecido em vez de guardá-lo', () => {
    expect(sanitizeAppearance({ hacker: 'x' } as never)).not.toHaveProperty('hacker')
  })
})

describe('serviço', () => {
  it('sem linha, devolve o padrão', () => {
    expect(createPrefsService(db).get(1)).toEqual(DEFAULT_APPEARANCE)
  })

  it('guarda e devolve por usuário, sem um ver o do outro', () => {
    const prefs = createPrefsService(db)
    prefs.set(1, { theme: 'light-fun' })
    prefs.set(2, { theme: 'dark-fun', density: 'compact' })
    expect(prefs.get(1).theme).toBe('light-fun')
    expect(prefs.get(1).density).toBe('comfortable')
    expect(prefs.get(2).density).toBe('compact')
  })

  it('salvar duas vezes atualiza a mesma linha', () => {
    const prefs = createPrefsService(db)
    prefs.set(1, { theme: 'light-fun' })
    prefs.set(1, { theme: 'dark-fun' })
    expect(prefs.get(1).theme).toBe('dark-fun')
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_prefs').get() as any).n).toBe(1)
  })

  /** JSON corrompido no banco não pode derrubar a tela de ninguém. */
  it('linha corrompida cai no padrão em vez de estourar', () => {
    const prefs = createPrefsService(db)
    db.prepare(`INSERT INTO user_prefs (user_id, appearance) VALUES (1, 'isto não é json')`).run()
    expect(prefs.get(1)).toEqual(DEFAULT_APPEARANCE)
  })
})

describe('rotas /api/prefs', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let auth: AuthService
  const cookieOf = (res: any): Record<string, string> => {
    const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
    return c ? { [COOKIE_NAME]: c.value } : {}
  }
  const login = async (username: string) =>
    cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))

  beforeEach(async () => {
    auth = createAuthService({ db })
    app = await buildApp({ config: loadConfig({}), db, manager: createSessionManager({ db, broadcast: () => {} }), auth })
    auth.users.create({ username: 'ana', password: 'abcd1234', isAdmin: true })
    auth.users.create({ username: 'bruno', password: 'abcd1234' })
  })

  it('cada usuário lê e grava a sua', async () => {
    const ana = await login('ana')
    const bruno = await login('bruno')
    await app.inject({ method: 'PUT', url: '/api/prefs', payload: { appearance: { theme: 'light-fun' } }, cookies: ana })

    expect((await app.inject({ method: 'GET', url: '/api/prefs', cookies: ana })).json().appearance.theme).toBe('light-fun')
    expect((await app.inject({ method: 'GET', url: '/api/prefs', cookies: bruno })).json().appearance.theme).toBe('dark-fun')
  })

  it('o PUT devolve o objeto já saneado, para cliente e servidor não discordarem', async () => {
    const ana = await login('ana')
    const res = await app.inject({
      method: 'PUT', url: '/api/prefs',
      payload: { appearance: { theme: 'light-fun', radius: 'inválido!' } }, cookies: ana,
    })
    expect(res.json().appearance).toMatchObject({ theme: 'light-fun', radius: DEFAULT_APPEARANCE.radius })
  })

  it('sem auth, grava na linha 0 e continua funcionando', async () => {
    const open = await buildApp({ config: loadConfig({}), db: openDb(':memory:'), manager: createSessionManager({ db, broadcast: () => {} }) })
    await open.inject({ method: 'PUT', url: '/api/prefs', payload: { appearance: { theme: 'light-fun' } } })
    expect((await open.inject({ method: 'GET', url: '/api/prefs' })).json().appearance.theme).toBe('light-fun')
  })
})

describe('limpeza', () => {
  it('apagar o usuário apaga a aparência dele', () => {
    const auth = createAuthService({ db })
    const prefs = createPrefsService(db)
    auth.users.create({ username: 'admin', password: 'abcd1234', isAdmin: true })
    const vitima = auth.users.create({ username: 'vitima', password: 'abcd1234' })
    prefs.set(vitima.id, { theme: 'light-fun' })
    auth.users.remove(vitima.id)
    expect(prefs.get(vitima.id)).toEqual(DEFAULT_APPEARANCE)
  })
})
