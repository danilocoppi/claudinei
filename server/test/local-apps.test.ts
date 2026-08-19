import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { availableApps, launchApp, resolveLauncher } from '../src/localApps.js'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'

/** Só estes binários "existem" na máquina de mentira. */
const has = (...bins: string[]) => (bin: string) => bins.includes(bin)

describe('escolha do comando', () => {
  it('pasta: cada sistema tem o seu', () => {
    expect(resolveLauncher('folder', '/p', { platform: 'linux', available: has('xdg-open') })?.cmd).toBe('xdg-open')
    expect(resolveLauncher('folder', '/p', { platform: 'darwin', available: has('open') })?.cmd).toBe('open')
    expect(resolveLauncher('folder', '/p', { platform: 'win32', available: has('explorer') })?.cmd).toBe('explorer')
  })

  it('vscode cai no codium quando só ele está instalado', () => {
    expect(resolveLauncher('vscode', '/p', { platform: 'linux', available: has('code', 'codium') })?.cmd).toBe('code')
    expect(resolveLauncher('vscode', '/p', { platform: 'linux', available: has('codium') })?.cmd).toBe('codium')
  })

  /**
   * Terminal no Linux não tem padrão. `x-terminal-emulator` vem primeiro porque é
   * a alternativa do sistema — respeitá-la é respeitar a escolha que o usuário já
   * fez, em vez de impor o terminal de um desktop específico.
   */
  it('terminal no linux prefere a alternativa do sistema, e desce a lista', () => {
    const all = has('x-terminal-emulator', 'gnome-terminal', 'konsole')
    expect(resolveLauncher('terminal', '/p', { platform: 'linux', available: all })?.cmd).toBe('x-terminal-emulator')
    expect(resolveLauncher('terminal', '/p', { platform: 'linux', available: has('konsole') })?.cmd).toBe('konsole')
  })

  it('a pasta vai como argumento, não interpolada num comando', () => {
    const l = resolveLauncher('terminal', '/tmp/meu projeto', { platform: 'linux', available: has('gnome-terminal') })
    expect(l!.args).toContain('/tmp/meu projeto')
  })

  it('sem nada instalado, não há o que abrir', () => {
    expect(resolveLauncher('vscode', '/p', { platform: 'linux', available: () => false })).toBeNull()
  })
})

describe('o que a máquina oferece', () => {
  it('lista só o que está instalado', () => {
    expect(availableApps({ platform: 'linux', available: has('xdg-open', 'code') }))
      .toEqual({ folder: true, vscode: true, terminal: false })
  })

  it('máquina pelada não oferece nada', () => {
    expect(availableApps({ platform: 'linux', available: () => false }))
      .toEqual({ folder: false, vscode: false, terminal: false })
  })
})

describe('disparo', () => {
  it('solta o processo para o Claudinei não ficar preso a ele', () => {
    const child = { unref: vi.fn() }
    const spawnFn = vi.fn(() => child) as never
    launchApp('folder', '/tmp/x', { platform: 'linux', available: has('xdg-open'), spawnFn })
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', ['/tmp/x'], { detached: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalled()
  })

  it('sem candidato instalado, falha dizendo o porquê', () => {
    expect(() => launchApp('vscode', '/p', { platform: 'linux', available: () => false, spawnFn: vi.fn() as never }))
      .toThrow(/nada instalado/)
  })
})

describe('rotas', () => {
  let db: Db
  let app: Awaited<ReturnType<typeof buildApp>>
  let auth: AuthService
  let meu: Project, alheio: Project
  const opened: string[] = []

  const cookieOf = (res: any): Record<string, string> => {
    const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
    return c ? { [COOKIE_NAME]: c.value } : {}
  }
  const login = async (username: string) =>
    cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'abcd1234' } }))

  beforeEach(async () => {
    db = openDb(':memory:')
    opened.length = 0
    const projects = createProjectsService(db)
    meu = projects.create({ name: 'meu', path: mkdtempSync(join(tmpdir(), 'la-')) })
    alheio = projects.create({ name: 'alheio', path: mkdtempSync(join(tmpdir(), 'la-')) })
    auth = createAuthService({ db })
    app = await buildApp({
      config: loadConfig({}), db, manager: createSessionManager({ db, broadcast: () => {} }), auth,
      localApps: { available: () => true, platform: 'linux', launch: (a, dir) => { opened.push(`${a}:${dir}`) } },
    })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [meu.id] })
  })

  it('abre a pasta do projeto', async () => {
    const admin = await login('root')
    const res = await app.inject({ method: 'POST', url: `/api/projects/${meu.id}/open`, payload: { action: 'folder' }, cookies: admin })
    expect(res.statusCode).toBe(200)
    expect(opened).toEqual([`folder:${meu.path}`])
  })

  /** Esconder o item na UI não impede ninguém de chamar a rota direto. */
  it('recusa ação desconhecida em vez de repassá-la ao sistema', async () => {
    const admin = await login('root')
    for (const action of ['rm', 'folder; rm -rf /', '', null]) {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${meu.id}/open`, payload: { action }, cookies: admin })
      expect(res.statusCode, String(action)).toBe(400)
    }
    expect(opened).toEqual([])
  })

  it('terminal alheio é 403', async () => {
    const ana = await login('ana')
    const res = await app.inject({ method: 'POST', url: `/api/projects/${alheio.id}/open`, payload: { action: 'folder' }, cookies: ana })
    expect(res.statusCode).toBe(403)
    expect(opened).toEqual([])
  })

  it('projeto inexistente é 404', async () => {
    const admin = await login('root')
    expect((await app.inject({ method: 'POST', url: '/api/projects/999/open', payload: { action: 'folder' }, cookies: admin })).statusCode).toBe(404)
  })

  it('GET diz o que a máquina oferece', async () => {
    const admin = await login('root')
    expect((await app.inject({ method: 'GET', url: '/api/local-apps', cookies: admin })).json())
      .toEqual({ folder: true, vscode: true, terminal: true })
  })
})

/**
 * O caminho vem de `project.path`, que um admin digita ao criar o terminal. Não é
 * entrada anônima, mas também não é constante do código — e as duas brechas abaixo
 * transformam "caminho estranho" em "programa diferente do que eu pedi".
 */
describe('o caminho não pode virar comando', () => {
  const spawnFn = () => vi.fn(() => ({ unref: vi.fn() })) as never

  /**
   * Caminho começando com "-" é lido como FLAG pelo programa, não como pasta.
   * Em `xdg-open` seria inofensivo; em `code` não — o VS Code tem flags que
   * instalam extensão e trocam diretório de dados. Exigir caminho absoluto mata
   * a classe inteira: absoluto nunca começa com hífen.
   */
  it('recusa caminho que o programa leria como flag', () => {
    for (const evil of ['--install-extension', '-a', 'relativo/sem/barra', '']) {
      expect(() => launchApp('vscode', evil, { platform: 'linux', available: () => true, spawnFn: spawnFn() }), evil)
        .toThrow(/absoluto/i)
    }
  })

  it('aceita caminho absoluto normal', () => {
    const spawn = spawnFn()
    launchApp('vscode', '/home/u/projeto', { platform: 'linux', available: has('code'), spawnFn: spawn })
    expect(spawn).toHaveBeenCalled()
  })

  it('aceita caminho absoluto do Windows', () => {
    const spawn = spawnFn()
    launchApp('folder', 'C:\\Users\\u\\projeto', { platform: 'win32', available: has('explorer'), spawnFn: spawn })
    expect(spawn).toHaveBeenCalled()
  })

  /**
   * O `cmd.exe` RE-INTERPRETA a linha de comando: uma pasta com "&" no nome (que o
   * Windows permite) emendaria um segundo comando. O diretório vai como `cwd`, que
   * não passa por interpretação nenhuma.
   */
  it('no Windows, a pasta nunca é interpolada numa linha de comando', () => {
    const spawn = spawnFn()
    launchApp('terminal', 'C:\\tmp\\a & calc', { platform: 'win32', available: has('cmd'), spawnFn: spawn })
    const [, args, opts] = (spawn as unknown as { mock: { calls: any[][] } }).mock.calls[0]
    expect(args.join(' '), 'a pasta não pode aparecer dentro dos argumentos').not.toContain('calc')
    expect(opts.cwd).toBe('C:\\tmp\\a & calc')
  })
})
