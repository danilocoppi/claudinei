import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createWsHub } from '../src/routes/ws.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

let db: Db
let app: FastifyInstance
let pasta: string
let localId: string

const FAKE = join(new URL('.', import.meta.url).pathname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

beforeEach(async () => {
  db = openDb(':memory:')
  pasta = mkdtempSync(join(tmpdir(), 'shws-'))
  const projeto = createProjectsService(db).create({ name: 'Alvo', path: pasta })
  const manager = createSessionManager({ db, broadcast: () => {}, sessionFactory: fakeFactory })
  app = await buildApp({ db, manager, wsHub: createWsHub(), config: loadConfig({}) })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const r = await app.inject({ method: 'POST', url: `/api/projects/${projeto.id}/sessions` })
  localId = r.json().localId
})
afterEach(async () => { await app.close() })

/** Abre um WS e devolve as mensagens que chegarem, com um helper de espera. */
const conecta = async (origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`) => {
  const { port } = app.server.address() as { port: number }
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin })
  const recebidas: any[] = []
  ws.on('message', (d: Buffer) => recebidas.push(JSON.parse(d.toString())))
  await new Promise((r, rej) => { ws.once('open', r); ws.once('error', rej) })
  const espera = async (tipo: string, ms = 8000) => {
    const inicio = Date.now()
    while (Date.now() - inicio < ms) {
      const m = recebidas.find((x) => x.type === tipo)
      if (m) return m
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`não chegou "${tipo}" — chegaram: ${recebidas.map((x) => x.type).join(', ')}`)
  }
  return { ws, recebidas, espera }
}

/**
 * `!ls` no chat. Vale SÓ da máquina do servidor: pela rede, a saída seria de um
 * computador que quem pediu não está usando — e a porta de execução ficaria aberta
 * para qualquer um que tenha entrado na interface.
 */
describe('comando de shell pelo chat', () => {
  it('roda e devolve a saída na pasta do terminal', async () => {
    const c = await conecta()
    c.ws.send(JSON.stringify({ type: 'shell', localId, command: 'pwd' }))
    const m = await c.espera('shell_result')
    expect(m.localId).toBe(localId)
    expect(m.command).toBe('pwd')
    expect(m.output.trim()).toContain(pasta.replace('/private', ''))
    expect(m.isError).toBe(false)
    c.ws.close()
  })

  it('erro do comando volta marcado como erro', async () => {
    const c = await conecta()
    c.ws.send(JSON.stringify({ type: 'shell', localId, command: 'exit 3' }))
    expect((await c.espera('shell_result')).isError).toBe(true)
    c.ws.close()
  })

  it('sessão que não existe não roda nada', async () => {
    const c = await conecta()
    c.ws.send(JSON.stringify({ type: 'shell', localId: 'inventado', command: 'echo oi' }))
    const m = await c.espera('shell_result')
    expect(m.isError).toBe(true)
    expect(m.output).toMatch(/sess|not/i)
    c.ws.close()
  })

  it('comando que não é texto é ignorado', async () => {
    const c = await conecta()
    c.ws.send(JSON.stringify({ type: 'shell', localId, command: { rm: '-rf' } }))
    c.ws.send(JSON.stringify({ type: 'shell', localId, command: 'echo depois' }))
    const m = await c.espera('shell_result')
    // a primeira não produz resultado nenhum; a que chega é a segunda
    expect(m.command).toBe('echo depois')
    c.ws.close()
  })

  /** O turno da engine não pode ser afetado: o comando é do operador, não dela. */
  it('não mexe no status da sessão', async () => {
    const c = await conecta()
    // espera a sessão assentar: `starting → idle` é transição dela, não do comando
    const statusAgora = () => (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as { status: string }).status
    for (let i = 0; i < 200 && statusAgora() === 'starting'; i++) await new Promise((r) => setTimeout(r, 20))
    const antes = statusAgora()
    c.ws.send(JSON.stringify({ type: 'shell', localId, command: 'echo oi' }))
    await c.espera('shell_result')
    expect(statusAgora()).toBe(antes)
    c.ws.close()
  })
})

/**
 * O `!comando` atrás de um reverse proxy.
 *
 * Este é o caminho do WebSocket, e não o do request HTTP comum — o gate vive no
 * UPGRADE, onde a decoração `behindProxy` precisa chegar igual. Se não chegasse,
 * `isTrustedLocal` viraria `loopback && !undefined` = true, e o `!comando`
 * continuaria executando shell na máquina para qualquer um que chegasse pelo
 * proxy: exatamente o furo que o --behind-proxy fecha nas rotas HTTP.
 */
describe('!comando atrás de proxy', () => {
  it('recusa mesmo o WS vindo de loopback (que é onde o proxy conecta)', async () => {
    const db2 = openDb(':memory:')
    const pasta2 = mkdtempSync(join(tmpdir(), 'shws-proxy-'))
    const projeto2 = createProjectsService(db2).create({ name: 'Alvo', path: pasta2 })
    const manager2 = createSessionManager({ db: db2, broadcast: () => {}, sessionFactory: fakeFactory })
    const app2 = await buildApp({
      db: db2, manager: manager2, wsHub: createWsHub(), config: loadConfig({}),
      behindProxy: true,
    })
    await app2.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app2.server.address() as { port: number }
    const r = await app2.inject({ method: 'POST', url: `/api/projects/${projeto2.id}/sessions` })
    const local2 = r.json().localId

    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` })
    const recebidas: any[] = []
    ws.on('message', (d: Buffer) => recebidas.push(JSON.parse(d.toString())))
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })

    ws.send(JSON.stringify({ type: 'shell', localId: local2, command: 'echo NAO_DEVERIA_RODAR' }))
    const inicio = Date.now()
    let msg: any
    while (Date.now() - inicio < 8000 && !msg) {
      msg = recebidas.find((x) => x.type === 'shell_result')
      if (!msg) await new Promise((res) => setTimeout(res, 20))
    }
    expect(msg.isError, 'o !comando executou atrás de proxy').toBe(true)
    expect(msg.output).toMatch(/máquina do servidor/i)
    expect(msg.output).not.toContain('NAO_DEVERIA_RODAR')
    ws.close()
    await app2.close()
  })
})
