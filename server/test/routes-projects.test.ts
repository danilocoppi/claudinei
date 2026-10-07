import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'
import { ClaudeSession, type SessionOptions } from '../src/claude/session.js'
import { createTerminalManager } from '../src/terminal/manager.js'
import '../src/engine/index.js' // registra as engines (terminalCommand no openInTerminal)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE = join(__dirname, 'fake-claude.mjs')
const fakeFactory = (opts: SessionOptions) =>
  new ClaudeSession({ ...opts, claudeBin: process.execPath, extraArgsOverride: [FAKE] })

const waitUntil = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let app: Awaited<ReturnType<typeof buildApp>>
let dir: string

beforeEach(async () => {
  const db = openDb(':memory:')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({ config: loadConfig({}), db, manager })
  dir = mkdtempSync(join(tmpdir(), 'tm-'))
})

describe('rotas de projetos', () => {
  it('health responde ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('POST cria e GET lista', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    expect(post.statusCode).toBe(201)
    expect(post.json().name).toBe('P1')
    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.json()).toHaveLength(1)
  })

  it('POST com path inválido retorna 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X', path: '/nao/existe' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/diretório não existe/)
  })

  it('PATCH atualiza e DELETE remove', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    const id = post.json().id
    const patch = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { color: '#00ff00' } })
    expect(patch.json().color).toBe('#00ff00')
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del.statusCode).toBe(204)
  })

  it('DELETE de projeto com sessão ativa retorna 409', async () => {
    const db = openDb(':memory:')
    const manager = createSessionManager({ db, sessionFactory: fakeFactory, broadcast: () => {} })
    const fakeApp = await buildApp({ config: loadConfig({}), db, manager })
    const post = await fakeApp.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })
    const id = post.json().id
    const sessionRes = await fakeApp.inject({ method: 'POST', url: `/api/projects/${id}/sessions` })
    const { localId } = sessionRes.json()
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'idle'
    })

    const del = await fakeApp.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del.statusCode).toBe(409)
    expect(del.json().error).toBeTruthy()

    await fakeApp.inject({ method: 'POST', url: `/api/sessions/${localId}/stop` })
    await waitUntil(() => {
      const row = db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any
      return row?.status === 'stopped'
    })

    const del2 = await fakeApp.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del2.statusCode).toBe(204)
  })
})

/**
 * Excluir um terminal com sessões abertas: sem confirmação o servidor recusa e
 * diz QUAIS estão abertas (o diálogo mostra a lista e pede o "estou ciente");
 * com `stopSessions=1` ele as finaliza — chat de várias engines e a que está no
 * terminal — e só remove depois de conferir que nenhuma ficou de pé.
 */
describe('excluir terminal com sessões abertas', () => {
  const statusOf = (db: ReturnType<typeof openDb>, localId: string) =>
    (db.prepare('SELECT status FROM sessions WHERE local_id=?').get(localId) as any)?.status

  const montar = async (opts: { travarStop?: boolean } = {}) => {
    const db = openDb(':memory:')
    const sessoes: ClaudeSession[] = []
    const ptysMortos: string[] = []
    const terminalManager = createTerminalManager({
      ptyFactory: (file) => {
        const p = {
          onData: () => {}, write: () => {}, resize: () => {},
          onExit: (cb: (e: { exitCode: number }) => void) => { p._exit = () => cb({ exitCode: 0 }) },
          kill: () => { ptysMortos.push(file); p._exit?.() },
          _exit: undefined as undefined | (() => void),
        }
        return p
      },
    })
    const manager = createSessionManager({
      db, broadcast: () => {},
      sessionFactory: (o) => {
        const s = fakeFactory(o as SessionOptions)
        // Sessão que ignora o pedido de parar: nada pode ser removido por cima dela.
        if (opts.travarStop) s.stop = async () => {}
        sessoes.push(s)
        return s
      },
      terminalLauncher: (o) => terminalManager.open(o.localId, { cwd: o.cwd, file: o.file, args: o.args, env: o.env, onExit: o.onExit }),
    })
    const app = await buildApp({ config: loadConfig({}), db, manager, terminalManager })
    const id = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P1', path: dir } })).json().id
    const abrir = async (engine: string) => {
      const { localId } = (await app.inject({ method: 'POST', url: `/api/projects/${id}/sessions`, payload: { engine } })).json()
      await waitUntil(() => statusOf(db, localId) === 'idle')
      return localId as string
    }
    return { db, app, id, manager, sessoes, ptysMortos, abrir }
  }

  it('sem confirmação, recusa e lista as sessões abertas de cada engine', async () => {
    const { app, id, abrir } = await montar()
    const claude = await abrir('claude')
    const codex = await abrir('codex')
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(del.statusCode).toBe(409)
    expect(del.json().sessions).toEqual(expect.arrayContaining([
      { localId: claude, engine: 'claude', status: 'idle' },
      { localId: codex, engine: 'codex', status: 'idle' },
    ]))
    expect(del.json().sessions).toHaveLength(2)
  })

  it('com stopSessions=1 finaliza o chat de duas engines e a sessão no terminal, e remove', async () => {
    const { db, app, id, manager, sessoes, ptysMortos, abrir } = await montar()
    await abrir('claude')
    await abrir('codex')
    const kimi = await abrir('kimi')
    await manager.openInTerminal(kimi)
    expect(statusOf(db, kimi)).toBe('in_terminal')

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}?stopSessions=1` })
    expect(del.statusCode).toBe(204)
    expect(sessoes.every((s) => s.status === 'stopped')).toBe(true)
    expect(ptysMortos).toHaveLength(1)
    expect(manager.hasActiveSession(id)).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).json()).toEqual([])
  })

  it('se uma sessão não encerra, recusa e mantém o terminal', async () => {
    const { app, id, abrir } = await montar({ travarStop: true })
    const claude = await abrir('claude')
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}?stopSessions=1` })
    expect(del.statusCode).toBe(409)
    expect(del.json().sessions).toEqual([{ localId: claude, engine: 'claude', status: 'idle' }])
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).json()).toHaveLength(1)
  })
})
