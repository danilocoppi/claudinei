import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { INSTALL_COMMAND } from '../src/browser/chromium.js'
import { TEXTS, TooManyTabsError } from '../src/browser/types.js'
import { PAGE_BUSY, PAGE_CRASHED, BadArgsError, DialogPendingError, StaleRefError, TabGoneError } from '../src/browser/agent-ops.js'
import { OperatorInControlError } from '../src/browser/baton.js'
import { BrowserBusyError, BrowserUnavailableError } from '../src/browser/host.js'
import { browserErrorReply } from '../src/browser/hermes-routes.js'
import { browserApp, flush, until, type BrowserAppFixture } from './browser-app-fixture.js'
import type { FakePage } from './browser-fakes.js'

const SNAP = '- generic [ref=e1]:\n  - button "Enviar" [ref=e6] [cursor=pointer]'

let f: BrowserAppFixture
const savedEnv = { ...process.env }

beforeEach(async () => { f = await browserApp() })
afterEach(async () => {
  await f.close()
  process.env = { ...savedEnv }
})

const KEY = () => ({ projectId: f.p1.id, engine: 'claude' })

function call(op: string, args: Record<string, unknown> = {}, o: { cookies?: Record<string, string>; projectId?: unknown; engine?: unknown } = {}) {
  return f.app.inject({
    method: 'POST',
    url: `/api/hermes/browser/${op}`,
    cookies: o.cookies ?? f.adminCookie,
    payload: { projectId: 'projectId' in o ? o.projectId : f.p1.id, engine: 'engine' in o ? o.engine : 'claude', ...args },
  })
}

const pageOf = () => f.host.existingTab(KEY())!.page() as unknown as FakePage
const tabEvents = () => f.broadcasts.filter((m) => m.type === 'browser_tab')

describe('POST /api/hermes/browser/:op', () => {
  it("open sem url cria a aba e devolve status com 'control: free'", async () => {
    const res = await call('open')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.text).toBe('browser open at about:blank')
    expect(body.status).toMatch(/^Browser: about:blank \| .* \| control: free$/)
    expect(f.host.existingTab(KEY())).toBeDefined()
    expect(f.fl.launches).toHaveLength(1)
  })

  it("open emite browser_tab { open: true, by: 'agent' }", async () => {
    await call('open')
    // A segunda chamada reaproveita a aba: nenhum anúncio novo.
    await call('open')
    expect(tabEvents()).toEqual([{ type: 'browser_tab', projectId: f.p1.id, engine: 'claude', open: true, by: 'agent' }])
  })

  it('open com url navega e devolve o texto da navegação', async () => {
    const res = await call('open', { url: 'http://127.0.0.1:5173/' })
    expect(res.statusCode).toBe(200)
    expect(res.json().text).toBe('opened http://127.0.0.1:5173/')
  })

  it('navigate com file: → 400 scheme_refused', async () => {
    await call('open')
    const res = await call('navigate', { url: 'file:///etc/passwd' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: TEXTS.SCHEME_REFUSED, code: 'scheme_refused' })
  })

  it('operador no comando → navigate 409 com o texto verbatim; snapshot 200', async () => {
    await call('open')
    pageOf().snapshotText = SNAP
    f.host.existingTab(KEY())!.baton.operatorAct({ userId: 1, name: 'Ana' })
    const nav = await call('navigate', { url: 'https://example.com/' })
    expect(nav.statusCode).toBe(409)
    expect(nav.json()).toEqual({ error: TEXTS.OPERATOR_IN_CONTROL, code: 'operator_in_control' })
    const snap = await call('snapshot')
    expect(snap.statusCode).toBe(200)
    expect(snap.json().text).toBe(SNAP)
    expect(snap.json().status).toMatch(/control: operator \(Ana\)$/m)
  })

  it('screenshot devolve png base64 e path de arquivo existente em uploadsDir', async () => {
    await call('open')
    const res = await call('screenshot', { fullPage: true })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Buffer.from(body.png, 'base64').toString()).toBe('png')
    expect(dirname(body.path)).toBe(f.uploadsDir)
    expect(body.path).toMatch(/navegador\.png$/)
    expect(existsSync(body.path)).toBe(true)
    expect(readFileSync(body.path).toString()).toBe('png')
    expect(body.status).toMatch(/^Browser: /)
    expect(pageOf().screenshots.at(-1)).toMatchObject({ fullPage: true })
  })

  it('sem Chromium → 503 com hint === INSTALL_COMMAND', async () => {
    delete process.env.CLAUDINEI_CHROMIUM
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/nao/existe/claudinei-teste'
    const res = await call('open')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: TEXTS.NOT_INSTALLED, code: 'browser_not_installed', hint: INSTALL_COMMAND })
    expect(tabEvents()).toEqual([])
  })

  it('projeto inexistente → 404; usuário sem acesso → 403', async () => {
    expect((await call('open', {}, { projectId: 9999 })).statusCode).toBe(404)
    expect((await call('open', {}, { projectId: f.p2.id, cookies: f.anaCookie })).statusCode).toBe(403)
    // Com acesso, a mesma usuária abre a do p1.
    expect((await call('open', {}, { cookies: f.anaCookie })).statusCode).toBe(200)
    expect(f.fl.launches).toHaveLength(1)
  })

  it('engine inválido → 400', async () => {
    for (const engine of [undefined, '', 'Claude', 'a b', 'x'.repeat(33), 3]) {
      const res = await call('open', {}, { engine })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('bad_args')
    }
    expect(f.fl.launches).toHaveLength(0)
  })

  it('operação desconhecida → 404 unknown_op', async () => {
    const res = await call('evaluate')
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('unknown_op')
  })

  it('close emite browser_tab { open: false }', async () => {
    await call('open')
    const res = await call('close')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ text: 'browser closed', status: 'Browser: closed' })
    expect(f.host.existingTab(KEY())).toBeUndefined()
    expect(tabEvents().at(-1)).toEqual({ type: 'browser_tab', projectId: f.p1.id, engine: 'claude', open: false, by: 'agent' })
    // Fechar de novo, já sem aba: no-op.
    const again = await call('close')
    expect(again.statusCode).toBe(200)
    expect(tabEvents()).toHaveLength(2)
  })

  it('operação sem aba aberta → 410 no_tab, sem abrir o Chromium', async () => {
    for (const op of ['navigate', 'snapshot', 'act', 'wait', 'screenshot', 'console']) {
      const res = await call(op, { url: 'https://example.com/', action: 'click', ref: 'e6', seconds: 0 })
      expect(res.statusCode).toBe(410)
      expect(res.json().code).toBe('no_tab')
    }
    expect(f.fl.launches).toHaveLength(0)
  })

  it('aba fechada no meio de um act (closeTab durante o act pendurado) → 410 tab_gone; o open seguinte cria outra aba', async () => {
    await call('open')
    const first = f.host.existingTab(KEY())!
    const page = pageOf()
    page.snapshotText = SNAP
    expect((await call('snapshot')).statusCode).toBe(200)
    page.actHang = true
    const pending = call('act', { action: 'click', ref: 'e6' })
    await until(() => page.calls.some((c) => c.method === 'click'))
    // O operador fecha a aba com a ação do agente em curso.
    await f.host.closeTab(KEY())
    const res = await pending
    expect(res.statusCode).toBe(410)
    expect(res.json().code).toBe('tab_gone')
    expect(res.json().error).toMatch(/call browser_open again/)
    expect(tabEvents().at(-1)).toEqual({ type: 'browser_tab', projectId: f.p1.id, engine: 'claude', open: false, by: 'operator' })
    // A próxima open sobe outra aba (e anuncia de novo).
    const again = await call('open')
    expect(again.statusCode).toBe(200)
    const second = f.host.existingTab(KEY())!
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(tabEvents().at(-1)).toEqual({ type: 'browser_tab', projectId: f.p1.id, engine: 'claude', open: true, by: 'agent' })
  })

  it('aba que fecha por ociosidade/queda anuncia by: system', async () => {
    await call('open')
    await f.host.existingTab(KEY())!.close('idle')
    await flush()
    expect(tabEvents().at(-1)).toEqual({ type: 'browser_tab', projectId: f.p1.id, engine: 'claude', open: false, by: 'system' })
  })

  it('act sem ref → 400 bad_args; ref sem snapshot → 409 stale_ref', async () => {
    await call('open')
    const bad = await call('act', { action: 'click' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('bad_args')
    const stale = await call('act', { action: 'click', ref: 'e6' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: TEXTS.STALE_REF, code: 'stale_ref' })
  })

  it('argumentos com tipo errado → 400 bad_args (sem chegar à página)', async () => {
    await call('open')
    const cases: Array<[string, Record<string, unknown>]> = [
      ['open', { url: 42 }],
      ['navigate', { url: 'https://a.test/', action: 'back' }],
      ['navigate', {}],
      ['act', { action: 'press', key: 13 }],
      ['act', { action: 'scroll', dy: '100' }],
      ['act', { action: 'dialog', accept: 'yes' }],
      ['snapshot', { depth: 'x' }],
      ['screenshot', { fullPage: 'yes' }],
      ['wait', { seconds: '5' }],
      ['wait', { text: 'a', seconds: 1 }],
    ]
    for (const [op, args] of cases) {
      const res = await call(op, args)
      expect(res.statusCode, `${op} ${JSON.stringify(args)}`).toBe(400)
      expect(res.json().code).toBe('bad_args')
    }
  })

  it('wait, console e navigate por histórico respondem com text e status', async () => {
    await call('open', { url: 'https://example.com/' })
    const wait = await call('wait', { seconds: 0 })
    expect(wait.json().text).toBe('waited 0 s')
    const cons = await call('console')
    expect(cons.statusCode).toBe(200)
    expect(cons.json().text).toBe('no console messages')
    const back = await call('navigate', { action: 'reload' })
    expect(back.statusCode).toBe(200)
    expect(back.json().text).toBe('reloaded https://example.com/')
  })

  it('serviço (token do hermes) passa como no goal-done', async () => {
    const token = f.auth.tokens.signService(f.auth.users.serviceTokenVersion())
    const res = await f.app.inject({
      method: 'POST', url: '/api/hermes/browser/open',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectId: f.p2.id, engine: 'codex' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('browserErrorReply: cada erro vira status e código legíveis', () => {
  it('mapeia os erros conhecidos e cai em 500 com a mensagem', () => {
    const cases: Array<[unknown, number, Record<string, unknown>]> = [
      [new OperatorInControlError(), 409, { error: TEXTS.OPERATOR_IN_CONTROL, code: 'operator_in_control' }],
      [new StaleRefError(), 409, { error: TEXTS.STALE_REF, code: 'stale_ref' }],
      [new DialogPendingError(), 409, { error: TEXTS.DIALOG_PENDING, code: 'dialog_pending' }],
      [new Error(TEXTS.SCHEME_REFUSED), 400, { error: TEXTS.SCHEME_REFUSED, code: 'scheme_refused' }],
      [new BrowserUnavailableError('browser_not_installed', TEXTS.NOT_INSTALLED, INSTALL_COMMAND), 503, { error: TEXTS.NOT_INSTALLED, code: 'browser_not_installed', hint: INSTALL_COMMAND }],
      [new BrowserUnavailableError('launch_failed', 'chrome exited with 127', 'executable: /x'), 503, { error: 'chrome exited with 127', code: 'launch_failed', hint: 'executable: /x' }],
      [new TooManyTabsError(), 503, { error: TEXTS.TOO_MANY_TABS, code: 'too_many_tabs' }],
      [new TabGoneError('idle'), 410, { error: 'the browser tab closed (idle); call browser_open again', code: 'tab_gone' }],
      [new BrowserBusyError(), 503, { error: 'browser busy: too many preview pages waiting', code: 'browser_busy' }],
      [new BadArgsError('depth must be a positive integer'), 400, { error: 'depth must be a positive integer', code: 'bad_args' }],
      [new Error(PAGE_BUSY), 504, { error: PAGE_BUSY, code: 'page_busy' }],
      [new Error(PAGE_CRASHED), 409, { error: PAGE_CRASHED, code: 'page_crashed' }],
      [new Error('no dialog is pending'), 409, { error: 'no dialog is pending', code: 'no_dialog' }],
      [new Error("timed out after 30 s waiting for text 'x'"), 504, { error: "timed out after 30 s waiting for text 'x'", code: 'wait_timeout' }],
      [new Error('boom'), 500, { error: 'boom', code: 'internal' }],
      ['texto solto', 500, { error: 'texto solto', code: 'internal' }],
    ]
    for (const [err, status, body] of cases) {
      expect(browserErrorReply(err), String(err)).toEqual({ status, body })
    }
  })
})
