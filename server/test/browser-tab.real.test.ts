import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveChromium } from '../src/browser/chromium.js'
import { createBrowserHost } from '../src/browser/host.js'
import type { TerminalTab } from '../src/browser/terminal-tab.js'

// Marca do corpo do download: se aparecer num arquivo, o download foi gravado.
const TOKEN = `claudinei-download-${randomUUID()}`

/** Arquivos em `playwright-artifacts-*` do tmp (onde o Playwright grava downloads aceitos). */
function artifactFiles(): string[] {
  const out: string[] = []
  for (const d of readdirSync(tmpdir())) {
    if (!d.startsWith('playwright-artifacts-')) continue
    const dir = join(tmpdir(), d)
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isFile()) out.push(p)
      }
    } catch { /* pasta de outro processo sumiu no meio */ }
  }
  return out
}

// Chromium de verdade (chromium_headless_shell-1255) e um servidor http local em
// porta efêmera: pulado na máquina que não tem o Chromium.
describe.skipIf(!resolveChromium().ok)('TerminalTab com o Chromium de verdade', () => {
  const host = createBrowserHost({ log: () => {} })
  let server: Server
  let base = ''
  let tab: TerminalTab
  const hits: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      const html = (body: string, title = 'Teste') => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><title>${title}</title>${body}`)
      }
      switch (req.url) {
        case '/': return html(`<a id="nova" href="/alvo" target="_blank">abrir</a><button id="janela" onclick="window.open('/janela')">janela</button>`, 'Inicio')
        case '/janela': return html('<h1>janela</h1>', 'Janela')
        case '/alvo': return html('<h1>alvo</h1>', 'Alvo')
        case '/redir':
          res.writeHead(302, { location: 'file:///etc/passwd' })
          return res.end()
        case '/script': return html(`<button id="b" onclick="location = 'chrome://settings'">ir</button>`, 'Script')
        case '/pagina-baixar': return html('<a id="d" href="/baixar">baixar</a>', 'Baixar')
        case '/baixar':
          res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="relatorio.pdf"' })
          return res.end(TOKEN)
        default:
          res.writeHead(404)
          return res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    tab = await host.tab({ projectId: 1, engine: 'claude' })
  }, 60_000)

  afterAll(async () => {
    await host.shutdown()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('link target=_blank vira navegação na própria aba', async () => {
    await tab.navigate(`${base}/`)
    await vi.waitFor(() => expect(tab.state()).toMatchObject({ url: `${base}/`, title: 'Inicio', loading: false }), { timeout: 5_000, interval: 50 })
    await tab.page().click('#nova')
    await vi.waitFor(() => expect(tab.state()).toMatchObject({ url: `${base}/alvo`, title: 'Alvo' }), { timeout: 10_000, interval: 50 })
    expect(tab.context.pages()).toEqual([tab.page()])
  }, 30_000)

  it('window.open também vira navegação na própria aba', async () => {
    await tab.navigate(`${base}/`)
    await tab.page().click('#janela')
    await vi.waitFor(() => expect(tab.state()).toMatchObject({ url: `${base}/janela`, title: 'Janela' }), { timeout: 10_000, interval: 50 })
    expect(tab.context.pages()).toEqual([tab.page()])
  }, 30_000)

  it('Location: file:///etc/passwd não sai de http nem chega a file:', async () => {
    tab.takeAgentNotices()
    await tab.navigate(`${base}/redir`).catch(() => { /* o Chromium recusa o redirecionamento */ })
    expect(hits).toContain('/redir')
    const seen = [tab.page().url(), tab.state().url]
    for (const u of seen) {
      expect(u.startsWith('file:')).toBe(false)
      expect(u).toMatch(/^(http:|chrome-error:)/)
    }
  }, 30_000)

  it("location = 'chrome://settings' por script não tira a aba de http", async () => {
    await tab.navigate(`${base}/script`)
    await tab.page().click('#b')
    await new Promise((r) => setTimeout(r, 500))
    expect(tab.page().url().startsWith('chrome:')).toBe(false)
    expect(tab.state().url.startsWith('chrome:')).toBe(false)
  }, 30_000)

  it('download com acceptDownloads: false anota o aviso e não grava arquivo', async () => {
    tab.takeAgentNotices()
    await tab.navigate(`${base}/pagina-baixar`)
    await tab.page().click('#d')
    const expected = `download blocked: relatorio.pdf, from ${base}/baixar`
    await vi.waitFor(() => expect(tab.state().notices).toContain(expected), { timeout: 10_000, interval: 50 })
    expect(tab.takeAgentNotices()).toContain(expected)
    await new Promise((r) => setTimeout(r, 300))
    const written = artifactFiles().filter((f) => {
      try { return readFileSync(f, 'utf8').includes(TOKEN) } catch { return false }
    })
    expect(written).toEqual([])
  }, 30_000)
})
