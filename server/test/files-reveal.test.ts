import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerFileRoutes } from '../src/routes/files.js'

let app: FastifyInstance
let root: string
let revealed: string[]

const projects = {
  get: (id: number) => (id === 1 ? { id: 1, name: 'Alfa', path: root } : undefined),
} as never

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'reveal-'))
  mkdirSync(join(root, 'engine'))
  writeFileSync(join(root, 'engine', 'sizing.js'), 'x')
  revealed = []
  app = Fastify()
  registerFileRoutes(app, { projects, revealInFolder: (dir: string) => { revealed.push(dir) } })
  await app.ready()
})
afterEach(async () => { await app.close() })

const reveal = (payload: object, ip?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/files/reveal',
    payload,
    ...(ip ? { remoteAddress: ip } : {}),
  })

describe('POST /api/files/reveal', () => {
  it('abre a PASTA do arquivo pedido', async () => {
    const res = await reveal({ path: 'engine/sizing.js', projectId: 1 })
    expect(res.statusCode).toBe(200)
    expect(revealed).toEqual([join(root, 'engine')])
  })

  /**
   * Esconder o item no menu não basta: a rota executa um programa na máquina do
   * servidor, então quem chega de fora precisa ser barrado no backend também.
   */
  it('recusa requisição que não vem do próprio host', async () => {
    const res = await reveal({ path: 'engine/sizing.js', projectId: 1 }, '192.168.0.55')
    expect(res.statusCode).toBe(403)
    expect(revealed).toEqual([])
  })

  /**
   * Mesma política do resolveInScope usado por /api/files/content: admin (e o modo
   * local sem auth, que é tratado como admin) alcança caminho fora do projeto —
   * abrir uma pasta da própria máquina não amplia o que ele já pode fazer. Para
   * não-admin o resolveInScope devolve exists:false, e a rota responde 404.
   */
  it('admin local alcança caminho fora do projeto (política do resolveInScope)', async () => {
    const res = await reveal({ path: '/etc/hosts', projectId: 1 })
    expect(res.statusCode).toBe(200)
    expect(revealed).toEqual(['/etc'])
  })

  it('recusa arquivo inexistente', async () => {
    const res = await reveal({ path: 'engine/naoexiste.js', projectId: 1 })
    expect(res.statusCode).toBe(404)
    expect(revealed).toEqual([])
  })

  it('recusa sem projeto', async () => {
    const res = await reveal({ path: 'engine/sizing.js' })
    expect(res.statusCode).toBe(404)
    expect(revealed).toEqual([])
  })
})
