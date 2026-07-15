import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { mkdtempSync, readFileSync } from 'node:fs'
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
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir)).toEqual([]) // parcial removido
    await tinyApp.close()
  })
})
