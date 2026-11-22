// As rotas dos servidores locais de cada terminal, ambas com
// `requireProjectAccess`:
// - `GET /api/projects/:id/terminals/:engine/servers` → `{ servers: LocalServer[] }`;
// - `POST /api/projects/:id/terminals/:engine/servers/:pid/stop`, corpo
//   `{ startTime }` → `{ ok: true, target: 'group' | 'pid' }`. Processo que já
//   não é o mesmo: 409 `not_same_process`; sem marcador: 403 `no_marker`; do
//   próprio Claudinei: 403 `protected_process`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db.js'
import { createProjectsService, type Project } from '../projects.js'
import { requireProjectAccess } from '../auth/guards.js'
import { hasEngine, listEngines } from '../engine/index.js'
import { errorBody, fail } from '../user-error.js'
import { terminalMarker } from './marker.js'
import { createServerScanner } from './scan.js'
import { NoMarkerError, NotSameProcessError, ProtectedProcessError, stopServer } from './stop.js'

export interface LocalServerRouteDeps {
  db: Db
  /** A porta do próprio serviço, que nunca entra na lista. */
  servicePort: number
  /** Só os testes: o /proc falso, o PID que faz as vezes do Claudinei e o `kill` dublê. */
  procRoot?: string
  selfPid?: number
  kill?: (pid: number, sig: NodeJS.Signals) => void
}

export function registerLocalServerRoutes(app: FastifyInstance, d: LocalServerRouteDeps): void {
  const projects = createProjectsService(d.db)
  const scanner = createServerScanner({ procRoot: d.procRoot, selfPid: d.selfPid, servicePort: d.servicePort })

  /** Projeto existe (404), acesso (403) e motor do Claudinei (400). */
  const terminalOf = (req: FastifyRequest, reply: FastifyReply): { project: Project; engine: string } | undefined => {
    const p = req.params as { id: string; engine: string }
    const project = projects.get(Number(p.id))
    if (!project) { reply.code(404).send(fail('no_project', 'o projeto não existe')); return undefined }
    if (!requireProjectAccess(req, reply, project.id)) return undefined
    if (!hasEngine(p.engine)) {
      const known = listEngines().map((e) => e.id).join(', ')
      reply.code(400).send(fail('bad_args', `motor desconhecido '${p.engine}'; use um de ${known}`))
      return undefined
    }
    return { project, engine: p.engine }
  }

  app.get('/api/projects/:id/terminals/:engine/servers', async (req, reply) => {
    const t = terminalOf(req, reply)
    if (!t) return reply
    return { servers: scanner.forTerminal(t.project.id, t.engine, t.project.path) }
  })

  app.post('/api/projects/:id/terminals/:engine/servers/:pid/stop', async (req, reply) => {
    const t = terminalOf(req, reply)
    if (!t) return reply
    const pid = Number((req.params as { pid: string }).pid)
    const startTime = (req.body as { startTime?: unknown } | undefined)?.startTime
    // PID 1 e abaixo nunca: `kill(0)` e `kill(-1)` atingem grupos inteiros.
    if (!Number.isSafeInteger(pid) || pid <= 1 || typeof startTime !== 'string' || !/^\d+$/.test(startTime)) {
      return reply.code(400).send(fail('bad_args', 'pid inteiro maior que 1 e startTime em dígitos'))
    }
    try {
      const { target } = await stopServer({
        procRoot: d.procRoot, selfPid: d.selfPid, kill: d.kill,
        pid, startTime, marker: terminalMarker(t.project.id, t.engine),
      })
      return { ok: true, target }
    } catch (err) {
      if (err instanceof NotSameProcessError) return reply.code(409).send(fail('not_same_process', 'o processo já não é o mesmo'))
      if (err instanceof NoMarkerError) return reply.code(403).send(fail('no_marker', err.message))
      if (err instanceof ProtectedProcessError) return reply.code(403).send(fail('protected_process', err.message))
      return reply.code(500).send(errorBody(err))
    } finally {
      // A próxima lista relê o /proc: o servidor parado não volta da varredura guardada.
      scanner.invalidate()
    }
  })
}
