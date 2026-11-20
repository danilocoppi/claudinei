import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import type { SessionManager } from '../claude/manager.js'
import { createProjectsService } from '../projects.js'
import { createTasksService, type Task } from '../tasks.js'
import { canAccessProject, requireProjectAccess } from '../auth/guards.js'
import { hasEngine } from '../engine/index.js'
import { RESTART_FAIL_TEXT } from '../restart/terminal-state.js'

/** O que o orchestrator expõe ao resto do servidor (manager e subida). */
export interface OrchestratorHooks {
  /**
   * Entrega a próxima tarefa da fila do projeto, se ele estiver livre. Devolve
   * se entregou. `localId`: só naquela sessão (o árbitro do próximo envio
   * oferece a sessão que ficou livre, lugar 5).
   */
  drain(projectId: number, localId?: string): boolean
  /**
   * Religa uma tarefa `in_progress` ao turno da sessão (reinício: o turno
   * interrompido foi retomado). Fecha como o dispatch fecharia. `false` se a
   * tarefa não está em andamento ou a sessão não está viva.
   */
  reattach(taskId: number, localId: string): boolean
  /** Fecha como falha a tarefa cujo turno o reinício matou e não vai ser retomado. */
  failInterrupted(taskId: number): void
}

export function registerOrchestratorRoutes(
  app: FastifyInstance,
  deps: {
    db: Db; manager: SessionManager; broadcast?: (msg: object) => void
    /**
     * O terminal (projeto + motor) pode receber uma tarefa agora? Falso com
     * aviso aberto esperando o operador: a tarefa espera, como a fila do
     * operador. Ausente = todos podem.
     */
    canTake?: (projectId: number, engine: string) => boolean
    /**
     * A tarefa terminou (concluída ou falha) e o resultado já está gravado: o
     * aviso ao terminal que a encaminhou. Uma falha dele não pode desfazer o fim.
     */
    onTaskEnded?: (taskId: number) => void
  },
): OrchestratorHooks {
  const projects = createProjectsService(deps.db)
  const tasks = createTasksService(deps.db)

  const broadcastTask = (id: number): void => {
    const task = tasks.get(id)
    if (task) deps.broadcast?.({ type: 'task_update', task })
  }

  const taskEnded = (id: number): void => {
    try { deps.onTaskEnded?.(id) } catch (err) { console.error('[orchestrator] aviso de fim de tarefa falhou', err) }
  }

  // Fim do turno que executa a tarefa: grava o resultado e avisa. Mesmo fecho
  // para a entrega (drain) e para a tarefa religada depois de um reinício.
  const onTaskEnd = (task: Task) => (status: 'completed' | 'failed', result: string): void => {
    tasks.setResult(task.id, status, result)
    broadcastTask(task.id)
    taskEnded(task.id)
    // Falha (timeout/dead/stopped/busy) não passa por onSessionAvailable —
    // sem este drain a próxima queued do projeto ficaria parada até o
    // próximo POST /dispatch. setImmediate quebra a reentrância do caminho
    // em que o onComplete é chamado sincronamente pelo dispatchTask.
    if (status === 'failed') setImmediate(() => drain(task.toProjectId))
  }

  // Entrega a queued mais antiga do projeto alvo, se ele estiver livre agora.
  // Único caminho de entrega: o dispatch HTTP sempre cria a tarefa como
  // 'queued' e chama drain em seguida — a "entrega imediata" é só o caso em
  // que o alvo já está livre nesse instante. O encadeamento da fila (tarefa
  // termina → próxima é entregue) vem do hook onSessionAvailable do manager
  // chamando drain de novo quando o alvo volta a ficar livre.
  //
  // Terminal com aviso aberto (`canTake` falso) não recebe: a tarefa espera o
  // aviso sair, e o árbitro cutuca quando ele sai. A escolha vai inteira ao
  // manager, antes de marcar a tarefa: sem sessão que sirva, ela segue queued.
  const drain = (projectId: number, localId?: string): boolean => {
    const target = {
      localId,
      accept: deps.canTake ? (engine: string) => deps.canTake!(projectId, engine) : undefined,
    }
    if (!deps.manager.hasFreeSession(projectId, target)) return false
    const next = tasks.nextQueued(projectId)
    if (!next) return false
    tasks.markInProgress(next.id)
    const delivered = deps.manager.dispatchTask(next.toProjectId, next.fromProjectName ?? 'unknown', next.description, onTaskEnd(next), undefined, target)
    // A engine que executa só é conhecida na entrega (o dispatch pega a 1ª sessão
    // livre do projeto — pode ser o Claude, o Codex ou o OpenCode dele).
    if (delivered) tasks.setToEngine(next.id, delivered)
    broadcastTask(next.id)
    return !!delivered
  }

  app.get('/api/orchestrator/tasks', async (req) => {
    const { limit } = req.query as { limit?: string }
    const parsed = limit ? Number(limit) : undefined
    return tasks.list(parsed && parsed > 0 ? parsed : undefined)
      .filter((t) => canAccessProject(req.authUser, t.toProjectId))
  })

  app.post('/api/orchestrator/dispatch', async (req, reply) => {
    const body = req.body as { fromProjectId?: number; toProjectName?: string; description?: string; fromEngine?: string }
    if (!body?.toProjectName || !body?.description) {
      return reply.code(400).send({ error: 'toProjectName and description are required' })
    }
    // Mesmo teto do mural/ask: a descrição vai ao SQLite e ao broadcast WS.
    if (body.description.length > 50_000) {
      return reply.code(400).send({ error: 'description must be at most 50000 chars' })
    }
    const target = projects.list().find((p) => p.name.toLowerCase() === body.toProjectName!.toLowerCase())
    if (!target) return reply.code(404).send({ error: `project "${body.toProjectName}" does not exist` })
    if (!requireProjectAccess(req, reply, target.id)) return

    const fromProject = body.fromProjectId ? projects.get(Number(body.fromProjectId)) : undefined

    // Sempre nasce queued; drain entrega na hora se o alvo já estiver livre
    // (cobrindo também a janela entre o check de disponibilidade e o insert).
    // fromEngine é auto-declarado pelo MCP (env da sessão); valida contra o registry.
    const fromEngine = typeof body.fromEngine === 'string' && hasEngine(body.fromEngine) ? body.fromEngine : null
    const { id } = tasks.create(fromProject?.id ?? null, target.id, body.description, 'queued', fromEngine)
    broadcastTask(id)
    drain(target.id)

    return { id }
  })

  const reattach = (taskId: number, localId: string): boolean => {
    const task = tasks.get(taskId)
    if (task?.status !== 'in_progress') return false
    return deps.manager.watchTurn(localId, onTaskEnd(task))
  }

  const failInterrupted = (taskId: number): void => {
    // Só a que segue em andamento: uma que já fechou guarda o próprio resultado.
    if (tasks.get(taskId)?.status !== 'in_progress') return
    tasks.setResult(taskId, 'failed', RESTART_FAIL_TEXT)
    broadcastTask(taskId)
    taskEnded(taskId)
  }

  return { drain, reattach, failInterrupted }
}
