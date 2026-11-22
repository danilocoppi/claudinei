// As rotas do operador sobre a aba do terminal: listar as abas abertas (só dos
// projetos a que ele tem acesso), abrir ou reaproveitar e fechar. Todas com
// `requireProjectAccess`; a tela e o bastão vão pelo WebSocket (Task 10).
import type { FastifyInstance } from 'fastify'
import type { ProjectsService } from '../projects.js'
import { canAccessProject } from '../auth/guards.js'
import type { BrowserHost } from './host.js'
import type { TerminalKey } from './types.js'
import { sendBrowserError, terminalOf, type BrowserRouteDeps } from './hermes-routes.js'

export interface BrowserOperatorRouteDeps {
  host: BrowserHost
  projects: ProjectsService
  openTab: BrowserRouteDeps['openTab']
  /** As abas abertas agora. */
  listTabs(): TerminalKey[]
}

export function registerBrowserOperatorRoutes(app: FastifyInstance, d: BrowserOperatorRouteDeps): void {
  app.get('/api/browser/tabs', async (req) => ({
    tabs: d.listTabs()
      .filter((k) => canAccessProject(req.authUser, k.projectId))
      .map((k) => ({ projectId: k.projectId, engine: k.engine })),
  }))

  app.post('/api/projects/:id/terminals/:engine/browser', async (req, reply) => {
    const p = req.params as { id: string; engine: string }
    const key = terminalOf(req, reply, d.projects, p.id, p.engine)
    if (!key) return reply
    try {
      await d.openTab(key, 'operator')
      return { ok: true }
    } catch (err) {
      // Sem Chromium: 503 com o comando de instalação (a coluna mostra o texto).
      return sendBrowserError(reply, err, 'abrir a aba')
    }
  })

  app.delete('/api/projects/:id/terminals/:engine/browser', async (req, reply) => {
    const p = req.params as { id: string; engine: string }
    const key = terminalOf(req, reply, d.projects, p.id, p.engine)
    if (!key) return reply
    try {
      // Sem motivo: é o operador (`closed_by_user`). Sem aba, no-op.
      await d.host.closeTab(key)
      return reply.code(204).send()
    } catch (err) {
      return sendBrowserError(reply, err, 'fechar a aba')
    }
  })
}
