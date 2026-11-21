import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { openDb, type Db } from '../src/db.js'
import { createPrefsService, sanitizeAppearance, sanitizeKeybindings, DEFAULT_APPEARANCE } from '../src/prefs.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { buildApp } from '../src/app.js'
import { registerPrefsRoutes } from '../src/routes/prefs.js'
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

  it('reducedMotion só aceita booleano', () => {
    expect(sanitizeAppearance({ reducedMotion: true }).reducedMotion).toBe(true)
    expect(sanitizeAppearance({ reducedMotion: 'true' }).reducedMotion).toBe(false)
  })

  /** O vidro já foi booleano: um "desligado" explícito não pode virar "do tema". */
  it('aceita o formato antigo do vidro', () => {
    expect(sanitizeAppearance({ glass: false }).glass).toBe('off')
    expect(sanitizeAppearance({ glass: true }).glass).toBe('theme')
    expect(sanitizeAppearance({ glass: 'off' }).glass).toBe('off')
  })

  it('descarta campo desconhecido em vez de guardá-lo', () => {
    expect(sanitizeAppearance({ hacker: 'x' } as never)).not.toHaveProperty('hacker')
  })
})

describe('saneamento dos atalhos', () => {
  it('aceita combinação válida e null', () => {
    expect(sanitizeKeybindings({ 'view.zen': 'Alt+M', 'triage.undo': null }))
      .toEqual({ 'view.zen': 'Alt+M', 'triage.undo': null })
  })

  /** Como na aparência: o que não passa sai, e o resto continua valendo. */
  it('descarta id ou combinação fora do formato sem recusar o resto', () => {
    const out = sanitizeKeybindings({
      'View.Zen': 'Alt+M', 'chat.send': 'Ctrl+Alt', 'chat.find': 'Mod+Shift+F', 'x': 3,
    })
    expect(out).toEqual({ 'chat.find': 'Mod+Shift+F' })
  })

  /**
   * Num literal, `'__proto__': …` troca o protótipo em vez de criar a chave — o
   * saneamento nem a veria. É o JSON.parse (o corpo do PUT, a linha do banco)
   * que cria `__proto__` como chave própria; essa tem de sair.
   */
  it('descarta a chave própria __proto__ vinda do JSON', () => {
    const input = JSON.parse('{"__proto__":"Alt+A","view.zen":"Alt+M"}') as Record<string, unknown>
    expect(Object.hasOwn(input, '__proto__')).toBe(true)
    const out = sanitizeKeybindings(input)
    expect(out).toEqual({ 'view.zen': 'Alt+M' })
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  it('guarda no máximo 64 entradas', () => {
    const input: Record<string, string> = {}
    for (let i = 0; i < 70; i++) input[`acao.n${i}`] = 'Alt+M'
    const out = sanitizeKeybindings(input)
    expect(Object.keys(out)).toEqual(Object.keys(input).slice(0, 64))
  })

  it('não objeto vale {}', () => {
    for (const v of [[], 'Alt+M', null, undefined]) expect(sanitizeKeybindings(v)).toEqual({})
  })
})

describe('serviço', () => {
  it('sem linha, os atalhos são {}', () => {
    expect(createPrefsService(db).getKeybindings(1)).toEqual({})
  })

  /** `appearance` é NOT NULL: a linha nova nasce com a aparência padrão. */
  it('gravar atalhos num usuário sem linha guarda a aparência padrão', () => {
    const prefs = createPrefsService(db)
    expect(prefs.setKeybindings(7, { 'view.zen': 'Alt+M' })).toEqual({ 'view.zen': 'Alt+M' })
    expect(prefs.get(7)).toEqual(DEFAULT_APPEARANCE)
    expect(prefs.getKeybindings(7)).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('gravar a aparência não apaga os atalhos, e vice-versa', () => {
    const prefs = createPrefsService(db)
    prefs.set(1, { theme: 'light-fun' })
    prefs.setKeybindings(1, { 'view.zen': 'Alt+M' })
    expect(prefs.get(1).theme).toBe('light-fun')
    prefs.set(1, { theme: 'dark-fun', density: 'compact' })
    expect(prefs.getKeybindings(1)).toEqual({ 'view.zen': 'Alt+M' })
    expect(prefs.get(1)).toMatchObject({ theme: 'dark-fun', density: 'compact' })
  })

  it('JSON corrompido na coluna vale {}', () => {
    const prefs = createPrefsService(db)
    prefs.setKeybindings(1, { 'view.zen': 'Alt+M' })
    db.prepare(`UPDATE user_prefs SET keybindings='{' WHERE user_id=1`).run()
    expect(prefs.getKeybindings(1)).toEqual({})
  })

  it('banco antigo ganha a coluna ao abrir', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'prefs-antigo-')), 'app.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE user_prefs (user_id INTEGER PRIMARY KEY, appearance TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    old.prepare(`INSERT INTO user_prefs (user_id, appearance) VALUES (3, ?)`).run(JSON.stringify({ theme: 'light-fun' }))
    old.close()

    const prefs = createPrefsService(openDb(file))
    expect(prefs.getKeybindings(3)).toEqual({})
    expect(prefs.setKeybindings(3, { 'triage.undo': null })).toEqual({ 'triage.undo': null })
    expect(prefs.getKeybindings(3)).toEqual({ 'triage.undo': null })
    expect(prefs.get(3).theme).toBe('light-fun')
  })

  it('sem linha, devolve o padrão', () => {
    expect(createPrefsService(db).get(1)).toEqual(DEFAULT_APPEARANCE)
  })

  it('guarda e devolve por usuário, sem um ver o do outro', () => {
    const prefs = createPrefsService(db)
    prefs.set(1, { theme: 'light-fun' })
    prefs.set(2, { theme: 'dark-fun', density: 'compact' })
    expect(prefs.get(1).theme).toBe('light-fun')
    expect(prefs.get(1).density).toBe('theme')   // não escolheu: manda o pacote
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

  it('GET devolve aparência e atalhos', async () => {
    const ana = await login('ana')
    const body = (await app.inject({ method: 'GET', url: '/api/prefs', cookies: ana })).json()
    expect(body).toHaveProperty('appearance')
    expect(body.keybindings).toEqual({})
  })

  it('PUT só com keybindings não mexe na aparência', async () => {
    const ana = await login('ana')
    await app.inject({ method: 'PUT', url: '/api/prefs', payload: { appearance: { theme: 'light-fun' } }, cookies: ana })
    const put = await app.inject({ method: 'PUT', url: '/api/prefs', payload: { keybindings: { 'view.zen': 'Alt+M' } }, cookies: ana })
    expect(put.json()).toMatchObject({ appearance: { theme: 'light-fun' }, keybindings: { 'view.zen': 'Alt+M' } })
    const body = (await app.inject({ method: 'GET', url: '/api/prefs', cookies: ana })).json()
    expect(body.appearance.theme).toBe('light-fun')
    expect(body.keybindings).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('PUT só com appearance não mexe nos atalhos', async () => {
    const ana = await login('ana')
    await app.inject({ method: 'PUT', url: '/api/prefs', payload: { keybindings: { 'view.zen': 'Alt+M' } }, cookies: ana })
    const put = await app.inject({ method: 'PUT', url: '/api/prefs', payload: { appearance: { theme: 'light-fun' } }, cookies: ana })
    expect(put.json().keybindings).toEqual({ 'view.zen': 'Alt+M' })
    const body = (await app.inject({ method: 'GET', url: '/api/prefs', cookies: ana })).json()
    expect(body.appearance.theme).toBe('light-fun')
    expect(body.keybindings).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('PUT vazio não muda nada e devolve os dois', async () => {
    const ana = await login('ana')
    await app.inject({
      method: 'PUT', url: '/api/prefs',
      payload: { appearance: { theme: 'light-fun' }, keybindings: { 'view.zen': 'Alt+M' } }, cookies: ana,
    })
    const put = await app.inject({ method: 'PUT', url: '/api/prefs', payload: {}, cookies: ana })
    expect(put.statusCode).toBe(200)
    expect(put.json().appearance.theme).toBe('light-fun')
    expect(put.json().keybindings).toEqual({ 'view.zen': 'Alt+M' })
  })

  it('PUT com keybindings que não é objeto dá 400 e não apaga nada', async () => {
    const ana = await login('ana')
    await app.inject({ method: 'PUT', url: '/api/prefs', payload: { keybindings: { 'view.zen': 'Alt+M' } }, cookies: ana })

    const a = await app.inject({ method: 'PUT', url: '/api/prefs', payload: { keybindings: [] }, cookies: ana })
    expect(a.statusCode).toBe(400)
    expect(a.json()).toEqual({ error: 'keybindings inválido' })
    const b = await app.inject({
      method: 'PUT', url: '/api/prefs', payload: { keybindings: null, appearance: { theme: 'light-fun' } }, cookies: ana,
    })
    expect(b.statusCode).toBe(400)

    const body = (await app.inject({ method: 'GET', url: '/api/prefs', cookies: ana })).json()
    expect(body.keybindings).toEqual({ 'view.zen': 'Alt+M' })
    expect(body.appearance.theme).toBe(DEFAULT_APPEARANCE.theme)
  })

  /**
   * O escopo do token de serviço (auth/plugin.ts) já barra /api/prefs inteiro; a
   * rota, sozinha, também não deixa o token ler nem gravar preferências de ninguém.
   */
  it('token de serviço: GET devolve {} e PUT dá 403', async () => {
    const authorization = `Bearer ${auth.tokens.signService()}`
    expect((await app.inject({ method: 'GET', url: '/api/prefs', headers: { authorization } })).statusCode).toBe(403)

    const nua = Fastify()
    nua.addHook('onRequest', async (req) => { (req as any).authUser = { kind: 'service' } })
    registerPrefsRoutes(nua, { prefs: createPrefsService(db) })
    const get = await nua.inject({ method: 'GET', url: '/api/prefs' })
    expect(get.json()).toEqual({ appearance: DEFAULT_APPEARANCE, keybindings: {} })
    const put = await nua.inject({ method: 'PUT', url: '/api/prefs', payload: { keybindings: { 'view.zen': 'Alt+M' } } })
    expect(put.statusCode).toBe(403)
    await nua.close()
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_prefs').get() as { n: number }).n).toBe(0)
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
