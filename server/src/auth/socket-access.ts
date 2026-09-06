import type { FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'

/** Disconnect clients without terminating the shared engine or shell process.
 * Input AND output must use this guard: a socket opened during allowed hours
 * is not a permanent capability. The timer also closes silent connections.
 */
export function watchSocketAccess(socket: WebSocket, req: FastifyRequest) {
  const allowed = () => {
    if (!req.accessAllowed || req.accessAllowed()) return true
    if (socket.readyState === socket.OPEN) socket.close(1008, 'access_hours')
    return false
  }
  const timer = req.accessAllowed ? setInterval(allowed, 1000) : undefined
  timer?.unref()
  socket.once('close', () => clearInterval(timer))
  return {
    allowed,
    get readyState() { return socket.readyState },
    send(data: string) { if (allowed() && socket.readyState === socket.OPEN) socket.send(data) },
  }
}
