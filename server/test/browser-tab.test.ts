import { describe, it, expect, vi } from 'vitest'
import type { BrowserContext, Page } from 'playwright-core'
import { allowedUrl, isChromiumErrorPage, normalizeAddress } from '../src/browser/url-policy.js'
import { createTerminalTab } from '../src/browser/terminal-tab.js'
import { TEXTS } from '../src/browser/types.js'
import { FakeContext, type FakePage } from './browser-fakes.js'

const KEY = { projectId: 1, engine: 'claude' }

async function makeTab(o: { sandbox?: boolean } = {}) {
  const context = new FakeContext({})
  const page = await context.newPage()
  const tab = createTerminalTab({
    key: KEY,
    context: context as unknown as BrowserContext,
    page: page as unknown as Page,
    now: () => 1_000,
    viewport: { width: 1280, height: 800 },
    sandbox: o.sandbox,
  })
  return { context, page, tab }
}

/** Deixa as promessas encadeadas nos ouvintes terminarem. */
const flush = () => new Promise((r) => setTimeout(r, 0))

function fakeDialog(type: string, message: string, defaultValue = '') {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    accept: vi.fn(async (_text?: string) => {}),
    dismiss: vi.fn(async () => {}),
  }
}

const gotos = (p: FakePage) => p.navigations.filter((n) => n.kind === 'goto').map((n) => n.arg)

describe('url-policy', () => {
  it('allowedUrl aceita http, https e about:blank; recusa file:, chrome:, devtools:, javascript:, data:, about:config', () => {
    expect(allowedUrl('http://127.0.0.1:5173/x')?.href).toBe('http://127.0.0.1:5173/x')
    expect(allowedUrl('https://exemplo.com')?.href).toBe('https://exemplo.com/')
    expect(allowedUrl('about:blank')?.href).toBe('about:blank')
    for (const bad of ['file:///etc/passwd', 'chrome://settings', 'devtools://devtools/x', 'javascript:alert(1)', 'data:text/html,x', 'about:config', 'about:blank#x', 'nada', '']) {
      expect(allowedUrl(bad), bad).toBeNull()
    }
  })

  it("normalizeAddress: 'localhost:5173' → 'http://localhost:5173'; '127.0.0.1:3000/x' → 'http://127.0.0.1:3000/x'; 'exemplo.com' → 'https://exemplo.com'", () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeAddress('127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(normalizeAddress('exemplo.com')).toBe('https://exemplo.com')
    expect(normalizeAddress('  app.localhost:8080 ')).toBe('http://app.localhost:8080')
    expect(normalizeAddress('[::1]:4000')).toBe('http://[::1]:4000')
    expect(normalizeAddress('https://x.com/a')).toBe('https://x.com/a')
    // Com esquema, volta como veio (a política recusa depois).
    expect(normalizeAddress('file:///etc/passwd')).toBe('file:///etc/passwd')
    expect(normalizeAddress('javascript:alert(1)')).toBe('javascript:alert(1)')
    expect(normalizeAddress('about:blank')).toBe('about:blank')
  })

  it('isChromiumErrorPage só para chrome-error://', () => {
    expect(isChromiumErrorPage('chrome-error://chromewebdata/')).toBe(true)
    expect(isChromiumErrorPage('chrome://settings')).toBe(false)
  })
})

describe('TerminalTab: navegação e política', () => {
  it('navigate normaliza o endereço e espera o load com prazo', async () => {
    const { page, tab } = await makeTab()
    await tab.navigate('localhost:5173')
    expect(page.navigations.at(-1)).toMatchObject({ kind: 'goto', arg: 'http://localhost:5173/', opts: { waitUntil: 'load', timeout: 10_000 } })
    expect(tab.state().url).toBe('http://localhost:5173/')
  })

  it("navigate('file:///etc/passwd') rejeita SCHEME_REFUSED e não chama page.goto", async () => {
    const { page, tab } = await makeTab()
    for (const bad of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x']) {
      await expect(tab.navigate(bad)).rejects.toThrow(TEXTS.SCHEME_REFUSED)
    }
    expect(gotos(page)).toEqual([])
  })

  it('navigate com o load estourado volta sem lançar; a página segue carregando', async () => {
    vi.useFakeTimers()
    try {
      const { page, tab } = await makeTab()
      page.navigation = 'hang'
      const run = tab.navigate('https://lento.example/')
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(run).resolves.toBeUndefined()
      expect(tab.state().loading).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('framenavigated do quadro principal para chrome://settings volta para about:blank e anota o aviso', async () => {
    const { page, tab } = await makeTab()
    await tab.navigate('https://exemplo.com/')
    page.navigatedTo('chrome://settings')
    await flush()
    expect(gotos(page).at(-1)).toBe('about:blank')
    expect(page.url()).toBe('about:blank')
    expect(tab.state().url).toBe('about:blank')
    expect(tab.state().notices).toContain('navigation to chrome: blocked; back to about:blank')
    expect(tab.takeAgentNotices()).toEqual(['navigation to chrome: blocked; back to about:blank'])
  })

  it('framenavigated para file: (redirecionamento) também volta', async () => {
    const { page, tab } = await makeTab()
    page.navigatedTo('file:///etc/passwd')
    await flush()
    expect(gotos(page)).toEqual(['about:blank'])
    expect(tab.takeAgentNotices()).toEqual(['navigation to file: blocked; back to about:blank'])
  })

  it('framenavigated para chrome-error://chromewebdata/ não volta', async () => {
    const { page, tab } = await makeTab()
    page.navigatedTo('chrome-error://chromewebdata/')
    await flush()
    expect(gotos(page)).toEqual([])
    expect(tab.state().notices).toEqual([])
    expect(tab.state().url).toBe('chrome-error://chromewebdata/')
  })

  it('framenavigated de um quadro filho é ignorado', async () => {
    const { page, tab } = await makeTab()
    page.emit('framenavigated', { url: () => 'chrome://settings', parentFrame: () => page.mainFrame() })
    await flush()
    expect(gotos(page)).toEqual([])
    expect(tab.state().notices).toEqual([])
  })

  it('loading liga no framenavigated e desliga no load; o título acompanha page.title() depois do load', async () => {
    const { page, tab } = await makeTab()
    const changes = vi.fn()
    tab.onState(changes)
    page.navigatedTo('https://exemplo.com/')
    await flush()
    expect(tab.state()).toMatchObject({ url: 'https://exemplo.com/', loading: true, title: '' })
    page.titleText = 'Exemplo'
    page.emit('load')
    await flush()
    expect(tab.state()).toMatchObject({ loading: false, title: 'Exemplo' })
    expect(changes).toHaveBeenCalled()
  })

  it('navegação no mesmo documento (readyState complete) não deixa o loading ligado', async () => {
    const { page, tab } = await makeTab()
    page.evalResult = 'complete'
    page.navigatedTo('https://exemplo.com/#secao')
    await flush()
    expect(tab.state().loading).toBe(false)
    expect(page.evaluated).toContain('document.readyState')
  })

  it("history('back'|'forward'|'reload') chama a operação da página com load e prazo", async () => {
    const { page, tab } = await makeTab()
    await tab.history('back')
    await tab.history('forward')
    await tab.history('reload')
    expect(page.navigations.map((n) => n.kind)).toEqual(['back', 'forward', 'reload'])
    expect(page.navigations[0].opts).toMatchObject({ waitUntil: 'load', timeout: 10_000 })
  })
})

describe('TerminalTab: janelas novas', () => {
  it('popup (target=_blank / window.open): fecha a página nova e navega a própria aba para a URL dela', async () => {
    const { context, page, tab } = await makeTab()
    const popup = context.openPopup('https://exemplo.com/novo')
    await flush()
    expect(popup.closed).toBe(true)
    expect(gotos(page)).toEqual(['https://exemplo.com/novo'])
    expect(tab.page()).toBe(page)
    expect(page.closed).toBe(false)
  })

  it('popup com URL proibida: fecha e não navega', async () => {
    const { context, page } = await makeTab()
    const popup = context.openPopup('file:///etc/passwd')
    const blank = context.openPopup('about:blank')
    await flush()
    expect(popup.closed && blank.closed).toBe(true)
    expect(gotos(page)).toEqual([])
  })
})

describe('TerminalTab: diálogos, downloads e seletor de arquivo', () => {
  it('alert é aceito e anotado; beforeunload é aceito', async () => {
    const { page, tab } = await makeTab()
    const alert = fakeDialog('alert', 'Salvo!')
    const unload = fakeDialog('beforeunload', '')
    page.emit('dialog', alert)
    page.emit('dialog', unload)
    expect(alert.accept).toHaveBeenCalledTimes(1)
    expect(unload.accept).toHaveBeenCalledTimes(1)
    expect(tab.state().dialog).toBeNull()
    expect(tab.takeAgentNotices()).toEqual(['alert accepted: "Salvo!"', 'beforeunload accepted'])
  })

  it('confirm fica pendente em state().dialog; answerDialog(false) chama dismiss; prompt com texto chama accept(texto)', async () => {
    const { page, tab } = await makeTab()
    const confirm = fakeDialog('confirm', 'Apagar?')
    page.emit('dialog', confirm)
    expect(tab.state().dialog).toEqual({ id: 1, type: 'confirm', message: 'Apagar?' })
    expect(confirm.accept).not.toHaveBeenCalled()
    expect(confirm.dismiss).not.toHaveBeenCalled()
    expect(tab.takeAgentNotices()).toEqual(['dialog pending: confirm "Apagar?"'])
    tab.answerDialog(false)
    expect(confirm.dismiss).toHaveBeenCalledTimes(1)
    expect(tab.state().dialog).toBeNull()

    const prompt = fakeDialog('prompt', 'Seu nome?', 'Ana')
    page.emit('dialog', prompt)
    expect(tab.state().dialog).toEqual({ id: 2, type: 'prompt', message: 'Seu nome?', defaultValue: 'Ana' })
    tab.answerDialog(true, 'Bia')
    expect(prompt.accept).toHaveBeenCalledWith('Bia')
    expect(tab.state().dialog).toBeNull()
  })

  it('confirm aceito chama accept sem texto; prompt aceito sem texto usa o valor padrão; sem diálogo é no-op', async () => {
    const { page, tab } = await makeTab()
    tab.answerDialog(true)
    const confirm = fakeDialog('confirm', 'Seguir?')
    page.emit('dialog', confirm)
    tab.answerDialog(true)
    expect(confirm.accept).toHaveBeenCalledWith()
    const prompt = fakeDialog('prompt', 'Quantos?', '3')
    page.emit('dialog', prompt)
    tab.answerDialog(true)
    expect(prompt.accept).toHaveBeenCalledWith('3')
    tab.answerDialog(false)
    expect(prompt.dismiss).not.toHaveBeenCalled()
  })

  it('confirm com mensagem longa: state().dialog.message sai cortada em 500 caracteres, igual ao aviso', async () => {
    const { page, tab } = await makeTab()
    const long = 'x'.repeat(800)
    page.emit('dialog', fakeDialog('confirm', long))
    const cut = `${'x'.repeat(500)}…`
    expect(tab.state().dialog?.message).toBe(cut)
    expect(tab.takeAgentNotices()).toEqual([`dialog pending: confirm "${cut}"`])
  })

  it('navegar com um confirm pendente o cancela antes', async () => {
    const { page, tab } = await makeTab()
    const confirm = fakeDialog('confirm', 'Sair?')
    page.emit('dialog', confirm)
    await tab.navigate('https://exemplo.com/')
    expect(confirm.dismiss).toHaveBeenCalledTimes(1)
    expect(tab.state().dialog).toBeNull()
  })

  it("download anota 'download blocked: relatorio.pdf, from https://x/relatorio.pdf'", async () => {
    const { page, tab } = await makeTab()
    page.emit('download', { suggestedFilename: () => 'relatorio.pdf', url: () => 'https://x/relatorio.pdf' })
    expect(tab.state().notices).toEqual(['download blocked: relatorio.pdf, from https://x/relatorio.pdf'])
    expect(tab.takeAgentNotices()).toEqual(['download blocked: relatorio.pdf, from https://x/relatorio.pdf'])
  })

  it('filechooser é cancelado (setFiles([])) e anotado', async () => {
    const { page, tab } = await makeTab()
    const fc = { setFiles: vi.fn(async (_files: unknown) => {}) }
    page.emit('filechooser', fc)
    expect(fc.setFiles).toHaveBeenCalledWith([])
    expect(tab.takeAgentNotices()).toEqual(['file chooser cancelled (file upload is not supported)'])
  })
})

describe('TerminalTab: queda da página', () => {
  it("crash marca crashed; history('reload') cria página nova no mesmo contexto e navega à última URL", async () => {
    const { context, page, tab } = await makeTab()
    await tab.navigate('https://exemplo.com/a')
    await tab.setViewport({ width: 900, height: 700 })
    const swapped = vi.fn()
    tab.onPage(swapped)
    page.emit('crash')
    expect(tab.state().crashed).toBe(true)
    expect(tab.takeAgentNotices()).toEqual(['page crashed; use browser_navigate action=reload'])

    await tab.history('reload')
    expect(context.pages).toHaveLength(2)
    const fresh = context.pages[1]
    expect(fresh.closed).toBe(false)
    expect(page.closed).toBe(true)
    expect(tab.page()).toBe(fresh)
    expect(gotos(fresh)).toEqual(['https://exemplo.com/a'])
    expect(fresh.viewports).toEqual([{ width: 900, height: 700 }])
    expect(swapped).toHaveBeenCalledWith(fresh)
    expect(tab.state()).toMatchObject({ crashed: false, url: 'https://exemplo.com/a' })

    // Os ouvintes passaram para a página nova: o vigia segue valendo.
    fresh.navigatedTo('chrome://settings')
    await flush()
    expect(gotos(fresh).at(-1)).toBe('about:blank')
  })

  it('navigate com a página travada também recria a página antes', async () => {
    const { context, page, tab } = await makeTab()
    page.emit('crash')
    await tab.navigate('https://outro.example/')
    expect(context.pages).toHaveLength(2)
    expect(gotos(context.pages[1])).toEqual(['https://outro.example/'])
    expect(gotos(page)).toEqual([])
  })

  it('a página que fecha sozinha conta como travada', async () => {
    const { page, tab } = await makeTab()
    await page.close()
    expect(tab.state().crashed).toBe(true)
  })

  it('close da aba fecha o contexto sem marcar queda', async () => {
    const { context, tab } = await makeTab()
    const reasons: string[] = []
    tab.onClosed((r) => reasons.push(r))
    await tab.close('closed_by_user')
    expect(reasons).toEqual(['closed_by_user'])
    expect(context.closed).toBe(true)
    expect(tab.state().crashed).toBe(false)
  })
})

describe('TerminalTab: viewport, avisos e estado', () => {
  it('setViewport grampeia 100×100 → 320×240 e 5000×5000 → 1920×1200', async () => {
    const { page, tab } = await makeTab()
    await tab.setViewport({ width: 100, height: 100 })
    expect(tab.state().viewport).toEqual({ width: 320, height: 240 })
    await tab.setViewport({ width: 5000, height: 5000 })
    expect(tab.state().viewport).toEqual({ width: 1920, height: 1200 })
    expect(page.viewports).toEqual([{ width: 320, height: 240 }, { width: 1920, height: 1200 }])
    // O mesmo tamanho não mexe na página.
    await tab.setViewport({ width: 1920.2, height: 1300 })
    expect(page.viewports).toHaveLength(2)
  })

  it('takeAgentNotices devolve uma vez e esvazia', async () => {
    const { tab } = await makeTab()
    tab.pushNotice('a', true)
    tab.pushNotice('só da coluna', false)
    tab.pushNotice('b', true)
    expect(tab.takeAgentNotices()).toEqual(['a', 'b'])
    expect(tab.takeAgentNotices()).toEqual([])
  })

  it('a coluna guarda os últimos 5 avisos; onState avisa cada mudança', async () => {
    const { tab } = await makeTab()
    const changes = vi.fn()
    const off = tab.onState(changes)
    for (let i = 1; i <= 7; i++) tab.pushNotice(`n${i}`, false)
    expect(tab.state().notices).toEqual(['n3', 'n4', 'n5', 'n6', 'n7'])
    expect(changes).toHaveBeenCalledTimes(7)
    off()
    tab.pushNotice('n8', false)
    expect(changes).toHaveBeenCalledTimes(7)
  })

  it("cada aba tem o seu bastão: começa livre; a devolução vai aos avisos do agente e da coluna", async () => {
    const { tab } = await makeTab()
    const { tab: other } = await makeTab()
    expect(tab.baton.state()).toEqual({ kind: 'free' })
    tab.baton.operatorAct({ userId: 1, name: 'Ana' })
    expect(other.baton.state()).toEqual({ kind: 'free' })
    const changes = vi.fn()
    tab.onState(changes)
    tab.baton.release()
    expect(tab.takeAgentNotices()).toEqual(['control returned to the agent'])
    expect(tab.state().notices).toEqual(['control returned to the agent'])
    expect(changes).toHaveBeenCalled()
  })

  it('fechar a aba encerra o relógio do bastão: nada é anotado depois', async () => {
    vi.useFakeTimers()
    try {
      const { tab } = await makeTab()
      tab.baton.operatorAct({ userId: 1, name: 'Ana' })
      tab.baton.presence(1, false)
      await tab.close('closed_by_user')
      vi.advanceTimersByTime(60_000)
      expect(tab.takeAgentNotices()).toEqual([])
      expect(tab.baton.state().kind).toBe('operator')
    } finally {
      vi.useRealTimers()
    }
  })

  it('state() inicial: about:blank, 1280×800, sem diálogo, sandbox conforme o host', async () => {
    const { tab } = await makeTab({ sandbox: false })
    expect(tab.state()).toEqual({
      url: 'about:blank', title: '', loading: false, crashed: false,
      viewport: { width: 1280, height: 800 }, dialog: null, notices: [], lastAction: null, sandbox: false,
    })
  })
})
