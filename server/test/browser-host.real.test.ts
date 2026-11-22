import { describe, it, expect, afterAll } from 'vitest'
import { resolveChromium } from '../src/browser/chromium.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserHost } from '../src/browser/host.js'
import { createCheckShots } from '../src/pages/check-parts.js'
import { runCheck } from '../src/pages/check.js'
import { withDoctype } from '../src/pages/height-script.js'

// Chromium de verdade (chromium_headless_shell-1255): pulado na máquina que não o tem.
describe.skipIf(!resolveChromium().ok)('BrowserHost com o Chromium de verdade', () => {
  const host = createBrowserHost({ log: () => {} })
  afterAll(() => host.shutdown())

  it('página isolada: load, PNG, altura e console', async () => {
    const out = await host.withIsolatedPage({ viewport: { width: 800, height: 600 } }, async (page) => {
      const { loaded } = await page.setContent('<h1>ok</h1><script>console.log("oi")</script>')
      const png = await page.screenshot({ fullPage: false })
      return { loaded, png, height: await page.contentHeight(), messages: page.consoleMessages() }
    })
    expect(out.loaded).toBe(true)
    expect(out.png.subarray(0, 4).toString('latin1')).toBe('\x89PNG')
    expect(out.height).toBeGreaterThan(0)
    expect(out.messages).toContainEqual({ type: 'log', text: 'oi' })
  }, 60_000)

  it('contentHeight: página baixa fica abaixo do viewport; margens e conteúdo alto contam', async () => {
    const measure = (html: string) => host.withIsolatedPage({ viewport: { width: 1024, height: 800 } }, async (page) => {
      await page.setContent(html)
      return page.contentHeight()
    })
    // Body vazio: só a margem padrão do body (8 px, as duas colapsadas).
    const empty = await measure('<!doctype html><html><body></body></html>')
    expect(empty).toBeGreaterThan(0)
    expect(empty).toBeLessThan(40)
    // Um título: bem menos que os 800 do viewport.
    const low = await measure('<!doctype html><h1>ok</h1>')
    expect(low).toBeGreaterThan(empty)
    expect(low).toBeLessThan(200)
    // As margens do body entram na altura.
    const margins = await measure('<!doctype html><body style="margin:100px"><p>oi</p></body>')
    expect(margins).toBeGreaterThanOrEqual(200)
    expect(margins).toBeLessThan(400)
    // Conteúdo alto: a altura inteira, com as margens.
    expect(await measure('<!doctype html><body><div style="height:3000px"></div></body>')).toBe(3016)
  }, 60_000)

  it('contentHeight: página de 300 px; sem doctype, o modo quirks mede o viewport', async () => {
    const measure = (html: string) => host.withIsolatedPage({ viewport: { width: 1024, height: 800 } }, async (page) => {
      await page.setContent(html)
      return page.contentHeight()
    })
    const page300 = '<div style="height:300px"></div>'
    // 300 px com as margens do body: abaixo do viewport.
    expect(await measure(withDoctype(page300))).toBe(316)
    // Sem doctype (modo quirks) o body estica até o viewport: é por isso que
    // show_page e check_page acrescentam o doctype.
    expect(await measure(page300)).toBe(800)
  }, 60_000)

  it('runCheck: o PNG da página baixa sai na altura do conteúdo, não na do viewport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudinei-check-real-'))
    try {
      const shots = createCheckShots({ dir: join(dir, 'shots') })
      const r = await runCheck(host, '<!doctype html><h1>ok</h1>', 1024, shots, { settleMs: 0 })
      const png = Buffer.from(r.png, 'base64')
      expect(r.height).toBeLessThan(200)
      expect(r.cropped).toBe(false)
      expect(png.readUInt32BE(16)).toBe(1024)
      expect(png.readUInt32BE(20)).toBe(Math.max(120, r.height))

      const tall = await runCheck(host, '<!doctype html><body><div style="height:3000px"></div></body>', 1024, shots, { settleMs: 0 })
      expect(tall).toMatchObject({ height: 3016, cropped: true })
      expect(Buffer.from(tall.png, 'base64').readUInt32BE(20)).toBe(2000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
