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
// A revogação (`closeUser`/`closeAll`) fecha com 1008 'revoked'. Na mesma hora o
// socket para de aceitar entrada e o espectador sai (a presença do bastão começa
// a contar: volta ao agente em 30 s), sem esperar o fim do fechamento.
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { BrowserClientMsg, BrowserStateMsg } from '../../../shared/browser.js'
import type { Db } from '../db.js'
import { createProjectsService } from '../projects.js'
import { canAccessProject } from '../auth/guards.js'
import { watchSocketAccess } from '../auth/socket-access.js'
import { isAllowedOrigin } from '../routes/terminal.js'
import { hasEngine } from '../engine/index.js'
import { envMissingText, INSTALL_COMMAND, resolveChromium } from './chromium.js'
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
/**
 * Teto da vez de uma navegação: o `goto` desiste em 10 s e espera o `load` da
 * página de erro por mais 1,5 s; uma subida de Chromium presa não segura as
 * navegações seguintes do socket para sempre.
 */
const NAV_CAP_MS = 15_000
/**
 * Depois do `close(1008)` da revogação, o `ws` espera a resposta do cliente por
 * até 30 s; sem ela em 1 s, o socket é derrubado (`terminate`).
 */
const REVOKE_TERMINATE_MS = 1_000

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
  if (!found.ok && found.reason === 'env_missing') return { code: 'browser_not_installed', ...envMissingText(found.expected) }
  if (!found.ok) return { code: 'browser_not_installed', message: TEXTS.NOT_INSTALLED, hint: INSTALL_COMMAND }
  // O executável existe e a subida falhou: a mensagem do Chromium ficou no log do serviço.
  return { code: 'launch_failed', message: 'the browser failed to start; see the server log', hint: `executable: ${found.path}` }
}

/**
 * Não esperam a fila do mouse e do teclado:
 * - bastão e diálogo: o clique que abriu um `confirm` fica preso no Playwright
 *   até o diálogo ser respondido, e o `dialog` não pode ficar atrás dele;
 * - navegação e histórico: o `navigate` dispensa o diálogo pendente (o mesmo
 *   clique preso), e "Recarregar" é a saída de uma página que travou a fila.
 *   Eles têm a própria vez (uma navegação por socket; ver `navigateSlot`).
 */
const IMMEDIATE = new Set<BrowserClientMsg['type']>(['take', 'release', 'dialog'])

/** `p` ou o teto, o que vier primeiro (o que passou do teto segue sozinho). */
function capped(p: Promise<void>, ms: number): Promise<void> {
  let cap: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<void>((resolve) => { cap = setTimeout(resolve, ms) })
  return Promise.race([p, t]).finally(() => clearTimeout(cap))
}

/** Uma revogação em curso: fecha o socket com 1008 e, sem resposta, o derruba. */
function revokeSocket(socket: WebSocket): void {
  if (socket.readyState === socket.CLOSED) return
  if (socket.readyState === socket.OPEN) socket.close(1008, 'revoked')
  const t = setTimeout(() => { if (socket.readyState !== socket.CLOSED) socket.terminate() }, REVOKE_TERMINATE_MS)
  t.unref?.()
}

export function registerBrowserSocket(app: FastifyInstance, d: BrowserSocketDeps): { closeUser(userId: number): void; closeAll(): void } {
  const projects = createProjectsService(d.db)
  /**
   * Os sockets abertos (com aba ou não), para a revogação. `shutdown` corta a
   * entrada e tira o espectador na hora, depois fecha com 1008: o `close()` só
   * põe o socket em CLOSING, e o `ws` segue entregando mensagens até o fim do
   * fechamento (até 30 s sem resposta do cliente).
   */
  const live = new Set<{ userId: number | null; shutdown: () => void }>()

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
    const entry = { userId: user?.id ?? null, shutdown: () => revokeSocket(socket) }
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
    /** Sem entrada nem espectador a partir daqui (o `remove` repetido não faz nada). */
    function stop(): void {
      closed = true
      offClosed()
      vs.remove(v.id)
    }
    socket.once('close', stop)
    entry.shutdown = () => { stop(); revokeSocket(socket) }

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
        return capped(run(msg), STEP_CAP_MS)
      }).finally(() => { queued-- })
    }

    /**
     * Congelar: PNG do viewport só a este espectador, no máximo um screenshot em
     * voo. Repetir `on` com ele em voo não tira outro (o em voo serve); um `off`
     * no meio descarta o PNG atrasado e, se vier outro `on`, tira um novo ao fim.
     */
    let wantFrozen = false
    let freezeGen = 0
    let shooting = false
    function freeze(on: boolean): void {
      if (on !== wantFrozen) freezeGen++
      wantFrozen = on
      vs.update(v.id, { frozen: on })
      if (on && !shooting) void shoot()
    }
    async function shoot(): Promise<void> {
      shooting = true
      try {
        while (wantFrozen && !closed) {
          const g = freezeGen
          let png: Buffer | null = null
          try { png = await tab!.page().screenshot({ type: 'png' }) } catch { png = null }
          if (closed) return
          if (g !== freezeGen) continue // descongelou no meio: o PNG é velho
          if (png) vs.sendStill(v.id, png, tab!.state().viewport)
          else {
            // Sem o PNG (página travada ou fechando), a tela volta a andar.
            wantFrozen = false
            freezeGen++
            vs.update(v.id, { frozen: false })
          }
          return
        }
      } finally {
        shooting = false
      }
    }

    /**
     * Uma navegação (`navigate`/`history`) por vez neste socket: rajadas não
     * disparam `goto` concorrentes. Com uma em curso, o pedido novo espera a
     * vez e substitui o que já esperava: o mais recente vence, os do meio são
     * descartados. Cada vez tem o teto `NAV_CAP_MS`.
     */
    let navigating = false
    let nextNav: BrowserClientMsg | null = null
    function navigateSlot(msg: BrowserClientMsg): void {
      if (navigating) { nextNav = msg; return }
      navigating = true
      void (async () => {
        let m: BrowserClientMsg | null = msg
        while (m && !closed) {
          await capped(run(m), NAV_CAP_MS)
          m = nextNav
          nextNav = null
        }
        nextNav = null
        navigating = false
      })()
    }

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      // CLOSING também barra: o `ws` entrega mensagens até o fim do fechamento.
      if (socket.readyState !== socket.OPEN || !access.allowed() || closed) return
      if (isBinary || data.length > MAX_MESSAGE_BYTES) return
      const msg = parseClientMessage(data.toString('utf8'))
      if (!msg) return
      switch (msg.type) {
        case 'visible': vs.update(v.id, { visible: msg.visible }); return
        // A troca de viewport já é uma por vez em `viewers` (a do meio roda depois, com o valor do momento).
        case 'resize': vs.update(v.id, { size: { width: msg.width, height: msg.height } }); return
        case 'freeze': freeze(msg.on); return
        case 'navigate':
        case 'history': navigateSlot(msg); return
        default:
          // Bastão e diálogo vão na hora; o resto (mouse, teclado, texto) entra na fila.
          if (IMMEDIATE.has(msg.type)) void run(msg)
          else enqueue(msg)
      }
    })
  })

  return {
    closeUser(userId) {
      for (const e of [...live]) if (e.userId === userId) e.shutdown()
    },
    closeAll() {
      for (const e of [...live]) e.shutdown()
    },
  }
}
