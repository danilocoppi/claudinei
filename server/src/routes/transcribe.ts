import type { FastifyInstance } from 'fastify'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechService } from '../speech/transcriber.js'

export interface TranscribeDeps {
  speech: Pick<SpeechService, 'installed' | 'transcribe'>
  uploadsDir: string
}

const MAX_WAV_BYTES = 30 * 1024 * 1024 // ~15 min de PCM16 16kHz mono

export async function registerTranscribeRoutes(app: FastifyInstance, deps: TranscribeDeps): Promise<void> {
  // WAV cru no corpo — sem multipart, o navegador manda o Blob direto
  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: MAX_WAV_BYTES }, (_req, body, done) => done(null, body))

  app.post('/api/transcribe', async (req, reply) => {
    if (!deps.speech.installed()) {
      return reply.code(503).send({ error: 'modelo de transcrição não instalado — rode "npm run setup:speech" no server' })
    }
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'corpo vazio — envie o WAV como audio/wav' })
    }
    const tmp = join(deps.uploadsDir, `mic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
    // resposta é montada aqui e só enviada após o `finally` limpar o tmp —
    // chamar reply.send() antes do unlink terminar cria uma corrida (o
    // response pode fechar antes do arquivo sumir do disco).
    let result: { code: number; body: { text: string } | { error: string } }
    try {
      // instalação nova pode não ter a pasta ainda (o upload de chat cria a dele sob demanda)
      await mkdir(deps.uploadsDir, { recursive: true })
      await writeFile(tmp, body)
      const text = await deps.speech.transcribe(tmp)
      result = { code: 200, body: { text } }
    } catch (err) {
      const msg = (err as Error).message
      const code = /tempo limite/.test(msg) ? 504 : 500
      result = { code, body: { error: msg } }
    } finally {
      await unlink(tmp).catch(() => {})
    }
    return reply.code(result.code).send(result.body)
  })
}
