import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createPagesService, PAGE_MAX_BYTES, type PagesService } from '../src/pages/service.js'
import { UserError } from '../src/user-error.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createAuthService } from '../src/auth/index.js'
import { COOKIE_NAME } from '../src/auth/plugin.js'

let db: Db
let root: string
let dir: string
let projectId: number
let service: PagesService
let live: { localId: string; engineSessionId: string | null } | undefined
let turn: { turnId: number; turnKey: string | null } | undefined
let sent: any[]
const temps: string[] = []

const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d }
const put = (rel: string, data: string | Buffer) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, data)
  return p
}
const rows = () => db.prepare('SELECT * FROM visual_pages').all() as any[]
const files = () => (existsSync(dir) ? readdirSync(dir) : [])

/** Roda `fn` e devolve o UserError que ele lança (falha se não lançar). */
const refusal = (fn: () => unknown): UserError => {
  try { fn() } catch (e) { if (e instanceof UserError) return e; throw e }
  throw new Error('não recusou')
}

beforeEach(() => {
  db = openDb(':memory:')
  root = tmp('pg-proj-')
  dir = join(tmp('pg-dir-'), 'pages') // ainda não existe: o serviço cria
  projectId = createProjectsService(db).create({ name: 'Alfa', path: root }).id
  live = { localId: 'loc-1', engineSessionId: 'conv-1' }
  turn = { turnId: 7, turnKey: 'k7' }
  sent = []
  service = createPagesService({
    db, dir,
    projects: createProjectsService(db),
    liveSession: (pid, engine) => (pid === projectId && engine === 'claude' ? live : undefined),
    openTurn: (localId) => (localId === 'loc-1' ? turn : undefined),
    broadcast: (m) => { sent.push(m) },
    log: () => {},
  })
})

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const publish = (over: Record<string, unknown> = {}) =>
  service.publish({ projectId, engine: 'claude', title: 'Gráfico', html: '<h1>oi</h1>', ...over })

describe('publicar página', () => {
  it('html publicado: arquivo em <dir>/<id>.html, linha com conversa, turn_id e turn_key do trecho aberto, broadcast visual_page com projectId, engine, localId e page', () => {
    const r = publish({ height: 480 })
    expect(r.id).toMatch(/^pg_[0-9a-f]{16}$/)
    expect(r.warnings).toEqual([])
    expect(readFileSync(join(dir, `${r.id}.html`), 'utf8')).toBe('<h1>oi</h1>')
    expect(r.bytes).toBe(Buffer.byteLength('<h1>oi</h1>'))
    expect(service.filePath(r.id)).toBe(join(dir, `${r.id}.html`))

    const [row] = rows()
    expect(row).toMatchObject({
      id: r.id, project_id: projectId, engine: 'claude', local_id: 'loc-1', conversation_id: 'conv-1',
      turn_id: 7, turn_key: 'k7', title: 'Gráfico', height: 480, bytes: r.bytes, source: 'html', source_path: null,
    })
    const page = service.get(r.id)!
    expect(page).toMatchObject({ id: r.id, conversationId: 'conv-1', turnId: 7, turnKey: 'k7', source: 'html' })
    expect(sent).toEqual([{ type: 'visual_page', projectId, engine: 'claude', localId: 'loc-1', page }])
  })

  it('path relativo e absoluto dentro do projeto; .htm aceito', () => {
    const abs = put('docs/rel.html', '<p>rel</p>')
    put('docs/x.htm', '<p>htm</p>')
    const a = publish({ html: undefined, path: 'docs/rel.html' })
    const b = publish({ html: undefined, path: abs })
    const c = publish({ html: undefined, path: 'docs/x.htm' })
    expect(readFileSync(service.filePath(a.id), 'utf8')).toBe('<p>rel</p>')
    expect(readFileSync(service.filePath(b.id), 'utf8')).toBe('<p>rel</p>')
    expect(readFileSync(service.filePath(c.id), 'utf8')).toBe('<p>htm</p>')
    const byId = new Map(rows().map((x) => [x.id, x]))
    expect(byId.get(a.id)).toMatchObject({ source: 'path', source_path: abs })
    expect(byId.get(c.id).source).toBe('path')
  })

  it('path: os recursos locais saem da pasta do .html', () => {
    put('docs/img/p.png', Buffer.from([1, 2, 3]))
    const r = publish({ html: undefined, path: put('docs/p.html', '<img src="img/p.png">') })
    expect(readFileSync(service.filePath(r.id), 'utf8')).toBe('<img src="data:image/png;base64,AQID">')
  })

  it('path fora do projeto, .txt e inexistente: page_path, nada gravado (pasta vazia, tabela vazia)', () => {
    const fora = join(tmp('pg-fora-'), 'fora.html')
    writeFileSync(fora, '<p>segredo</p>')
    put('notas.txt', '<p>x</p>')
    symlinkSync(fora, join(root, 'atalho.html'))
    for (const path of [fora, '../fora.html', 'notas.txt', 'nao-existe.html', 'atalho.html', '', 42]) {
      expect(refusal(() => publish({ html: undefined, path })).code, String(path)).toBe('page_path')
    }
    expect(files()).toEqual([])
    expect(rows()).toEqual([])
    expect(sent).toEqual([])
  })

  it('html e path juntos ou nenhum: page_source', () => {
    put('a.html', '<p>a</p>')
    expect(refusal(() => publish({ path: 'a.html' })).code).toBe('page_source')
    expect(refusal(() => publish({ html: undefined })).code).toBe('page_source')
    expect(refusal(() => publish({ html: 42 })).code).toBe('page_source')
    expect(rows()).toEqual([])
  })

  it('title vazio ou com 121 caracteres: page_title; height 119 e 2001: page_height', () => {
    for (const title of ['', '   ', 'x'.repeat(121), undefined, 7]) {
      expect(refusal(() => publish({ title })).code).toBe('page_title')
    }
    expect(publish({ title: 'x'.repeat(120) }).id).toMatch(/^pg_/)
    for (const height of [119, 2001, 300.5, '300']) {
      expect(refusal(() => publish({ height })).code).toBe('page_height')
    }
    expect(publish({ height: 120 }).id).toMatch(/^pg_/)
    expect(publish({ height: 2000 }).id).toMatch(/^pg_/)
    expect(publish({ height: null }).id).toMatch(/^pg_/)
  })

  it('teto depois de embutir: page_too_large cita os três maiores recursos; nada gravado', () => {
    put('img/b.png', Buffer.alloc(10 * 1024, 1))
    put('js/app.js', '//' + 'x'.repeat(90 * 1024 - 2))
    put('css/s.css', '/*' + 'x'.repeat(120 * 1024 - 4) + '*/')
    put('img/a.png', Buffer.alloc(300 * 1024, 1))
    const html = '<img src="img/b.png"><script src="js/app.js"></script>'
      + '<link rel="stylesheet" href="css/s.css"><img src="img/a.png"><img src="img/a.png">'
    const e = refusal(() => publish({ html }))
    expect(e.code).toBe('page_too_large')
    expect(e.message).toMatch(
      /^page is \d+ KB after embedding, over the 512 KB limit; largest resources: img\/a\.png 400 KB, css\/s\.css 120 KB, js\/app\.js 90 KB$/,
    )
    expect(files()).toEqual([])
    expect(rows()).toEqual([])
  })

  it('path cujo arquivo já passa do teto: page_too_large antes de ler', () => {
    put('grande.html', 'x'.repeat(PAGE_MAX_BYTES + 1))
    expect(refusal(() => publish({ html: undefined, path: 'grande.html' })).code).toBe('page_too_large')
    expect(rows()).toEqual([])
  })

  it('teto em bytes, não em caracteres: 200 mil emojis (menos de 524.288 caracteres, mais de 524.288 bytes) recusam', () => {
    const html = '😀'.repeat(200_000)
    expect(html.length).toBeLessThan(524_288)
    expect(Buffer.byteLength(html)).toBeGreaterThan(524_288)
    expect(refusal(() => publish({ html })).code).toBe('page_too_large')
    // Acima do teto em caracteres também.
    expect(refusal(() => publish({ html: 'x'.repeat(524_289) })).code).toBe('page_too_large')
    expect(files()).toEqual([])
  })

  it('aviso de referência ausente volta em warnings', () => {
    const r = publish({ html: '<img src="nao-existe.png"><img src="nao-existe.png"><script src="falta.js"></script>' })
    expect(r.warnings).toEqual(['2 local references not embedded: nao-existe.png, falta.js'])
    expect(publish({ html: '<img src="so.png">' }).warnings).toEqual(['1 local reference not embedded: so.png'])
    const muitas = Array.from({ length: 12 }, (_, i) => `<img src="f${i}.png">`).join('')
    const w = publish({ html: muitas }).warnings[0]
    expect(w.startsWith('12 local references not embedded: f0.png, ')).toBe(true)
    expect(w.endsWith('f9.png')).toBe(true)
  })

  it('sem sessão viva: no_live_session (409), nada gravado', () => {
    live = undefined
    const e = refusal(() => publish())
    expect(e.code).toBe('no_live_session')
    expect(e.message).toBe('no live session in this terminal; open it in Claudinei first')
    expect(files()).toEqual([])
    expect(rows()).toEqual([])
    expect(sent).toEqual([])
  })

  it('sem trecho aberto: turn_id e turn_key nulos; engineSessionId nulo: conversation_id nulo', () => {
    turn = undefined
    live = { localId: 'loc-1', engineSessionId: null }
    const r = publish()
    expect(rows()[0]).toMatchObject({ id: r.id, turn_id: null, turn_key: null, conversation_id: null, local_id: 'loc-1' })
  })

  it('gravação atômica: nenhum .tmp sobra na pasta', () => {
    const a = publish()
    const b = publish({ html: '<p>2</p>' })
    expect(files().sort()).toEqual([`${a.id}.html`, `${b.id}.html`].sort())
  })

  it('filePath só aceita id de página', () => {
    expect(() => service.filePath('../etc/passwd')).toThrow()
    expect(() => service.filePath('pg_xyz')).toThrow()
  })
})

// Rota do Hermes, via buildApp, com auth ligada e sessões dubladas pelo fake-claude.
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('POST /api/hermes/pages', () => {
  const cookieOf = (res: any): Record<string, string> => {
    const c = res.cookies.find((x: any) => x.name === COOKIE_NAME)
    return c ? { [COOKIE_NAME]: c.value } : {}
  }

  const setup = async () => {
    const pagesDir = join(tmp('pg-app-'), 'pages')
    const auth = createAuthService({ db })
    const manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
    const app = await buildApp({ config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager, auth })
    const other = createProjectsService(db).create({ name: 'Beta', path: tmp('pg-beta-') }).id
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [other] })
    const admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'abcd1234' } }))
    const ana = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ana', password: 'abcd1234' } }))
    const service = { authorization: `Bearer ${auth.tokens.signService()}` }
    return { app, pagesDir, admin, ana, service }
  }

  it('POST /api/hermes/pages com token de serviço responde 201', async () => {
    const { app, pagesDir, admin, service } = await setup()
    const { localId } = (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sessions`, cookies: admin, payload: {} })).json()
    await waitUntil(() => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status === 'idle')
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/hermes/pages', headers: service,
        payload: { projectId, engine: 'claude', html: '<p>oi</p>', title: 'T' },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body).toEqual({ id: expect.stringMatching(/^pg_[0-9a-f]{16}$/), bytes: 9, warnings: [] })
      expect(readFileSync(join(pagesDir, `${body.id}.html`), 'utf8')).toBe('<p>oi</p>')
      expect(rows()[0]).toMatchObject({ id: body.id, local_id: localId })

      // Recusa do serviço sai com o código e o status certos.
      const bad = await app.inject({
        method: 'POST', url: '/api/hermes/pages', headers: service,
        payload: { projectId, engine: 'claude', html: '<p>oi</p>', title: '' },
      })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().code).toBe('page_title')
    } finally {
      await app.inject({ method: 'POST', url: `/api/sessions/${localId}/stop`, cookies: admin })
    }
  })

  it('sem sessão viva responde 409 no_live_session', async () => {
    const { app, service } = await setup()
    const res = await app.inject({
      method: 'POST', url: '/api/hermes/pages', headers: service,
      payload: { projectId, engine: 'claude', html: '<p>oi</p>', title: 'T' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'no_live_session', error: 'no live session in this terminal; open it in Claudinei first' })
  })

  it('corpo acima de 2 MiB dá 413', async () => {
    const { app, service } = await setup()
    const res = await app.inject({
      method: 'POST', url: '/api/hermes/pages', headers: service,
      payload: { projectId, engine: 'claude', html: 'x'.repeat(2 * 1024 * 1024 + 10), title: 'T' },
    })
    expect(res.statusCode).toBe(413)
  })

  it('usuário sem acesso ao projeto dá 403', async () => {
    const { app, ana } = await setup()
    const res = await app.inject({
      method: 'POST', url: '/api/hermes/pages', cookies: ana,
      payload: { projectId, engine: 'claude', html: '<p>oi</p>', title: 'T' },
    })
    expect(res.statusCode).toBe(403)
    expect(rows()).toEqual([])
  })
})
