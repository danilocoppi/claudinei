// O WebSocket da tela do navegador embutido: `GET /ws/browser/:projectId/:engine`.
// Um socket é uma coluna aberta (um espectador da aba do terminal). Na ordem:
// 1. origem permitida (`isAllowedOrigin`), senão fecha 1008 'origin';
// 2. horário de acesso (`watchSocketAccess`: conferido a cada segundo, a cada
//    mensagem e a cada envio; fora dele, fecha 1008 'access_hours');
// 3. projeto existe e o usuário tem acesso, senão 1008 'forbidden'; motor
//    desconhecido, 1008 'engine';
// 4. a aba do terminal: sem aba, manda um `state` com `closed: 'closed_by_user'`
//    e fecha 1000; com o Chromium indisponível, manda um `state` com
//    `unavailable` e mantém o socket.
// O cookie e o 401 já vêm do `onRequest` do plugin de auth (`/ws/` é guardado).
// A revogação (`closeUser`/`closeAll`) fecha com 1008 'revoked'. A saída do
// espectador entra na presença do bastão (volta ao agente em 30 s).
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { BrowserClientMsg, BrowserStateMsg } from '../../../shared/browser.js'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { canAccessProject } from '../auth/guards.js'
import { watchSocketAccess } from '../auth/socket-access.js'
import { isAllowedOrigin } from '../routes/terminal.js'
import { hasEngine } from '../engine/index.js'
import { INSTALL_COMMAND, resolveChromium } from './chromium.js'
import type { BrowserHost, TerminalTab } from './host.js'
import { applyInput, createMoveLimiter, parseClientMessage } from './input.js'
import { DEFAULT_VIEWPORT, type Actor } from './terminal-tab.js'
import { TEXTS, type TabCloseReason } from './types.js'
import type { Viewers, ViewerSink } from './viewers.js'
import { ENGINE_RE } from './hermes-routes.js'

/** Mensagem maior que isto nem é lida (o `text` válido tem no máximo 10 000 caracteres). */
const MAX_MESSAGE_BYTES = 64 * 1024
/**
 * Teto de uma entrada da fila (mouse, teclado, texto) antes de a próxima seguir:
 * a página presa num laço não segura as entradas seguintes para sempre.
 */
const STEP_CAP_MS = 5_000
/** Entradas esperando na fila; acima disto, a página não está respondendo e o resto é descartado. */
const MAX_QUEUED = 64
/** Com a fila acima disto, os movimentos do mouse são descartados (o clique leva a posição final). */
const MOVE_QUEUE_LIMIT = 4

export interface BrowserSocketDeps {
  host: BrowserHost
  db: Db
  viewersFor: (tab: TerminalTab) => Viewers
}

/** O `state` sem aba: a coluna mostra o fechamento ou o "não instalado". */
function emptyState(host: BrowserHost, extra: Pick<BrowserStateMsg, 'closed' | 'unavailable'>): BrowserStateMsg {
  return {
    type: 'state', url: 'about:blank', title: '', loading: false, crashed: false,
    baton: { kind: 'free' }, viewport: { ...DEFAULT_VIEWPORT }, dialog: null, notices: [], lastAction: null,
    sandbox: host.status().reason !== 'no_sandbox',
    ...extra,
  }
}

/** Por que o Chromium não está disponível, nos mesmos textos que as ferramentas dão. */
function unavailableInfo(): NonNullable<BrowserStateMsg['unavailable']> {
  const found = resolveChromium(process.env)
  if (!found.ok && found.reason === 'env_missing') {
    return {
      code: 'browser_not_installed',
      message: `Browser not found: CLAUDINEI_CHROMIUM=${found.expected} does not exist; fix or unset it`,
      hint: `fix or unset CLAUDINEI_CHROMIUM (${found.expected})`,
    }
  }
  if (!found.ok) return { code: 'browser_not_installed', message: TEXTS.NOT_INSTALLED, hint: INSTALL_COMMAND }
  // O executável existe e a subida falhou: a mensagem do Chromium ficou no log do serviço.
  return { code: 'launch_failed', message: 'the browser failed to start; see the server log', hint: `executable: ${found.path}` }
}

/** Vão à página na hora, sem esperar a fila do mouse e do teclado. */
const IMMEDIATE = new Set<BrowserClientMsg['type']>(['take', 'release', 'dialog', 'navigate', 'history'])

export function registerBrowserSocket(app: FastifyInstance, d: BrowserSocketDeps): { closeUser(userId: number): void; closeAll(): void } {
  const projects = createProjectsService(d.db)
  /** Os sockets abertos (com aba ou não), para a revogação. */
  const live = new Set<{ socket: WebSocket; userId: number | null }>()

  app.get('/ws/browser/:projectId/:engine', { websocket: true }, (socket, req) => {
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) { socket.close(1008, 'origin'); return }
    const access = watchSocketAccess(socket, req)
    if (!access.allowed()) return
    const params = req.params as { projectId: string; engine: string }
    const projectId = Number(params.projectId)
    const project = Number.isSafeInteger(projectId) && projectId > 0 ? projects.get(projectId) : undefined
    if (!project || !canAccessProject(req.authUser, project.id)) { socket.close(1008, 'forbidden'); return }
    const engine = params.engine
    if (!ENGINE_RE.test(engine) || !hasEngine(engine)) { socket.close(1008, 'engine'); return }

    const user = req.authUser?.kind === 'user' ? req.authUser : undefined
    const entry = { socket, userId: user?.id ?? null }
    live.add(entry)
    socket.once('close', () => { live.delete(entry) })

    const tab = d.host.existingTab({ projectId: project.id, engine })
    const gone: TabCloseReason | null = tab ? tab.closedReason() : null
    if (!tab || gone) {
      if (!tab && d.host.status().state === 'unavailable') {
        // Fica aberto: a coluna mostra o comando de instalação; nada mais sai daqui.
        access.send(JSON.stringify(emptyState(d.host, { unavailable: unavailableInfo() })))
        return
      }
      access.send(JSON.stringify(emptyState(d.host, { closed: gone ?? 'closed_by_user' })))
      socket.close(1000)
      return
    }

    const actor: Actor = { kind: 'operator', userId: user?.id ?? null, name: user?.username ?? 'operador' }
    const vs = d.viewersFor(tab)
    const sink: ViewerSink = {
      get bufferedAmount() { return access.bufferedAmount },
      sendBinary: (b) => access.sendBinary(b),
      sendText: (s) => access.send(s),
    }
    const v = vs.add({ userId: actor.userId, name: actor.name, sink, visible: false, frozen: false, size: null })
    let closed = false
    // Os espectadores já mandaram o último state (com `closed`); aqui só fecha.
    const offClosed = tab.onClosed(() => { if (socket.readyState === socket.OPEN) socket.close(1000) })
    socket.once('close', () => {
      closed = true
      offClosed()
      vs.remove(v.id)
    })

    const canMove = createMoveLimiter()
    /** A entrada falhou (página travada, tecla recusada): o socket segue; a aba avisa da queda. */
    const run = (msg: BrowserClientMsg): Promise<void> =>
      applyInput(tab, msg, actor, { canMove }).catch(() => { /* ignorada */ })

    // Mouse, teclado e texto vão em ordem, um de cada vez (o "down" antes do "up").
    let chain: Promise<void> = Promise.resolve()
    let queued = 0
    function enqueue(msg: BrowserClientMsg): void {
      if (queued >= MAX_QUEUED) return
      if (msg.type === 'pointer' && msg.phase === 'move' && queued > MOVE_QUEUE_LIMIT) return
      queued++
      chain = chain.then(() => {
        if (closed) return
        let cap: ReturnType<typeof setTimeout> | undefined
        const capped = new Promise<void>((resolve) => { cap = setTimeout(resolve, STEP_CAP_MS) })
        return Promise.race([run(msg), capped]).finally(() => clearTimeout(cap))
      }).finally(() => { queued-- })
    }

    /** Congelar: PNG do viewport só a este espectador. Um pedido novo vence o anterior. */
    let freezeGen = 0
    async function freeze(on: boolean): Promise<void> {
      const g = ++freezeGen
      vs.update(v.id, { frozen: on })
      if (!on) return
      try {
        const png = await tab!.page().screenshot({ type: 'png' })
        if (g === freezeGen && !closed) vs.sendStill(v.id, png, tab!.state().viewport)
      } catch {
        // Sem o PNG (página travada ou fechando), a tela volta a andar.
        if (g === freezeGen && !closed) vs.update(v.id, { frozen: false })
      }
    }

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!access.allowed() || closed) return
      if (isBinary || data.length > MAX_MESSAGE_BYTES) return
      const msg = parseClientMessage(data.toString('utf8'))
      if (!msg) return
      switch (msg.type) {
        case 'visible': vs.update(v.id, { visible: msg.visible }); return
        case 'resize': vs.update(v.id, { size: { width: msg.width, height: msg.height } }); return
        case 'freeze': void freeze(msg.on); return
        default:
          // Bastão, diálogo e navegação não esperam a fila: o clique que abriu um
          // `confirm` fica preso até o diálogo ser respondido.
          if (IMMEDIATE.has(msg.type)) void run(msg)
          else enqueue(msg)
      }
    })
  })

  return {
    closeUser(userId) {
      for (const e of [...live]) if (e.userId === userId) e.socket.close(1008, 'revoked')
    },
    closeAll() {
      for (const e of [...live]) e.socket.close(1008, 'revoked')
    },
  }
}
