// `--browser-selftest`: sobe o host, abre uma página isolada e captura. Roda sem
// banco nem porta; serve para conferir o binário empacotado (playwright-core
// achado pelo NODE_PATH, desvio do inspector, Chromium da máquina).
import { createBrowserHost, type BrowserHostDeps } from './host.js'

export async function browserSelfTest(log: (line: string) => void, deps: Omit<BrowserHostDeps, 'log'> = {}): Promise<number> {
  const host = createBrowserHost({ ...deps, log: (l) => log(`[navegador] ${l}`) })
  try {
    const out = await host.withIsolatedPage({ viewport: { width: 800, height: 600 } }, async (page) => {
      const { loaded } = await page.setContent('<h1>ok</h1>')
      const png = await page.screenshot({ fullPage: false })
      return { loaded, pngBytes: png.length, height: await page.contentHeight() }
    })
    log(JSON.stringify({ status: host.status().state, ...out }))
    return out.pngBytes > 0 ? 0 : 1
  } catch (err) {
    const e = err as { message?: string; code?: string; hint?: string }
    log(JSON.stringify({ status: host.status().state, reason: host.status().reason, code: e.code, error: e.message ?? String(err), hint: e.hint }))
    return 1
  } finally {
    await host.shutdown()
  }
}
