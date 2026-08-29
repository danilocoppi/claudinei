import type { FastifyInstance } from 'fastify'
import { requireProjectAccess } from '../auth/guards.js'
import { isLocalRequest } from '../auth/plugin.js'
import { desktopEnv, graphicalEnv, ORIG_LD } from '../localApps.js'
import type { ActionsStore } from '../actions.js'
import type { ProjectsService } from '../projects.js'
import type { TerminalManager } from '../terminal/manager.js'

export interface ActionsRouteDeps {
  actions: ActionsStore
  projects: ProjectsService
  terminalManager: Pick<TerminalManager, 'open' | 'refreshToken' | 'closeAndWait'>
  broadcast?: (msg: object) => void
  /** Injetáveis para o teste não depender da máquina. */
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/** A chave do PTY de uma ação. Uma por ação: rodar de novo o que já roda é REATAR. */
export const runKey = (actionId: number) => `act-${actionId}`

/**
 * Como os comandos viram uma linha de shell.
 *
 * `&&` e não `;`: numa ação de deploy, seguir depois de um comando que falhou é
 * publicar o que não compilou. O `&&` é o mesmo operador nos dois mundos — o
 * `cmd.exe` o suporta desde sempre, com o mesmo sentido de "só siga se deu certo".
 */
export const joinCommands = (commands: string[]) => commands.join(' && ')

/**
 * O shell que roda a ação.
 *
 * No Unix: INTERATIVO (`-i`), e isso não é detalhe. Os comandos do operador são
 * os que ele digita no terminal dele, e ali existem ALIASES. `awsVAEXA` — do
 * exemplo que originou esta tela — é `alias awsVAEXA='export AWS_PROFILE=getvaexa'`
 * no `.bashrc`, e o `.bashrc` só é lido por shell interativo. Medido: `bash -lc
 * 'awsVAEXA'` responde "command not found"; `bash -lic` funciona. E de LOGIN
 * (`-l`), para o PATH ser o mesmo que ele vê ao abrir um terminal.
 *
 * No Windows: a linha vai CRUA, e não como lista de argumentos. Com lista, o
 * node-pty aplica o quoting do compilador C e transforma as aspas internas em
 * `\"` — convenção que o `cmd.exe` não conhece, porque para ele `\` não escapa
 * nada. Uma ação com `git commit -m "mensagem"` chegaria com barras literais e a
 * mensagem partida ao meio. Passando a linha pronta e SEM aspas em volta, o cmd
 * lê tudo depois do `/c` como veio.
 *
 * Sem `/d` de propósito: é ele que desligaria o AutoRun, o mais próximo que o cmd
 * tem de um `.bashrc`. Vale lembrar que macro de `doskey` não existe aqui — ela
 * só vive num console interativo, e nunca num `cmd /c`; no Windows, o equivalente
 * ao alias é um `.bat`/`.cmd` no PATH.
 */
export function shellFor(commands: string[], platform: NodeJS.Platform): { file: string; args: string[] | string } {
  const linha = joinCommands(commands)
  if (platform === 'win32') return { file: 'cmd.exe', args: `/c ${linha}` }
  return { file: 'bash', args: ['-lic', linha] }
}

export function registerActionRoutes(app: FastifyInstance, deps: ActionsRouteDeps): void {
  const platform = deps.platform ?? process.platform

  /**
   * O ambiente do PTY.
   *
   * O node-pty parte do `process.env` do SERVIDOR e só sobrepõe o que a gente
   * passa — então o `LD_LIBRARY_PATH` com o libstdc++ portátil do Claudinei vai
   * junto, e um `npm run build` na ação morreria com o mesmo GLIBCXX que derrubou
   * o "Abrir terminal". Não dá para REMOVER uma chave por sobreposição; devolver
   * o valor original (vazio, quase sempre) tem o mesmo efeito no ligador.
   */
  const envDaAcao = (): Record<string, string> => {
    const base = deps.env ?? process.env
    // `LD_LIBRARY_PATH` é coisa do ligador do Unix: no Windows seria só uma
    // variável de enfeite no ambiente do build de outra pessoa.
    if (platform === 'win32') return {}
    return {
      LD_LIBRARY_PATH: (base[ORIG_LD] ?? desktopEnv(base).LD_LIBRARY_PATH ?? ''),
      ...graphicalEnv({ platform }),
    }
  }

  /** Ação + terminal existem, e quem pede tem acesso? Devolve os dois. */
  const resolver = (req: unknown, reply: unknown, actionId: number) => {
    const action = deps.actions.get(actionId)
    if (!action) return null
    const project = deps.projects.get(action.projectId)
    if (!project) return null
    return { action, project }
  }

  app.get('/api/projects/:id/actions', async (req, reply) => {
    const projectId = Number((req.params as { id: string }).id)
    if (!requireProjectAccess(req, reply, projectId)) return
    // `running` vem do PTY, não de uma tabela: o que está de pé é o processo, e
    // uma coluna no banco só teria como mentir depois de um restart.
    return deps.actions.list(projectId).map((a) => ({
      ...a, running: !!deps.terminalManager.refreshToken(runKey(a.id)),
    }))
  })

  app.post('/api/projects/:id/actions', async (req, reply) => {
    const projectId = Number((req.params as { id: string }).id)
    if (!requireProjectAccess(req, reply, projectId)) return
    if (!deps.projects.get(projectId)) return reply.code(404).send({ error: 'terminal não existe' })
    try {
      return reply.code(201).send(deps.actions.create(projectId, req.body as never))
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.patch('/api/actions/:actionId', async (req, reply) => {
    const alvo = resolver(req, reply, Number((req.params as { actionId: string }).actionId))
    if (!alvo) return reply.code(404).send({ error: 'ação não existe' })
    if (!requireProjectAccess(req, reply, alvo.project.id)) return
    try {
      return deps.actions.update(alvo.action.id, req.body as never)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/actions/:actionId', async (req, reply) => {
    const alvo = resolver(req, reply, Number((req.params as { actionId: string }).actionId))
    if (!alvo) return reply.code(404).send({ error: 'ação não existe' })
    if (!requireProjectAccess(req, reply, alvo.project.id)) return
    await deps.terminalManager.closeAndWait(runKey(alvo.action.id))
    deps.actions.remove(alvo.action.id)
    return reply.code(204).send()
  })

  /**
   * Roda a ação — ou REATA à que já está rodando.
   *
   * Reatar é o que faz a janelinha sobreviver a um F5: o PTY vive no servidor,
   * guarda o que já saiu, e um cliente novo recebe o buffer inteiro ao se ligar.
   * Sem isso, atualizar a página deixaria um deploy rodando às cegas — que foi
   * exatamente a preocupação levantada quando esta tela foi pedida.
   *
   * `attachOnly` é para quem está voltando de um F5: liga-se ao que existe, e
   * RECUSA se não houver nada. Sem ele, atualizar a página depois que o deploy
   * terminou publicaria de novo — o pior jeito possível de restaurar uma janela.
   * A decisão é do servidor, e não do cliente conferindo antes de pedir, porque
   * entre a conferência e o pedido o processo pode acabar.
   */
  app.post('/api/actions/:actionId/run', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: 'somente da máquina do servidor' })
    const alvo = resolver(req, reply, Number((req.params as { actionId: string }).actionId))
    if (!alvo) return reply.code(404).send({ error: 'ação não existe' })
    if (!requireProjectAccess(req, reply, alvo.project.id)) return

    const key = runKey(alvo.action.id)
    const wsUrl = `/ws/terminal/${key}`

    const vivo = deps.terminalManager.refreshToken(key)
    if (vivo) return reply.send({ token: vivo, wsUrl, reattached: true })
    if ((req.body as { attachOnly?: unknown })?.attachOnly) {
      return reply.code(409).send({ error: 'a ação não está mais rodando' })
    }

    const { file, args } = shellFor(alvo.action.commands, platform)
    const token = deps.terminalManager.open(key, {
      cwd: alvo.project.path,
      file,
      args,
      env: envDaAcao(),
      onExit: () => deps.broadcast?.({
        type: 'action_exit', actionId: alvo.action.id, projectId: alvo.project.id,
      }),
    })
    deps.broadcast?.({ type: 'action_start', actionId: alvo.action.id, projectId: alvo.project.id })
    return reply.send({ token, wsUrl, reattached: false })
  })

  /** Fechar a janelinha MATA o processo — fechar é parar, e é o que se espera. */
  app.delete('/api/actions/:actionId/run', async (req, reply) => {
    const alvo = resolver(req, reply, Number((req.params as { actionId: string }).actionId))
    if (!alvo) return reply.code(404).send({ error: 'ação não existe' })
    if (!requireProjectAccess(req, reply, alvo.project.id)) return
    await deps.terminalManager.closeAndWait(runKey(alvo.action.id))
    return reply.code(204).send()
  })
}
