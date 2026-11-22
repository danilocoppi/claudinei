// As ferramentas `browser_*` do hermes (Task 8 do navegador embutido): sobem
// o hermes pelo shim de dev, como em hermes-mode.test.ts, contra um servidor
// HTTP falso que registra as chamadas a `/api/hermes/browser/:op`.
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import http from 'node:http'
import { loadInstructions } from '../src/hermes/instructions.js'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')

const TOOLS = [
  'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_act',
  'browser_wait', 'browser_screenshot', 'browser_console', 'browser_close',
]

const PROJECTS = [{ id: 1, name: 'Claudinei', group: 'Ferramentas' }, { id: 2, name: 'Loja' }]

interface Got { op: string; body: any }

/** O Claudinei falso: `/api/hermes/projects` para as instructions; cada `browser/:op` responde por `respond`. */
async function fakeApi(respond: (op: string, body: any) => [number, object]) {
  const got: Got[] = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const m = /^\/api\/hermes\/browser\/([a-z]+)$/.exec(req.url ?? '')
      if (m && req.method === 'POST') {
        const body = JSON.parse(raw)
        got.push({ op: m[1], body })
        const [code, payload] = respond(m[1], body)
        res.statusCode = code
        res.end(JSON.stringify(payload))
        return
      }
      if (req.url?.startsWith('/api/hermes/projects')) { res.end(JSON.stringify(PROJECTS)); return }
      res.end('[]')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  return { got, url, close: () => { srv.closeAllConnections(); srv.close() } }
}

const children: ReturnType<typeof spawn>[] = []
afterEach(() => { for (const c of children.splice(0)) c.kill() })

/** Sobe o hermes, faz o initialize e manda as chamadas em ordem; devolve o initialize e as respostas. */
async function hermes(api: string, env: Record<string, string>, calls: object[]) {
  const child = spawn(process.execPath, [join(serverDir, 'hermes', 'hermes-mcp.mjs')], {
    env: { ...process.env, CLAUDINEI_API: api, CLAUDINEI_PROJECT_ID: '1', ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  children.push(child)
  let out = ''
  child.stdout!.on('data', (d) => { out += d })
  const send = (o: object) => child.stdin!.write(JSON.stringify(o) + '\n')
  const wait = (id: number) => new Promise<any>((resolve) => {
    const t0 = Date.now()
    const i = setInterval(() => {
      const l = out.split('\n').find((x) => x.includes(`"id":${id},`) || x.endsWith(`"id":${id}}`))
      if (l || Date.now() - t0 > 10000) { clearInterval(i); resolve(l ? JSON.parse(l) : undefined) }
    }, 25)
  })
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  const init = await wait(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const results: any[] = []
  for (const [k, c] of calls.entries()) { send({ jsonrpc: '2.0', id: 10 + k, ...c }); results.push(await wait(10 + k)) }
  return { init, results }
}

const call = (name: string, args: object = {}) => ({ method: 'tools/call', params: { name, arguments: args } })
const OK = (op: string): [number, object] => [200, { text: `did ${op}`, status: 'Browser: http://127.0.0.1:5173/ | App | control: agent' }]

describe('ferramentas browser_* do hermes', () => {
  it('tools/list traz as oito ferramentas', async () => {
    const { results: [r] } = await hermes('http://127.0.0.1:1', {}, [{ method: 'tools/list', params: {} }])
    const names = r.result.tools.map((t: any) => t.name)
    for (const n of TOOLS) expect(names).toContain(n)
  }, 20000)

  it("cada descrição tem ≤ 2000 caracteres e nenhuma contém 'only when'", async () => {
    const { results: [r] } = await hermes('http://127.0.0.1:1', {}, [{ method: 'tools/list', params: {} }])
    const byName = new Map<string, any>(r.result.tools.map((t: any) => [t.name, t]))
    for (const n of TOOLS) {
      const d: string = byName.get(n).description
      expect(d.length, n).toBeLessThanOrEqual(2000)
      expect(d.toLowerCase(), n).not.toContain('only when')
      expect(d, n).toMatch(/live/i)
    }
    const all = TOOLS.map((n) => byName.get(n).description as string).join('\n')
    expect(all).toContain('about:blank')
    expect(all).toMatch(/https?:/)
    expect(byName.get('browser_act').description).toMatch(/ref.*browser_snapshot/)
    expect(all).toMatch(/operator.*control/i)
    expect(all).toMatch(/evaluate/)
    expect(all).toMatch(/curl/)
    expect(byName.get('browser_open').description).toContain('http://127.0.0.1:<port>')
    expect(byName.get('browser_navigate').inputSchema.properties.action.enum).toEqual(['back', 'forward', 'reload'])
  }, 20000)

  it('as instructions geradas são idênticas às de antes', async () => {
    const api = await fakeApi(OK)
    const { init } = await hermes(api.url, {}, [])
    const direct = await loadInstructions({ api: api.url, projectId: 1 })
    api.close()
    expect(init.result.instructions).toBe(direct)
  }, 20000)

  it('browser_navigate sem url e sem action → isError', async () => {
    const api = await fakeApi(OK)
    const { results: [r] } = await hermes(api.url, {}, [call('browser_navigate', {})])
    api.close()
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/exactly one of url or action/)
    expect(api.got).toHaveLength(0)
  }, 20000)

  it('browser_navigate com url e action → isError; com um só, chama a rota', async () => {
    const api = await fakeApi(OK)
    const { results: [both, one] } = await hermes(api.url, {}, [
      call('browser_navigate', { url: 'http://127.0.0.1:5173/', action: 'reload' }),
      call('browser_navigate', { action: 'back' }),
    ])
    api.close()
    expect(both.result.isError).toBe(true)
    expect(one.result.isError).toBeFalsy()
    expect(api.got).toEqual([{ op: 'navigate', body: { projectId: 1, engine: 'claude', action: 'back' } }])
  }, 20000)

  it('browser_screenshot devolve um bloco image/png e um texto com o caminho', async () => {
    const api = await fakeApi((op) => [200, { text: 'screenshot of x', status: 'Browser: x | t | control: agent', png: 'iVBORw0KGgo=', path: '/tmp/up/navegador.png' }])
    const { results: [r] } = await hermes(api.url, {}, [call('browser_screenshot', { fullPage: true })])
    api.close()
    expect(api.got).toEqual([{ op: 'screenshot', body: { projectId: 1, engine: 'claude', fullPage: true } }])
    expect(r.result.isError).toBeFalsy()
    expect(r.result.content).toEqual([
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: 'saved at /tmp/up/navegador.png\nBrowser: x | t | control: agent' },
    ])
  }, 20000)

  it('erro 409 do servidor vira isError com o texto do servidor', async () => {
    const msg = "The operator is controlling the browser. Do not retry in a loop; read-only tools still work; ask the operator to click 'Return to agent' if you need it"
    const api = await fakeApi(() => [409, { error: msg, code: 'operator_in_control' }])
    const { results: [r] } = await hermes(api.url, {}, [call('browser_act', { action: 'click', ref: 'e6' })])
    api.close()
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain(msg)
    expect(r.result.content[0].text).toContain('operator_in_control')
  }, 20000)

  it('a dica do erro vai junto ao texto', async () => {
    const api = await fakeApi(() => [503, { error: 'Browser not installed', code: 'browser_not_installed', hint: 'run the install command' }])
    const { results: [r] } = await hermes(api.url, {}, [call('browser_open', {})])
    api.close()
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toContain('Browser not installed')
    expect(r.result.content[0].text).toContain('run the install command')
  }, 20000)

  it('servidor fora do ar vira isError, sem exceção', async () => {
    const { results: [r] } = await hermes('http://127.0.0.1:1', {}, [call('browser_console')])
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/^browser_console failed/)
  }, 20000)

  it("engine ausente vai como 'claude'; presente, vai como está", async () => {
    const api = await fakeApi(OK)
    await hermes(api.url, {}, [call('browser_open', { url: 'http://127.0.0.1:5173/' })])
    await hermes(api.url, { CLAUDINEI_ENGINE: 'codex' }, [call('browser_snapshot', { depth: 4 })])
    api.close()
    expect(api.got).toEqual([
      { op: 'open', body: { projectId: 1, engine: 'claude', url: 'http://127.0.0.1:5173/' } },
      { op: 'snapshot', body: { projectId: 1, engine: 'codex', depth: 4 } },
    ])
  }, 20000)

  it('o resultado é o texto e a linha de estado; cada ferramenta chama a sua rota com os argumentos', async () => {
    const api = await fakeApi(OK)
    const { results } = await hermes(api.url, {}, [
      call('browser_act', { action: 'fill', ref: 'e6', text: 'oi' }),
      call('browser_act', { action: 'scroll', dx: 0, dy: 400 }),
      call('browser_act', { action: 'dialog', accept: false }),
      call('browser_wait', { text: 'Pronto' }),
      call('browser_wait', { seconds: 2 }),
      call('browser_console'),
      call('browser_close'),
    ])
    api.close()
    for (const r of results) expect(r.result.isError).toBeFalsy()
    expect(results[0].result.content).toEqual([{ type: 'text', text: 'did act\nBrowser: http://127.0.0.1:5173/ | App | control: agent' }])
    const base = { projectId: 1, engine: 'claude' }
    expect(api.got).toEqual([
      { op: 'act', body: { ...base, action: 'fill', ref: 'e6', text: 'oi' } },
      { op: 'act', body: { ...base, action: 'scroll', dx: 0, dy: 400 } },
      { op: 'act', body: { ...base, action: 'dialog', accept: false } },
      { op: 'wait', body: { ...base, text: 'Pronto' } },
      { op: 'wait', body: { ...base, seconds: 2 } },
      { op: 'console', body: base },
      { op: 'close', body: base },
    ])
  }, 30000)
})
