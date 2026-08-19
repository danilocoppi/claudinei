import type { FastifyInstance } from 'fastify'
import type { PrefsService } from '../prefs.js'
import { DEFAULT_APPEARANCE } from '../prefs.js'

/**
 * Aparência do usuário logado. `authUser === undefined` é a instalação sem auth e
 * usa a linha 0; token de serviço não tem aparência (não é um navegador).
 */
export function registerPrefsRoutes(app: FastifyInstance, deps: { prefs: PrefsService }): void {
  /** Id de armazenamento, ou null quando o pedido não vem de um usuário. */
  const idOf = (req: any): number | null => {
    const u = req.authUser
    if (!u) return 0
    return u.kind === 'user' ? u.id : null
  }

  app.get('/api/prefs', async (req) => {
    const id = idOf(req)
    return { appearance: id === null ? DEFAULT_APPEARANCE : deps.prefs.get(id) }
  })

  app.put('/api/prefs', async (req, reply) => {
    const id = idOf(req)
    if (id === null) return reply.code(403).send({ error: 'token de serviço não tem aparência' })
    // Devolve o objeto JÁ SANEADO: é ele que a UI aplica, então cliente e servidor
    // nunca discordam sobre o que ficou guardado.
    return { appearance: deps.prefs.set(id, (req.body as { appearance?: unknown })?.appearance) }
  })
}
