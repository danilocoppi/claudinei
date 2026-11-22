import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolveChromium } from '../src/browser/chromium.js'
import { createBrowserHost } from '../src/browser/host.js'
import { agentOps, statusLine, PAGE_BUSY, type AgentOps } from '../src/browser/agent-ops.js'
import type { TerminalTab } from '../src/browser/terminal-tab.js'
import type { TabCloseReason } from '../src/browser/types.js'

const KEY = { projectId: 1, engine: 'claude' }

// Página do ensaio: botão "Enviar" que troca o título, campo de senha preenchido
// com hunter2 pelo próprio script e um botão que abre um `confirm`.
const PAGE = `<!doctype html><title>Formulario</title>
<label>Senha <input type="password" id="pw"></label>
<button onclick="document.title = 'enviado'">Enviar</button>
<button onclick="document.title = confirm('certeza?') ? 'sim' : 'nao'">Confirmar</button>
<script>document.getElementById('pw').value = 'hunter2'; console.log('pronto')</script>`

// Senha dentro de uma shadow root aberta (a snapshot ARIA desce nela).
const SHADOW = `<!doctype html><title>Sombra</title><div id="host"></div>
<script>const r = document.getElementById('host').attachShadow({ mode: 'open' })
r.innerHTML = '<label>Senha <input type="password" id="pw"></label>'
r.getElementById('pw').value = 'segredoShadow'</script>`

// A thread principal presa num laço logo depois do load.
const BUSY = `<!doctype html><title>Ocupada</title><p>ocupada</p>
<script>setTimeout(() => { for (;;) {} }, 200)</script>`

const PAGES: Record<string, string> = { '/': PAGE, '/shadow': SHADOW, '/busy': BUSY }

/** A ref da linha com o papel e o nome dados. */
function refOf(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`- ${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`).exec(snapshot)
  if (!m) throw new Error(`sem ${role} "${name}" na snapshot:\n${snapshot}`)
  return m[1]
}

// Chromium de verdade (chromium_headless_shell-1255) e um servidor http local em
// porta efêmera: pulado na máquina que não tem o Chromium.
describe.skipIf(!resolveChromium().ok)('agentOps com o Chromium de verdade', () => {
  const host = createBrowserHost({ log: () => {} })
  let server: Server
  let base = ''
  let tab: TerminalTab
  let ops: AgentOps

  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = PAGES[req.url ?? '']
      if (!html) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    tab = await host.tab(KEY)
    ops = agentOps(tab, { closeTab: (reason) => host.closeTab(KEY, reason) })
  }, 60_000)

  afterAll(async () => {
    await host.shutdown()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('a snapshot traz referências e não traz a senha; o clique pela ref dispara o handler', async () => {
    expect(await ops.open(`${base}/`)).toBe(`opened ${base}/`)
    const snap = await ops.snapshot()
    expect(snap).toContain('[ref=')
    expect(snap).not.toContain('hunter2')
    expect(snap).toContain('••••')
    const ref = refOf(snap, 'button', 'Enviar')
    expect(await ops.act({ action: 'click', ref })).toBe("clicked 'Enviar'")
    await vi.waitFor(async () => expect(await tab.page().title()).toBe('enviado'), { timeout: 5_000, interval: 50 })
    const last = tab.state().lastAction
    expect(last?.text).toBe("clicked 'Enviar'")
    expect(last?.point?.x).toBeGreaterThan(0)
    expect(ops.console()).toContainEqual({ type: 'log', text: 'pronto' })
  }, 30_000)

  it('diálogo pendente: o clique que o abre volta na hora; a leitura segue; a resposta solta a página', async () => {
    await ops.navigate({ url: `${base}/` })
    const snap = await ops.snapshot()
    const t0 = Date.now()
    expect(await ops.act({ action: 'click', ref: refOf(snap, 'button', 'Confirmar') })).toBe("clicked 'Confirmar'")
    expect(statusLine(tab)).toContain('Notice: dialog pending: confirm "certeza?"')
    // Nada fica preso atrás do diálogo (o prazo das ações é 10 s).
    await expect(ops.act({ action: 'click', ref: refOf(snap, 'button', 'Enviar') })).rejects.toMatchObject({ code: 'dialog_pending' })
    await expect(ops.screenshot()).rejects.toMatchObject({ code: 'dialog_pending' })
    expect(await ops.snapshot()).toContain('confirm "certeza?"')
    expect(Date.now() - t0).toBeLessThan(5_000)

    expect(await ops.act({ action: 'dialog', accept: true })).toBe('answered dialog: accept')
    await vi.waitFor(async () => expect(await tab.page().title()).toBe('sim'), { timeout: 5_000, interval: 50 })
    // Respondido, a página volta a ser lida e capturada.
    expect(await ops.snapshot()).toContain('[ref=')
    const png = await ops.screenshot()
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  }, 30_000)

  it('a senha dentro de uma shadow root aberta sai mascarada', async () => {
    await ops.navigate({ url: `${base}/shadow` })
    const snap = await ops.snapshot()
    expect(snap).toMatch(/textbox "Senha" \[ref=\w+\]: ••••/)
    expect(snap).not.toContain('segredoShadow')
  }, 30_000)

  it('a ref de antes da navegação falha na hora com stale_ref', async () => {
    await ops.navigate({ url: `${base}/` })
    const ref = refOf(await ops.snapshot(), 'button', 'Enviar')
    await ops.navigate({ action: 'reload' })
    const t0 = Date.now()
    await expect(ops.act({ action: 'click', ref })).rejects.toMatchObject({ code: 'stale_ref' })
    expect(Date.now() - t0).toBeLessThan(2_000)
  }, 30_000)

  it('close com um diálogo pendente fecha a aba com o motivo do agente', async () => {
    await ops.navigate({ url: `${base}/` })
    const snap = await ops.snapshot()
    await ops.act({ action: 'click', ref: refOf(snap, 'button', 'Confirmar') })
    expect(tab.state().dialog).not.toBeNull()
    const reasons: TabCloseReason[] = []
    tab.onClosed((r) => reasons.push(r))
    await ops.close()
    expect(reasons).toEqual(['closed_by_agent'])
    expect(host.existingTab(KEY)).toBeUndefined()
    await expect(ops.snapshot()).rejects.toMatchObject({ code: 'tab_gone' })
  }, 30_000)

  it('página presa num laço: a snapshot recusa com PAGE_BUSY no prazo curto, e o close solta a aba', async () => {
    tab = await host.tab(KEY)
    ops = agentOps(tab, { closeTab: (reason) => host.closeTab(KEY, reason) })
    await ops.open(`${base}/busy`)
    await new Promise((r) => setTimeout(r, 500))
    const t0 = Date.now()
    await expect(ops.snapshot()).rejects.toThrow(PAGE_BUSY)
    expect(Date.now() - t0).toBeLessThan(8_000)
    await ops.close()
    expect(host.existingTab(KEY)).toBeUndefined()
  }, 30_000)
})
