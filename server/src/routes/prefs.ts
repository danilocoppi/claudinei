import type { FastifyInstance } from 'fastify'
import type { PrefsService } from '../prefs.js'
import { DEFAULT_APPEARANCE } from '../prefs.js'

/**
 * Preferências do usuário logado: aparência e atalhos. `authUser === undefined` é a
 * instalação sem auth e usa a linha 0; token de serviço não tem preferências (não
 * é um navegador).
 */
export function registerPrefsRoutes(app: FastifyInstance, deps: { prefs: PrefsService }): void {
  /** Id de armazenamento, ou null quando o pedido não vem de um usuário. */
  const idOf = (req: any): number | null => {
    const u = req.authUser
    if (!u) return 0
    return u.kind === 'user' ? u.id : null
  }

  const read = (id: number) => ({ appearance: deps.prefs.get(id), keybindings: deps.prefs.getKeybindings(id) })

  app.get('/api/prefs', async (req) => {
    const id = idOf(req)
    return id === null ? { appearance: DEFAULT_APPEARANCE, keybindings: {} } : read(id)
  })

  app.put('/api/prefs', async (req, reply) => {
    const id = idOf(req)
    if (id === null) return reply.code(403).send({ error: 'token de serviço não tem preferências' })
    const body = (req.body ?? {}) as { appearance?: unknown; keybindings?: unknown }
    // Campo ausente não muda. Atalhos presentes mas que não são objeto são recusados
    // por inteiro — e nada é gravado, nem a aparência — em vez de virar `{}` e
    // apagar os atalhos do usuário por causa de um cliente com defeito.
    const kb = body.keybindings
    if (kb !== undefined && (typeof kb !== 'object' || kb === null || Array.isArray(kb))) {
      return reply.code(400).send({ error: 'keybindings inválido' })
    }
    deps.prefs.update(id, { appearance: body.appearance, keybindings: kb })
    // Devolve o que ficou no banco, JÁ SANEADO: é isso que a UI aplica, então
    // cliente e servidor nunca discordam sobre o que ficou guardado.
    return read(id)
  })
}
