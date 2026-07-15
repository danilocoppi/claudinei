import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTranscribeRoutes } from '../src/routes/transcribe.js'

let app: FastifyInstance
let uploadsDir: string

function build(speech: { installed(): boolean; transcribe(p: string): Promise<string> }) {
  app = Fastify()
  uploadsDir = mkdtempSync(join(tmpdir(), 'tr-'))
  return registerTranscribeRoutes(app, { speech, uploadsDir })
}
afterEach(() => app?.close())

const WAV = Buffer.from('RIFFxxxxWAVEfmt ')

describe('POST /api/transcribe', () => {
  it('200 com o texto; o tmp é apagado', async () => {
    await build({ installed: () => true, transcribe: async () => 'olá mundo' })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ text: 'olá mundo' })
    expect(readdirSync(uploadsDir)).toHaveLength(0) // limpou o wav temporário
  })
  it('503 quando o modelo não está instalado', async () => {
    await build({ installed: () => false, transcribe: async () => '' })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toMatch(/setup:speech/)
  })
  it('500 quando o engine falha (e o tmp é apagado)', async () => {
    await build({ installed: () => true, transcribe: async () => { throw new Error('engine quebrou') } })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(500)
    expect(readdirSync(uploadsDir)).toHaveLength(0)
  })
  it('504 quando dá timeout', async () => {
    await build({ installed: () => true, transcribe: async () => { throw new Error('transcrição excedeu o tempo limite') } })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(504)
  })
  it('funciona em instalação nova (uploadsDir ainda não existe)', async () => {
    await build({ installed: () => true, transcribe: async () => 'primeiro uso' })
    uploadsDir = join(uploadsDir, 'ainda-nao-existe') // regressão: mkdir sob demanda
    app.close()
    app = Fastify()
    await registerTranscribeRoutes(app, { speech: { installed: () => true, transcribe: async () => 'primeiro uso' }, uploadsDir })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: WAV, headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ text: 'primeiro uso' })
    expect(readdirSync(uploadsDir)).toHaveLength(0) // dir foi criado e o tmp limpo
  })
  it('400 sem corpo', async () => {
    await build({ installed: () => true, transcribe: async () => 'x' })
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', payload: Buffer.alloc(0), headers: { 'content-type': 'audio/wav' } })
    expect(res.statusCode).toBe(400)
  })
})
