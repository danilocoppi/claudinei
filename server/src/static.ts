import type { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'

/**
 * Serve o SPA buildado (web/dist) na raiz, com fallback SPA: qualquer rota que
 * não seja /api/* nem /ws/* devolve index.html (o roteamento é do React).
 */
export async function registerStatic(app: FastifyInstance, webDist: string): Promise<void> {
  await app.register(fastifyStatic, { root: webDist, wildcard: false })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
}
