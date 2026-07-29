import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { SessionManager } from '../claude/manager.js'
import type { AuthUser } from '../auth/plugin.js'
import { canAccessProject } from '../auth/guards.js'
import { isAllowedOrigin } from './terminal.js'

interface Client {
  ws: WebSocket
  /** undefined = auth desativada (pré-setup): vê tudo, como sempre foi. */
  user?: AuthUser
}

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

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
        if (c.ws.readyState !== c.ws.OPEN || !canSee(c.user, msg)) continue
        // Backpressure: cliente que parou de ler (laptop suspenso, aba
        // congelada) acumula buffer no servidor durante streaming intenso —
        // acima do teto, derruba a conexão; ele reconecta e ressincroniza
        // pelo snapshot em vez de segurar memória indefinidamente.
        if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) { c.ws.close(1013, 'backpressure'); continue }
        c.ws.send(data)
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
        // Bloqueia cross-site WebSocket hijacking: no pré-setup (0 usuários) o
        // hook libera loopback sem credencial, então sem essa checagem qualquer
        // site visitado pelo usuário abriria um WS para 127.0.0.1 e controlaria
        // as sessões (que rodam com --dangerously-skip-permissions).
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) { socket.close(1008, 'origin'); return }
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
          try {
            const u = client.user
            if (u && u.kind === 'user' && !u.isAdmin) {
              // Dentro do try: um localId não-escalar (bool/objeto) faz o
              // better-sqlite3 lançar no bind — fora do try isso derrubava o processo.
              const info = deps.manager.get(msg.localId)
              if (!info || !u.projectIds.includes(info.projectId)) {
                socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: 'forbidden' }))
                return
              }
            }
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
