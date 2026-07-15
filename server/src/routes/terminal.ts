import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { TerminalManager } from '../terminal/manager.js'
import { requireProjectAccess } from '../auth/guards.js'

export interface TerminalRouteDeps {
  manager: Pick<SessionManager, 'openInTerminal' | 'get'>
  terminalManager: Pick<TerminalManager, 'close' | 'closeAndWait' | 'attach' | 'detach' | 'write' | 'resize' | 'refreshToken'>
}

/**
 * Origin permitido no WS do terminal: loopback (dev/vite) ou o MESMO host:porta
 * da requisição (acesso via LAN autenticado). Bloqueia sites de terceiros
 * tentando cross-site WebSocket hijacking.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  try {
    const u = new URL(origin)
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) return true
    return host !== undefined && u.host === host
  } catch {
    return false
  }
}

export function registerTerminalRoutes(app: FastifyInstance, deps: TerminalRouteDeps): void {
  app.post('/api/sessions/:localId/terminal', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    const info = deps.manager.get(localId)
    if (!info) return reply.code(404).send({ error: 'sessão não existe' })
    if (!requireProjectAccess(req, reply, info.projectId)) return
    // Reconexão idempotente: se já existe um PTY vivo para esta sessão, apenas
    // emite um token novo — não reinicia o processo nem re-transiciona o estado.
    const existing = deps.terminalManager.refreshToken(localId)
    if (existing) return reply.send({ token: existing, wsUrl: `/ws/terminal/${localId}` })
    try {
      const info = await deps.manager.openInTerminal(localId)
      return reply.send({ token: info.token, wsUrl: `/ws/terminal/${localId}` })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/sessions/:localId/terminal', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    const info = deps.manager.get(localId)
    if (!info) return reply.code(404).send({ error: 'sessão não existe' })
    if (!requireProjectAccess(req, reply, info.projectId)) return
    // espera o exit REAL do PTY (status persistido) — um revive logo em seguida
    // não pode esbarrar na sessão ainda marcada como in_terminal
    await deps.terminalManager.closeAndWait(localId)
    return reply.code(204).send()
  })

  app.get('/ws/terminal/:localId', { websocket: true }, (socket, req) => {
    const { localId } = req.params as { localId: string }
    const token = (req.query as { token?: string }).token ?? ''
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) { socket.close(1008, 'origin'); return }
    if (!deps.terminalManager.attach(localId, socket as unknown as { send(d: string): void; readyState: number }, token)) {
      socket.close(1008, 'token')
      return
    }
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        deps.terminalManager.write(localId, data.toString('utf8'))
      } else {
        try {
          const m = JSON.parse(data.toString('utf8'))
          if (m?.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
            deps.terminalManager.resize(localId, m.cols, m.rows)
          }
        } catch { /* frame de controle inválido: ignora */ }
      }
    })
    socket.on('close', () => deps.terminalManager.detach(localId, socket as unknown as { send(d: string): void; readyState: number }))
  })
}
