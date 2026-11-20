import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerUploadRoutes } from '../src/routes/uploads.js'

const BOUNDARY = 'X-TEST-BOUNDARY'
function multipartBody(filename: string, content: string): string {
  return [
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    content,
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n')
}
const HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

let dir: string
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'up-'))
  app = Fastify()
  await registerUploadRoutes(app, { uploadsDir: dir })
})

describe('POST /api/uploads', () => {
  it('salva o arquivo e devolve path absoluto + nome final', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/uploads', payload: multipartBody('print.png', 'PNGDATA'), headers: HEADERS })
    expect(res.statusCode).toBe(201)
    const { path, name } = res.json()
    expect(name).toBe('001-print.png')
    expect(path).toBe(join(dir, '001-print.png'))
    expect(readFileSync(path, 'utf8')).toBe('PNGDATA')
    await app.close()
  })

  it('sem arquivo no form retorna 400', async () => {
    const payload = [`--${BOUNDARY}`, 'Content-Disposition: form-data; name="nada"', '', 'valor', `--${BOUNDARY}--`, ''].join('\r\n')
    const res = await app.inject({ method: 'POST', url: '/api/uploads', payload, headers: HEADERS })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('nome malicioso é sanitizado (fica dentro do dir)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/uploads', payload: multipartBody('../../etc/passwd', 'X'), headers: HEADERS })
    expect(res.statusCode).toBe(201)
    expect(res.json().path.startsWith(dir)).toBe(true)
    expect(res.json().path).not.toContain('..')
    await app.close()
  })

  it('arquivo acima do limite → 413 e o parcial é apagado', async () => {
    const tinyApp = Fastify()
    await registerUploadRoutes(tinyApp, { uploadsDir: dir, maxFileBytes: 8 })
    const res = await tinyApp.inject({ method: 'POST', url: '/api/uploads', payload: multipartBody('grande.bin', 'X'.repeat(64)), headers: HEADERS })
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toMatch(/grande demais/)
    expect(readdirSync(dir)).toEqual([]) // parcial removido
    await tinyApp.close()
  })
})

describe('rotação na rota de upload', () => {
  it('cem uploads não apagam o primeiro (era o teto antigo)', async () => {
    // 100 uploads anteriores, com mtimes distintos (o 001 é o mais velho, 100 h atrás),
    // todos bem dentro dos 30 dias: o 101º upload não pode derrubar o primeiro.
    for (let i = 0; i < 100; i++) {
      const f = join(dir, `${String(i + 1).padStart(3, '0')}-f.txt`)
      writeFileSync(f, 'x')
      const when = new Date(Date.now() - (100 - i) * 3_600_000)
      utimesSync(f, when, when)
    }
    const res = await app.inject({ method: 'POST', url: '/api/uploads', payload: multipartBody('novo.txt', 'X'), headers: HEADERS })
    expect(res.statusCode).toBe(201)
    expect(existsSync(join(dir, '001-f.txt'))).toBe(true)
    expect(readdirSync(dir)).toHaveLength(101)
    await app.close()
  })
})

describe('POST /api/uploads/check', () => {
  it('POST /api/uploads/check devolve os ausentes', async () => {
    const ok = join(dir, '001-ok.txt')
    writeFileSync(ok, 'x')
    const sumiu = join(dir, '002-sumiu.txt')
    const res = await app.inject({ method: 'POST', url: '/api/uploads/check', payload: { paths: [ok, sumiu, '../etc/passwd'] } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ missing: [sumiu, '../etc/passwd'] })
    await app.close()
  })

  it('lista vazia devolve missing vazio', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/uploads/check', payload: { paths: [] } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ missing: [] })
    await app.close()
  })

  it('rejeita corpo inválido com 400', async () => {
    for (const payload of [{}, { paths: 'x' }, { paths: [1] }, { paths: ['a', null] }]) {
      const res = await app.inject({ method: 'POST', url: '/api/uploads/check', payload })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })

  it('mais de 200 caminhos é 400', async () => {
    const paths = Array.from({ length: 201 }, (_, i) => join(dir, `${i}.txt`))
    const res = await app.inject({ method: 'POST', url: '/api/uploads/check', payload: { paths } })
    expect(res.statusCode).toBe(400)
    const ate200 = await app.inject({ method: 'POST', url: '/api/uploads/check', payload: { paths: paths.slice(0, 200) } })
    expect(ate200.statusCode).toBe(200)
    expect(ate200.json().missing).toHaveLength(200)
    await app.close()
  })
})
