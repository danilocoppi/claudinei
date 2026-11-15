import { describe, it, expect } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import http from 'node:http'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('entry multi-modo (--hermes)', () => {
  it('--hermes sobe o MCP (responde a um initialize por stdio) e NÃO sobe o servidor HTTP', () => {
    const req = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) + '\n'
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(serverDir, 'src', 'index.ts'), '--hermes'],
      {
        input: req,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, CLAUDINEI_API: 'http://127.0.0.1:1', CLAUDINEI_PROJECT_ID: '0' },
      },
    )
    // A intenção principal: --hermes é modo MCP, não modo servidor — nunca deve
    // logar o boot HTTP nem tentar abrir a porta 9105 (ou qualquer outra).
    expect(r.stdout).not.toMatch(/Termaster server em http:\/\//)
    // E deve de fato responder ao handshake MCP (initialize) por stdio.
    expect(r.stdout).toMatch(/"result"|"serverInfo"|hermes/i)
    // --hermes não pode puxar os módulos nativos do modo servidor (better-sqlite3,
    // node-pty, sherpa/libstdc++): no binário empacotado eles só são extraídos no
    // modo servidor, então carregá-los aqui quebraria. index.ts importa esses
    // módulos dinamicamente dentro do ramo servidor (else do --hermes), então um
    // erro de carregamento nativo nunca deveria aparecer no stderr deste modo.
    expect(r.stderr).not.toMatch(/better.sqlite3|node-pty|GLIBCXX|cannot open shared|sherpa/i)
  })

  // Regressão: o shim de dev (server/hermes/hermes-mcp.mjs) é o `command` do mcp-config
  // em dev. Ele DEVE repassar CLAUDINEI_SERVICE_TOKEN ao runHermes — senão, com auth
  // ligada, toda tool bate em /api/hermes|/api/orchestrator SEM Authorization e toma
  // 401, e a colaboração entre agentes falha calada.
  it('o shim de dev repassa o CLAUDINEI_SERVICE_TOKEN como Bearer nas chamadas à API', async () => {
    let gotAuth: string | null | undefined = undefined
    const srv = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/hermes/board')) gotAuth = req.headers.authorization ?? null
      res.setHeader('content-type', 'application/json')
      res.end('[]')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    const child = spawn(process.execPath, [join(serverDir, 'hermes', 'hermes-mcp.mjs')], {
      env: { ...process.env, CLAUDINEI_API: `http://127.0.0.1:${port}`, CLAUDINEI_PROJECT_ID: '1', CLAUDINEI_SERVICE_TOKEN: 'TOKEN-XYZ' },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    await new Promise((r) => setTimeout(r, 500))
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_board', arguments: {} } })
    await new Promise<void>((resolve) => {
      const t0 = Date.now()
      const i = setInterval(() => {
        if (gotAuth !== undefined || Date.now() - t0 > 8000) { clearInterval(i); resolve() }
      }, 50)
    })
    child.kill()
    srv.close()
    expect(gotAuth).toBe('Bearer TOKEN-XYZ')
  }, 15000)
  // Instructions do MCP: dizem ao agente em que projeto está e a regra da
  // mensagem de outro projeto (ver src/hermes/instructions.ts).
  const initialize = async (api: string, projectId: string) => {
    const child = spawn(process.execPath, [join(serverDir, 'hermes', 'hermes-mcp.mjs')], {
      env: { ...process.env, CLAUDINEI_API: api, CLAUDINEI_PROJECT_ID: projectId },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const t0 = Date.now()
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n')
    const line = await new Promise<string>((resolve) => {
      const i = setInterval(() => {
        const l = out.split('\n').find((x) => x.includes('"id":1'))
        if (l || Date.now() - t0 > 12000) { clearInterval(i); resolve(l ?? '') }
      }, 25)
    })
    const ms = Date.now() - t0
    child.kill()
    return { result: line ? JSON.parse(line).result : undefined, ms }
  }

  it('initialize traz as instructions com o projeto do terminal', async () => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(req.url?.startsWith('/api/hermes/projects')
        ? JSON.stringify([{ id: 1, name: 'Claudinei', group: 'Ferramentas' }, { id: 2, name: 'Loja' }])
        : '[]')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    const { result } = await initialize(`http://127.0.0.1:${port}`, '1')
    srv.close()
    expect(result?.instructions).toContain('This terminal belongs to project "Claudinei"')
    expect(result?.instructions).toContain('"Loja"')
    expect(result?.instructions).toMatch(/belongs here/i)
  }, 15000)

  it('API fora do ar ou muda: sobe com a regra genérica em menos de 5 s', async () => {
    const fora = await initialize('http://127.0.0.1:1', '1')
    expect(fora.result?.instructions).toMatch(/belongs here/i)
    expect(fora.ms).toBeLessThan(5000)

    const muda = http.createServer(() => { /* aceita e nunca responde */ })
    await new Promise<void>((r) => muda.listen(0, '127.0.0.1', () => r()))
    const port = (muda.address() as { port: number }).port
    const lenta = await initialize(`http://127.0.0.1:${port}`, '1')
    muda.closeAllConnections(); muda.close()
    expect(lenta.result?.instructions).toMatch(/belongs here/i)
    expect(lenta.ms).toBeLessThan(5000)
  }, 20000)
})
