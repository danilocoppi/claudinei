import { describe, it, expect, afterAll } from 'vitest'
import { resolveChromium } from '../src/browser/chromium.js'
import { createBrowserHost } from '../src/browser/host.js'

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
})
