import type { FastifyInstance } from 'fastify'
import type { IconService } from '../icons/service.js'

/** Quantos tokens um pedido de desenhos pode carregar. A sidebar inteira cabe. */
const MAX_TOKENS = 200

/**
 * O acervo de ícones. Duas rotas, e as duas devolvem a mesma coisa — desenho
 * pronto para pintar — porque a grade do seletor e a sidebar precisam do mesmo:
 * o miolo do SVG.
 */
export function registerIconRoutes(app: FastifyInstance, deps: { icons: IconService }): void {
  app.get('/api/icons/search', async (req) => {
    const q = (req.query as { q?: unknown })?.q
    if (typeof q !== 'string') return { icons: [] }
    return { icons: await deps.icons.search(q) }
  })

  /**
   * `?tokens=mdi:server,lucide:box` — o navegador pergunta pelos ícones que já
   * estão gravados nos terminais. O corte em MAX_TOKENS existe porque a lista vem
   * da URL: sem ele, um pedido gigante viraria um lote gigante contra a API deles.
   */
  app.get('/api/icons/bodies', async (req) => {
    const raw = (req.query as { tokens?: unknown })?.tokens
    if (typeof raw !== 'string' || raw.trim() === '') return { icons: [] }
    const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean).slice(0, MAX_TOKENS)
    return { icons: await deps.icons.bodies(tokens) }
  })
}
