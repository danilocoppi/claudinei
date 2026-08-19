import type { FastifyInstance, FastifyRequest } from 'fastify'
import { canAccessProject } from '../auth/guards.js'
import { availableApps, launchApp, LOCAL_APPS, type LocalApp, type LocalAppsDeps } from '../localApps.js'
import type { ProjectsService } from '../projects.js'

/**
 * A requisição veio da PRÓPRIA máquina do servidor? Abrir editor ou terminal roda
 * um programa no host: quem chega pela rede abriria a janela na máquina ERRADA —
 * a do servidor, não a dele. (Mesma checagem de /api/files/reveal.)
 */
function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.ip
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

export interface LocalAppsRouteDeps extends LocalAppsDeps {
  projects: ProjectsService
  /** Injetável para o teste não abrir janelas de verdade. */
  launch?: (app: LocalApp, dir: string) => void
}

export function registerLocalAppRoutes(app: FastifyInstance, deps: LocalAppsRouteDeps): void {
  /**
   * O que dá para abrir. Tudo `false` fora do localhost: quem decide o gate é o
   * SERVIDOR, não o hostname do navegador — acessar por um nome que resolve para
   * 127.0.0.1 enganaria o teste do lado do cliente.
   */
  app.get('/api/local-apps', async (req) =>
    isLocalRequest(req)
      ? availableApps(deps)
      : Object.fromEntries(LOCAL_APPS.map((a) => [a, false])))

  app.post('/api/projects/:id/open', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: 'somente da máquina do servidor' })

    const action = (req.body as { action?: unknown })?.action
    // A ação é uma CHAVE de uma lista fechada. Sem isto o parâmetro viraria
    // "execute o que eu mandar" na máquina de quem hospeda.
    if (typeof action !== 'string' || !LOCAL_APPS.includes(action as LocalApp)) {
      return reply.code(400).send({ error: `ação inválida (use ${LOCAL_APPS.join(', ')})` })
    }

    const id = Number((req.params as { id: string }).id)
    if (!canAccessProject(req.authUser, id)) return reply.code(403).send({ error: 'sem acesso a este terminal' })
    const project = deps.projects.get(id)
    if (!project) return reply.code(404).send({ error: `terminal ${id} não existe` })

    try {
      (deps.launch ?? ((a: LocalApp, dir: string) => launchApp(a, dir, deps)))(action as LocalApp, project.path)
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
    return { ok: true }
  })
}
