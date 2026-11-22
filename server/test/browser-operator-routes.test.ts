import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { INSTALL_COMMAND } from '../src/browser/chromium.js'
import { TEXTS } from '../src/browser/types.js'
import { browserApp, type BrowserAppFixture } from './browser-app-fixture.js'

let f: BrowserAppFixture
const savedEnv = { ...process.env }

beforeEach(async () => { f = await browserApp() })
afterEach(async () => {
  await f.close()
  process.env = { ...savedEnv }
})

const tabUrl = (projectId: number, engine = 'claude') => `/api/projects/${projectId}/terminals/${engine}/browser`
const tabEvents = () => f.broadcasts.filter((m) => m.type === 'browser_tab')

describe('rotas do operador do navegador', () => {
  it('a app entrega a feature pelo onBrowserReady', () => {
    expect(f.feature).toBeDefined()
    expect(typeof f.feature!.closeAll).toBe('function')
    expect(typeof f.feature!.closeUser).toBe('function')
  })

  it('GET /api/browser/tabs só lista projetos com acesso', async () => {
    expect((await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id), cookies: f.adminCookie })).statusCode).toBe(200)
    expect((await f.app.inject({ method: 'POST', url: tabUrl(f.p2.id, 'codex'), cookies: f.adminCookie })).statusCode).toBe(200)
    const admin = await f.app.inject({ method: 'GET', url: '/api/browser/tabs', cookies: f.adminCookie })
    expect(admin.statusCode).toBe(200)
    expect(admin.json().tabs).toEqual(expect.arrayContaining([
      { projectId: f.p1.id, engine: 'claude' },
      { projectId: f.p2.id, engine: 'codex' },
    ]))
    expect(admin.json().tabs).toHaveLength(2)
    const ana = await f.app.inject({ method: 'GET', url: '/api/browser/tabs', cookies: f.anaCookie })
    expect(ana.json()).toEqual({ tabs: [{ projectId: f.p1.id, engine: 'claude' }] })
    // Fechada, sai da lista.
    await f.host.closeTab({ projectId: f.p1.id, engine: 'claude' })
    const after = await f.app.inject({ method: 'GET', url: '/api/browser/tabs', cookies: f.anaCookie })
    expect(after.json()).toEqual({ tabs: [] })
  })

  it("POST cria com by 'operator'", async () => {
    const res = await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id), cookies: f.anaCookie })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(f.host.existingTab({ projectId: f.p1.id, engine: 'claude' })).toBeDefined()
    // Reaproveita: nenhuma aba nova, nenhum anúncio novo.
    await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id), cookies: f.anaCookie })
    expect(tabEvents()).toEqual([{ type: 'browser_tab', projectId: f.p1.id, engine: 'claude', open: true, by: 'operator' }])
  })

  it('DELETE fecha e responde 204', async () => {
    await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id), cookies: f.adminCookie })
    const res = await f.app.inject({ method: 'DELETE', url: tabUrl(f.p1.id), cookies: f.adminCookie })
    expect(res.statusCode).toBe(204)
    expect(f.host.existingTab({ projectId: f.p1.id, engine: 'claude' })).toBeUndefined()
    expect(tabEvents().at(-1)).toEqual({ type: 'browser_tab', projectId: f.p1.id, engine: 'claude', open: false, by: 'operator' })
    // Sem aba: continua 204.
    expect((await f.app.inject({ method: 'DELETE', url: tabUrl(f.p1.id), cookies: f.adminCookie })).statusCode).toBe(204)
  })

  it('sem acesso → 403; projeto inexistente → 404; engine inválido → 400', async () => {
    for (const method of ['POST', 'DELETE'] as const) {
      expect((await f.app.inject({ method, url: tabUrl(f.p2.id), cookies: f.anaCookie })).statusCode).toBe(403)
      expect((await f.app.inject({ method, url: tabUrl(9999), cookies: f.adminCookie })).statusCode).toBe(404)
      expect((await f.app.inject({ method, url: tabUrl(f.p1.id, 'Bad%20Engine'), cookies: f.adminCookie })).statusCode).toBe(400)
    }
    expect(f.fl.launches).toHaveLength(0)
  })

  it('motor fora dos do Claudinei → 400 no POST e no DELETE, sem abrir aba', async () => {
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await f.app.inject({ method, url: tabUrl(f.p1.id, 'inventado'), cookies: f.adminCookie })
      expect(res.statusCode, method).toBe(400)
      expect(res.json().code).toBe('bad_args')
    }
    expect(f.fl.launches).toHaveLength(0)
    expect((await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id, 'kimi'), cookies: f.adminCookie })).statusCode).toBe(200)
  })

  it('sem Chromium → POST 503 com o comando de instalação', async () => {
    delete process.env.CLAUDINEI_CHROMIUM
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/nao/existe/claudinei-teste'
    const res = await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id), cookies: f.adminCookie })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: TEXTS.NOT_INSTALLED, code: 'browser_not_installed', hint: INSTALL_COMMAND })
  })

  it('sem login → 401', async () => {
    expect((await f.app.inject({ method: 'GET', url: '/api/browser/tabs' })).statusCode).toBe(401)
    expect((await f.app.inject({ method: 'POST', url: tabUrl(f.p1.id) })).statusCode).toBe(401)
  })
})
