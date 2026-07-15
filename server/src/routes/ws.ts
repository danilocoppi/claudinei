import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { SessionManager } from '../claude/manager.js'
import type { AuthUser } from '../auth/plugin.js'
import { canAccessProject } from '../auth/guards.js'

interface Client {
  ws: WebSocket
  /** undefined = auth desativada (pré-setup): vê tudo, como sempre foi. */
  user?: AuthUser
}

export function createWsHub() {
  const clients = new Set<Client>()
  // O manager chega no register(); broadcast antes disso (não ocorre em produção)
  // cai no comportamento sem filtro por localId.
  let mgr: SessionManager | undefined

  const canSee = (user: AuthUser | undefined, msg: any): boolean => {
    if (!user || user.kind === 'service' || user.isAdmin) return true
    const projectId: number | undefined =
      typeof msg.projectId === 'number'
        ? msg.projectId
        : typeof msg.localId === 'string'
          ? mgr?.get(msg.localId)?.projectId
          : undefined
    // Sem projeto resolvível (ex.: evento global) → admin-only.
    return projectId !== undefined && canAccessProject(user, projectId)
  }

  return {
    broadcast(msg: object): void {
      const data = JSON.stringify(msg)
      for (const c of clients) {
        if (c.ws.readyState === c.ws.OPEN && canSee(c.user, msg)) c.ws.send(data)
      }
    },

    closeAll(): void {
      for (const c of clients) c.ws.close(1008, 'revoked')
    },

    closeUser(userId: number): void {
      for (const c of clients) {
        if (c.user?.kind === 'user' && c.user.id === userId) c.ws.close(1008, 'revoked')
      }
    },

    register(app: FastifyInstance, deps: { manager: SessionManager }): void {
      mgr = deps.manager
      app.get('/ws', { websocket: true }, (socket, req) => {
        // A autenticação aconteceu no hook onRequest (401 aborta o upgrade);
        // aqui só capturamos QUEM conectou para filtrar broadcasts.
        const client: Client = { ws: socket, user: req.authUser }
        clients.add(client)
        const sessions = deps.manager.list().filter((s) =>
          !client.user || client.user.kind !== 'user' || canAccessProject(client.user, s.projectId))
        socket.send(JSON.stringify({ type: 'sessions_snapshot', sessions }))
        socket.on('close', () => clients.delete(client))
        socket.on('message', (data) => {
          let msg: any
          try { msg = JSON.parse(data.toString()) } catch { return }
          const u = client.user
          if (u && u.kind === 'user' && !u.isAdmin) {
            const info = deps.manager.get(msg.localId)
            if (!info || !u.projectIds.includes(info.projectId)) {
              socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: 'forbidden' }))
              return
            }
          }
          try {
            if (msg.type === 'send_message') deps.manager.send(msg.localId, msg.text)
            else if (msg.type === 'mark_read') deps.manager.markRead(msg.localId)
            else if (msg.type === 'interrupt') void deps.manager.interrupt(msg.localId).catch((err) => socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: (err as Error).message })))
          } catch (err) {
            socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: (err as Error).message }))
          }
        })
      })
    },
  }
}

export type WsHub = ReturnType<typeof createWsHub>
