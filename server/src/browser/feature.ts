// O navegador embutido montado na app: as rotas do hermes (`browser_*`), as do
// operador e o WebSocket da tela. Aqui mora o anúncio das abas: o
// broadcast `browser_tab` sai quando uma aba nasce (por quem pediu) e quando
// fecha. Ele leva `projectId` no topo, e o `canSee` do hub filtra por ele: só
// quem tem acesso ao projeto recebe.
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import type { BrowserHost, TerminalTab } from './host.js'
import { keyOf, type TabCloseReason, type TerminalKey } from './types.js'
import { registerBrowserHermesRoutes, type TabActor } from './hermes-routes.js'
import { registerBrowserOperatorRoutes } from './operator-routes.js'
import { registerBrowserSocket } from './socket.js'
import { viewersFor } from './viewers.js'

export interface BrowserFeature {
  /** Rotas do hermes, do operador e o WebSocket da tela. */
  register(app: FastifyInstance): void
  /** Revogação de um usuário: fecha os sockets da tela dele com 1008. */
  closeUser(userId: number): void
  /** Revogação geral: fecha todos os sockets da tela com 1008. */
  closeAll(): void
}

/** Quem fechou: o agente (`browser_close`), o operador, ou o sistema (ociosidade, queda, despejo, encerramento). */
function closedBy(reason: TabCloseReason): TabActor {
  if (reason === 'closed_by_agent') return 'agent'
  if (reason === 'closed_by_user') return 'operator'
  return 'system'
}

export function createBrowserFeature(d: { host: BrowserHost; db: Db; uploadsDir: string; broadcast: (m: object) => void }): BrowserFeature {
  const projects = createProjectsService(d.db)
  /** As abas já anunciadas e ainda abertas (a lista do operador sai daqui). */
  const open = new Map<string, { key: TerminalKey; tab: TerminalTab }>()
  /** Os sockets da tela (antes do `register`, a revogação não tem o que fechar). */
  let sockets: ReturnType<typeof registerBrowserSocket> | undefined

  async function openTab(key: TerminalKey, by: Exclude<TabActor, 'system'>): Promise<TerminalTab> {
    const tab = await d.host.tab(key)
    const k = keyOf(key)
    // Aberta de novo (reaproveitada) ou já anunciada por outro pedido simultâneo: nada a dizer.
    if (open.get(k)?.tab === tab) return tab
    const announce = (isOpen: boolean, who: TabActor) =>
      d.broadcast({ type: 'browser_tab', projectId: key.projectId, engine: key.engine, open: isOpen, by: who })
    open.set(k, { key: { projectId: key.projectId, engine: key.engine }, tab })
    announce(true, by)
    // Com a aba já fechada, o `onClosed` chama na hora: o fechamento sai logo depois da abertura.
    tab.onClosed((reason) => {
      if (open.get(k)?.tab === tab) open.delete(k)
      announce(false, closedBy(reason))
    })
    return tab
  }

  return {
    register(app) {
      registerBrowserHermesRoutes(app, { host: d.host, projects, uploadsDir: d.uploadsDir, openTab })
      registerBrowserOperatorRoutes(app, {
        host: d.host, projects, openTab,
        listTabs: () => [...open.values()].map((o) => o.key),
      })
      sockets = registerBrowserSocket(app, { host: d.host, db: d.db, viewersFor })
    },
    closeUser(userId) { sockets?.closeUser(userId) },
    closeAll() { sockets?.closeAll() },
  }
}
