import type { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'

/**
 * Serve o SPA buildado (web/dist) na raiz, com fallback SPA: qualquer rota que
 * não seja /api/* nem /ws/* devolve index.html (o roteamento é do React).
 */
export async function registerStatic(app: FastifyInstance, webDist: string): Promise<void> {
  // wildcard NÃO: com `wildcard: false` o @fastify/static faz um glob do dist NO
  // REGISTER e cria uma rota por arquivo — a lista congela no boot. Um rebuild do
  // web (assets com hash novo) passa a cair no fallback abaixo, o browser recebe
  // HTML no lugar do JS e a tela fica branca até reiniciar. Com o curinga, cada
  // request resolve no disco.
  await app.register(fastifyStatic, { root: webDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
      return reply.code(404).send({ error: 'not found' })
    }
    return reply.sendFile('index.html')
  })
}
