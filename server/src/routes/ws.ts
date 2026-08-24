import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { SessionManager } from '../claude/manager.js'
import type { AuthUser } from '../auth/plugin.js'
import { canAccessProject } from '../auth/guards.js'
import { isLocalRequest } from '../auth/plugin.js'
import { isAllowedOrigin } from './terminal.js'
import { runShell } from '../shell.js'
import { createProjectsService, type ProjectsService } from '../projects.js'
import type { Db } from '../db.js'

interface Client {
  ws: WebSocket
  /** undefined = auth desativada (pré-setup): vê tudo, como sempre foi. */
  user?: AuthUser
  /** Conectou da máquina do servidor? É o que libera o `!comando` (ver abaixo). */
  local: boolean
}

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export function createWsHub() {
  const clients = new Set<Client>()
  // O manager chega no register(); broadcast antes disso (não ocorre em produção)
  // cai no comportamento sem filtro por localId.
  let mgr: SessionManager | undefined
  /** Só o `!comando` precisa: é dele que sai a PASTA em que o comando roda. */
  let projectsSvc: ProjectsService | undefined

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

  /** Executa e devolve o resultado APENAS para o socket que pediu. */
  async function runShellFor(client: Client, localId: unknown, command: unknown): Promise<void> {
    if (typeof localId !== 'string' || typeof command !== 'string') return
    const responde = (output: string, isError: boolean) =>
      client.ws.send(JSON.stringify({ type: 'shell_result', localId, command, output, isError }))

    if (!client.local) return responde('o comando só roda da máquina do servidor', true)
    const info = mgr?.get(localId)
    if (!info) return responde(`sessão ${localId} não existe`, true)
    if (client.user && client.user.kind === 'user' && !canAccessProject(client.user, info.projectId)) {
      return responde('sem acesso a este terminal', true)
    }
    const projeto = projectsSvc?.get(info.projectId)
    if (!projeto) return responde('terminal sem pasta', true)

    const r = await runShell(command, projeto.path)
    responde(r.output, r.isError)
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

    register(app: FastifyInstance, deps: { manager: SessionManager; db?: Db }): void {
      mgr = deps.manager
      if (deps.db) projectsSvc = createProjectsService(deps.db)
      app.get('/ws', { websocket: true }, (socket, req) => {
        // Bloqueia cross-site WebSocket hijacking: no pré-setup (0 usuários) o
        // hook libera loopback sem credencial, então sem essa checagem qualquer
        // site visitado pelo usuário abriria um WS para 127.0.0.1 e controlaria
        // as sessões (que rodam com --dangerously-skip-permissions).
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) { socket.close(1008, 'origin'); return }
        // A autenticação aconteceu no hook onRequest (401 aborta o upgrade);
        // aqui só capturamos QUEM conectou para filtrar broadcasts.
        const client: Client = { ws: socket, user: req.authUser, local: isLocalRequest(req) }
        clients.add(client)
        const sessions = deps.manager.list().filter((s) =>
          !client.user || client.user.kind !== 'user' || canAccessProject(client.user, s.projectId))
        socket.send(JSON.stringify({ type: 'sessions_snapshot', sessions }))
        socket.on('close', () => clients.delete(client))
        socket.on('message', (data) => {
          let msg: any
          try { msg = JSON.parse(data.toString()) } catch { return }
          // `null`, número e string são JSON VÁLIDO: sem esta guarda o handler
          // desreferencia msg.type/msg.localId — e o próprio catch abaixo faz
          // msg.localId, então o TypeError escapa do try e vira
          // uncaughtException (processo inteiro cai com 1 frame `null`).
          if (!msg || typeof msg !== 'object') return
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
            /**
             * `!comando` do chat: roda na pasta do terminal e a saída volta só
             * para quem pediu.
             *
             * SÓ da máquina do servidor. Pela rede a saída seria de um computador
             * que quem pediu não está usando — e a porta de execução ficaria
             * aberta a qualquer um que tenha entrado na interface. (Quem está na
             * máquina já podia pedir o mesmo a um agente, que roda com
             * `--dangerously-skip-permissions`: o atalho tira fricção, não muro.)
             */
            else if (msg.type === 'shell') runShellFor(client, msg.localId, msg.command)
          } catch (err) {
            socket.send(JSON.stringify({ type: 'error', localId: msg.localId, message: (err as Error).message }))
          }
        })
      })
    },
  }
}

export type WsHub = ReturnType<typeof createWsHub>
