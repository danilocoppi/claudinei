import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerStatic } from '../src/static.js'

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dist-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Claudinei</title>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  return dir
}

let app: FastifyInstance
afterEach(() => app?.close())

describe('registerStatic', () => {
  beforeEach(() => { app = Fastify() })

  it('GET / serve o index.html', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Claudinei')
  })

  it('GET de uma rota SPA (não-api) devolve index.html (fallback)', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/qualquer/rota' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Claudinei')
  })

  it('GET de asset real é servido', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('console.log')
  })

  it('/api/inexistente NÃO vira index.html (404 normal)', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/api/nao-existe' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('Claudinei')
  })

  it('/ws/x também 404 (não index.html)', async () => {
    await registerStatic(app, makeDist())
    const res = await app.inject({ method: 'GET', url: '/ws/x' })
    expect(res.statusCode).toBe(404)
  })
})

describe('rebuild do web/dist com o servidor no ar', () => {
  beforeEach(() => { app = Fastify() })

  // Regressão (2026-09-05, "tela branca"): `npm run build -w web` gera assets com
  // hash novo. Se o static congela a lista de arquivos no register, o bundle novo
  // cai no fallback SPA e o browser recebe HTML no lugar do JS — tela branca até
  // reiniciar o servidor.
  it('serve asset criado DEPOIS do register (rebuild em runtime)', async () => {
    const dist = makeDist()
    await registerStatic(app, dist)
    writeFileSync(join(dist, 'assets', 'index-NOVOHASH.js'), 'console.log("novo")')
    const res = await app.inject({ method: 'GET', url: '/assets/index-NOVOHASH.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('novo')
    expect(res.headers['content-type']).toMatch(/javascript/)
  })
})
