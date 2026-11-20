import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { unlinkSync } from 'node:fs'
import { saveUpload, rotateUploads, missingUploads } from '../uploads.js'

const MAX_FILE_BYTES = 100 * 1024 * 1024 // 100 MB (decisão do spec)
const MAX_CHECK_PATHS = 200 // um envio não carrega mais anexos que isso

export async function registerUploadRoutes(
  app: FastifyInstance,
  deps: { uploadsDir: string; maxFileBytes?: number },
): Promise<void> {
  await app.register(multipart, { limits: { fileSize: deps.maxFileBytes ?? MAX_FILE_BYTES, files: 1 } })

  app.post('/api/uploads', async (req, reply) => {
    const part = await req.file()
    if (!part) return reply.code(400).send({ error: 'nenhum arquivo no form (campo "file")' })
    const saved = await saveUpload(deps.uploadsDir, part.filename ?? 'arquivo', part.file)
    // O multipart trunca silenciosamente no limite — arquivo pela metade é
    // inútil para o claude: apaga e avisa.
    if (part.file.truncated) {
      try { unlinkSync(saved.path) } catch { /* já foi */ }
      return reply.code(413).send({ error: 'arquivo grande demais (máx. 100 MB)' })
    }
    rotateUploads(deps.uploadsDir)
    return reply.code(201).send(saved)
  })

  // Antes de reenviar um rascunho guardado, a web confere se os anexos dele
  // ainda existem (a rotação pode ter apagado). Responde só os ausentes.
  app.post('/api/uploads/check', async (req, reply) => {
    const paths = (req.body as { paths?: unknown } | null)?.paths
    if (!Array.isArray(paths) || paths.length > MAX_CHECK_PATHS || !paths.every((p) => typeof p === 'string')) {
      return reply.code(400).send({ error: `paths deve ser uma lista de até ${MAX_CHECK_PATHS} caminhos (texto)` })
    }
    return { missing: missingUploads(deps.uploadsDir, paths) }
  })
}
