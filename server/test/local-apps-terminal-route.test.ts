import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb, type Db } from '../src/db.js'
import { createSessionManager } from '../src/claude/manager.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

let db: Db
let app: FastifyInstance

const has = (...bins: string[]) => (bin: string) => bins.includes(bin)

const monta = async (available: (bin: string) => boolean) => {
  app = await buildApp({
    db,
    manager: createSessionManager({ db, broadcast: () => {} }),
    config: loadConfig({}),
    localApps: { available, platform: 'linux', launch: () => {} },
  })
}

beforeEach(async () => {
  db = openDb(':memory:')
  await monta(has('x-terminal-emulator', 'gnome-terminal', 'kitty'))
})
afterEach(async () => { await app.close() })

/**
 * "x-terminal-emulator" é a escolha certa em tese, mas nesta máquina resolvia para
 * o terminator — que não é o terminal que o dono usa. Em vez de adivinhar melhor,
 * a lista deixa escolher.
 */
describe('GET /api/local-apps/terminals', () => {
  it('lista os instalados, com nome de gente', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/local-apps/terminals' })
    expect(r.statusCode).toBe(200)
    expect(r.json().options).toEqual([
      { id: 'x-terminal-emulator', label: 'Padrão do sistema' },
      { id: 'gnome-terminal', label: 'GNOME Terminal' },
      { id: 'kitty', label: 'kitty' },
    ])
  })

  it('sem escolha feita, o escolhido é nulo (vale o padrão do sistema)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/local-apps/terminals' })).json().chosen).toBeNull()
  })

  /** Pela rede, abrir terminal é na máquina ERRADA — a do servidor, não a de quem pede. */
  it('só responde para quem está na máquina do servidor', async () => {
    const r = await app.inject({
      method: 'GET', url: '/api/local-apps/terminals', remoteAddress: '10.0.0.9',
    })
    expect(r.json().options).toEqual([])
  })
})

describe('PUT /api/local-apps/terminals', () => {
  it('grava a escolha e devolve na leitura seguinte', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/local-apps/terminals', payload: { terminal: 'kitty' } })
    expect(put.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/local-apps/terminals' })).json().chosen).toBe('kitty')
  })

  it('a escolha sobrevive ao reinício', async () => {
    await app.inject({ method: 'PUT', url: '/api/local-apps/terminals', payload: { terminal: 'kitty' } })
    await app.close()
    await monta(has('x-terminal-emulator', 'gnome-terminal', 'kitty'))
    expect((await app.inject({ method: 'GET', url: '/api/local-apps/terminals' })).json().chosen).toBe('kitty')
  })

  it('nulo volta ao padrão do sistema', async () => {
    await app.inject({ method: 'PUT', url: '/api/local-apps/terminals', payload: { terminal: 'kitty' } })
    await app.inject({ method: 'PUT', url: '/api/local-apps/terminals', payload: { terminal: null } })
    expect((await app.inject({ method: 'GET', url: '/api/local-apps/terminals' })).json().chosen).toBeNull()
  })

  /**
   * O valor gravado vira o COMANDO que a máquina executa. É uma chave de lista
   * fechada, exatamente como a ação — nunca texto livre.
   */
  it('recusa o que não é um terminal conhecido', async () => {
    for (const evil of ['rm -rf /', 'bash', '../x', 42, {}]) {
      const r = await app.inject({ method: 'PUT', url: '/api/local-apps/terminals', payload: { terminal: evil } })
      expect(r.statusCode, JSON.stringify(evil)).toBe(400)
    }
    expect((await app.inject({ method: 'GET', url: '/api/local-apps/terminals' })).json().chosen).toBeNull()
  })

  /** Escolher pela rede seria mexer na máquina de outra pessoa. */
  it('só aceita da máquina do servidor', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/local-apps/terminals', payload: { terminal: 'kitty' }, remoteAddress: '10.0.0.9',
    })
    expect(r.statusCode).toBe(403)
  })

  /** Escolher um que não está instalado deixaria o botão morto. */
  it('recusa terminal que não existe nesta máquina', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/local-apps/terminals', payload: { terminal: 'konsole' } })
    expect(r.statusCode).toBe(400)
  })
})
