import type { FastifyInstance, FastifyRequest } from 'fastify'
import { canAccessProject } from '../auth/guards.js'
import { isTrustedLocal } from '../auth/plugin.js'
import { availableApps, availableTerminals, launchApp, LOCAL_APPS, TERMINALS, type LocalApp, type LocalAppsDeps } from '../localApps.js'
import type { ProjectsService } from '../projects.js'
import type { SettingsService } from '../settings.js'

/** Onde a escolha de terminal fica guardada. É da MÁQUINA, não de quem entrou. */
const TERMINAL_KEY = 'localApps.terminal'

/**
 * A requisição veio da PRÓPRIA máquina do servidor? Abrir editor ou terminal roda
 * um programa no host: quem chega pela rede abriria a janela na máquina ERRADA —
 * a do servidor, não a dele. (Mesma checagem de /api/files/reveal.)
 */

export interface LocalAppsRouteDeps extends LocalAppsDeps {
  projects: ProjectsService
  settings: SettingsService
  /** Injetável para o teste não abrir janelas de verdade. */
  launch?: (app: LocalApp, dir: string) => void | Promise<void>
}

export function registerLocalAppRoutes(app: FastifyInstance, deps: LocalAppsRouteDeps): void {
  /**
   * O que dá para abrir. Tudo `false` fora do localhost: quem decide o gate é o
   * SERVIDOR, não o hostname do navegador — acessar por um nome que resolve para
   * 127.0.0.1 enganaria o teste do lado do cliente.
   */
  app.get('/api/local-apps', async (req) => {
    const local = isTrustedLocal(req)
    // `local` à parte dos apps: "nenhum app disponível" e "não é esta máquina" são
    // coisas diferentes, e quem desenha a tela precisa distinguir — os itens de
    // "abrir em…" somem pelo segundo motivo, não pelo primeiro (as Ações não
    // dependem disto: rodam no servidor por definição e aparecem também remoto).
    return local
      ? { ...availableApps(deps), local }
      : { ...Object.fromEntries(LOCAL_APPS.map((a) => [a, false])), local }
  })

  /**
   * Os terminais instalados e o escolhido.
   *
   * A escolha existe porque adivinhar falhou de um jeito silencioso: o
   * `x-terminal-emulator` é a alternativa apontada pelo sistema — a escolha certa
   * em tese — mas numa máquina real ela resolvia para um terminal que o dono não
   * usava, e o botão parecia não fazer nada.
   */
  app.get('/api/local-apps/terminals', async (req) => {
    if (!isTrustedLocal(req)) return { options: [], chosen: null }
    return {
      options: availableTerminals(deps),
      // Vazio é "sem escolha": apagar é gravar vazio, e ler vazio tem de doer nada.
      chosen: deps.settings.get(TERMINAL_KEY) || null,
    }
  })

  app.put('/api/local-apps/terminals', async (req, reply) => {
    if (!isTrustedLocal(req)) return reply.code(403).send({ error: 'somente da máquina do servidor' })
    const terminal = (req.body as { terminal?: unknown })?.terminal

    // Voltar ao padrão do sistema é apagar a escolha, não gravar vazio.
    if (terminal === null || terminal === '') {
      deps.settings.set(TERMINAL_KEY, '')
      return { chosen: null }
    }
    // O valor gravado vira o COMANDO que esta máquina executa: é chave de lista
    // fechada, como a ação. E precisa estar instalado, senão o botão nasce morto.
    if (typeof terminal !== 'string' || !TERMINALS.some((t) => t.id === terminal)) {
      return reply.code(400).send({ error: 'terminal desconhecido' })
    }
    if (!availableTerminals(deps).some((t) => t.id === terminal)) {
      return reply.code(400).send({ error: `"${terminal}" não está instalado nesta máquina` })
    }
    deps.settings.set(TERMINAL_KEY, terminal)
    return { chosen: terminal }
  })

  app.post('/api/projects/:id/open', async (req, reply) => {
    if (!isTrustedLocal(req)) return reply.code(403).send({ error: 'somente da máquina do servidor' })

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
      // Aguarda: quem clicou merece saber que o app não subiu, e por quê. Silêncio
      // era o defeito relatado — o botão não fazia nada e não havia o que ler.
      const terminal = deps.settings.get(TERMINAL_KEY) || null
      await (deps.launch ?? ((a: LocalApp, dir: string) => launchApp(a, dir, { ...deps, terminal })))(
        action as LocalApp, project.path)
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
    return { ok: true }
  })
}
