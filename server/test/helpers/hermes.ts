import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import http from 'node:http'

/**
 * Dublês para testar as ferramentas do Hermes de ponta a ponta: o MCP de
 * verdade (o shim de dev) falando por stdio com uma API falsa. Cópia de
 * `hermesCall` e `fakeApi` de `hermes-mode.test.ts`, que não muda.
 */

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Sobe o MCP, faz o initialize e manda as chamadas em ordem; devolve as respostas. */
export const hermesCall = async (api: string, env: Record<string, string>, calls: object[]) => {
  const child = spawn(process.execPath, [join(serverDir, 'hermes', 'hermes-mcp.mjs')], {
    env: { ...process.env, CLAUDINEI_API: api, CLAUDINEI_PROJECT_ID: '1', ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  const wait = (id: number) => new Promise<any>((resolve) => {
    const t0 = Date.now()
    const i = setInterval(() => {
      const l = out.split('\n').find((x) => x.includes(`"id":${id}`))
      if (l || Date.now() - t0 > 10000) { clearInterval(i); resolve(l ? JSON.parse(l) : undefined) }
    }, 25)
  })
  await wait(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const results: any[] = []
  for (const [k, c] of calls.entries()) { send({ jsonrpc: '2.0', id: 10 + k, ...c }); results.push(await wait(10 + k)) }
  child.kill()
  return results
}

/** API falsa: responde `respond(corpo)` no `path` e `[]` no resto; guarda os corpos recebidos. */
export const fakeApi = async (respond: (body: any) => [number, object], path = '/api/hermes/progress') => {
  const got: any[] = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === path) {
        const body = JSON.parse(raw)
        got.push(body)
        const [code, payload] = respond(body)
        res.statusCode = code; res.end(JSON.stringify(payload)); return
      }
      res.end('[]')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return { got, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() }
}
