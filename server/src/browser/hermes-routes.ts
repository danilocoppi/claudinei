// As rotas que as ferramentas `browser_*` do hermes chamam:
// `POST /api/hermes/browser/:op`, com `{ projectId, engine, ...args }`.
// A autenticação é a do `goal-done`: projeto existe (senão 404), depois
// `requireProjectAccess`. O resultado é `{ text, status }` (a linha de estado da
// aba); todo erro conhecido vira status e `code` legíveis ao agente, e o
// inesperado vira 500 com a mensagem, sem derrubar o servidor.
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ProjectsService } from '../projects.js'
import { requireProjectAccess } from '../auth/guards.js'
import { hasEngine, listEngines } from '../engine/index.js'
import { saveUpload } from '../uploads.js'
import { BrowserBusyError, BrowserUnavailableError, type BrowserHost, type TerminalTab } from './host.js'
import { OperatorInControlError } from './baton.js'
import {
  agentOps, statusLine, PAGE_BUSY, PAGE_CRASHED,
  BadArgsError, DialogPendingError, StaleRefError, TabGoneError,
  type ActAction, type ActArgs, type AgentOps, type WaitArgs,
} from './agent-ops.js'
import { BrowserRestartingError, TEXTS, TooManyTabsError, type TerminalKey } from './types.js'

/** A forma do motor do terminal, como vem do hermes e da URL do operador (e ele tem de ser um motor registrado). */
export const ENGINE_RE = /^[a-z0-9_-]{1,32}$/

export const BROWSER_OPS = ['open', 'navigate', 'snapshot', 'act', 'wait', 'screenshot', 'console', 'close'] as const
export type BrowserOp = typeof BROWSER_OPS[number]

/** Quem abriu ou fechou a aba (vai no broadcast `browser_tab`). */
export type TabActor = 'agent' | 'operator' | 'system'

/** O terminal nunca abriu aba (ou ela já fechou e saiu do host): só a `browser_open` cria. */
export class NoTabError extends Error {
  readonly code = 'no_tab' as const
  constructor() {
    super('no browser tab is open in this terminal; call browser_open first')
    this.name = 'NoTabError'
  }
}

/** O texto da espera estourada (`agent-ops.ts`, `wait`): resposta legível, não erro interno. */
const WAIT_TIMEOUT = /^timed out after \d+ s waiting for /

export interface ErrorReply { status: number; body: { error: string; code: string; hint?: string } }

/**
 * Cada erro do navegador vira status e corpo. Os erros "comuns" (`Error` com a
 * mensagem conhecida: esquema recusado, página ocupada, página travada) são
 * reconhecidos pela mensagem, que é constante exportada de quem lança.
 */
export function browserErrorReply(err: unknown): ErrorReply {
  // A dica vazia não vai na resposta (o agente leria um campo sem conteúdo).
  const reply = (status: number, code: string, error: string, hint?: string): ErrorReply =>
    ({ status, body: hint ? { error, code, hint } : { error, code } })
  if (err instanceof OperatorInControlError) return reply(409, 'operator_in_control', TEXTS.OPERATOR_IN_CONTROL)
  if (err instanceof StaleRefError || err instanceof DialogPendingError) return reply(409, err.code, err.message)
  if (err instanceof BrowserUnavailableError) {
    // `browser_not_installed` traz TEXTS.NOT_INSTALLED (ou, com CLAUDINEI_CHROMIUM
    // apontando arquivo ausente, o texto de corrigir a variável); `launch_failed`,
    // a mensagem do Chromium.
    return reply(503, err.code, err.message, err.hint)
  }
  if (err instanceof TooManyTabsError) return reply(503, err.code, TEXTS.TOO_MANY_TABS)
  if (err instanceof BrowserBusyError) return reply(503, err.code, err.message)
  // O processo caiu enquanto a aba abria: a próxima tentativa sobe outro.
  if (err instanceof BrowserRestartingError) return reply(503, err.code, err.message)
  if (err instanceof TabGoneError || err instanceof NoTabError) return reply(410, err.code, err.message)
  if (err instanceof BadArgsError) return reply(400, err.code, err.message)
  const message = err instanceof Error ? err.message : String(err)
  if (message === TEXTS.SCHEME_REFUSED) return reply(400, 'scheme_refused', message)
  // A página que não responde no prazo geral: a operação não terminou.
  if (message === PAGE_BUSY) return reply(504, 'page_busy', message)
  // A página travada: o estado dela é de conflito (o reload a recria).
  if (message === PAGE_CRASHED) return reply(409, 'page_crashed', message)
  if (message === 'no dialog is pending') return reply(409, 'no_dialog', message)
  if (WAIT_TIMEOUT.test(message)) return reply(504, 'wait_timeout', message)
  return reply(500, 'internal', message)
}

/**
 * O erro inesperado (o que cairia em 500) relido pelo estado da aba em que a
 * operação correu. O guarda das operações escuta o fechamento da aba e o
 * diálogo, não a queda da página: a página que trava no meio de uma ação faz o
 * Playwright rejeitar com "Page crashed" (TargetClosedError), e a queda do
 * Chromium pode rejeitar antes de o `onClosed` avisar. A aba fechada vem
 * primeiro (o reload não a traz de volta; só a `browser_open`); depois, a
 * página travada.
 */
export function errorInTab(err: unknown, tab: TerminalTab | undefined): unknown {
  if (!tab || browserErrorReply(err).status !== 500) return err
  const reason = tab.closedReason()
  if (reason) return new TabGoneError(reason)
  if (tab.state().crashed) return new Error(PAGE_CRASHED)
  return err
}

/** Manda o erro na resposta; o inesperado vai também ao log. */
export function sendBrowserError(reply: FastifyReply, err: unknown, where: string): FastifyReply {
  const r = browserErrorReply(err)
  if (r.status === 500) console.error(`[navegador] ${where} falhou`, err)
  return reply.code(r.status).send(r.body)
}

/**
 * O terminal do pedido, com a autenticação do `goal-done`: projeto inexistente
 * → 404; sem acesso → 403; motor fora de `ENGINE_RE` → 400. Já respondido o
 * erro, devolve undefined.
 */
export function terminalOf(
  req: FastifyRequest, reply: FastifyReply, projects: ProjectsService, projectId: unknown, engine: unknown,
): TerminalKey | undefined {
  const project = projects.get(Number(projectId))
  if (!project) { reply.code(404).send({ error: 'project does not exist', code: 'no_project' }); return undefined }
  if (!requireProjectAccess(req, reply, project.id)) return undefined
  if (typeof engine !== 'string' || !ENGINE_RE.test(engine)) {
    reply.code(400).send({ error: 'engine must match /^[a-z0-9_-]{1,32}$/', code: 'bad_args' })
    return undefined
  }
  // Só os motores do Claudinei: um nome inventado abriria abas fora de terminal
  // nenhum e, perto do teto, despejaria as de outros projetos.
  if (!hasEngine(engine)) {
    const known = listEngines().map((e) => e.id).join(', ')
    reply.code(400).send({ error: `unknown engine '${engine}'; use one of ${known}`, code: 'bad_args' })
    return undefined
  }
  return { projectId: project.id, engine }
}

export interface BrowserRouteDeps {
  host: BrowserHost
  projects: ProjectsService
  uploadsDir: string
  /** Abre ou reaproveita a aba do terminal e anuncia a que nasceu (por quem pediu). */
  openTab(key: TerminalKey, by: Exclude<TabActor, 'system'>): Promise<TerminalTab>
}

type Body = Record<string, unknown>
interface OpResult { text: string; status: string; png?: string; path?: string }

/** O campo opcional do corpo: ausente ou null → undefined; presente, tem de ser do tipo. */
function opt<T extends 'string' | 'number' | 'boolean'>(body: Body, name: string, type: T):
  (T extends 'string' ? string : T extends 'number' ? number : boolean) | undefined {
  const v = body[name]
  if (v === undefined || v === null) return undefined
  if (typeof v !== type) throw new BadArgsError(`${name} must be a ${type}`)
  return v as never
}

const CLOSED_STATUS = 'Browser: closed'

export function registerBrowserHermesRoutes(app: FastifyInstance, d: BrowserRouteDeps): void {
  const opsFor = (tab: TerminalTab, key: TerminalKey): AgentOps =>
    agentOps(tab, { closeTab: (reason) => d.host.closeTab(key, reason) })

  /** `seen` recebe a aba em que a operação corre: o `catch` da rota relê o erro pelo estado dela. */
  async function run(op: BrowserOp, key: TerminalKey, body: Body, seen: (tab: TerminalTab) => void): Promise<OpResult> {
    if (op === 'open') {
      const url = opt(body, 'url', 'string')
      const tab = await d.openTab(key, 'agent')
      seen(tab)
      const text = await opsFor(tab, key).open(url)
      return { text, status: statusLine(tab) }
    }
    // As outras não criam aba: só a `browser_open` cria (e anuncia).
    const tab = d.host.existingTab(key)
    if (!tab) {
      if (op === 'close') return { text: 'browser already closed', status: CLOSED_STATUS }
      throw new NoTabError()
    }
    seen(tab)
    const ops = opsFor(tab, key)
    const done = (text: string): OpResult => ({ text, status: statusLine(tab) })
    switch (op) {
      case 'navigate': {
        const url = opt(body, 'url', 'string')
        const action = body.action ?? undefined
        if ((url === undefined) === (action === undefined)) {
          throw new BadArgsError("navigate needs exactly one of url or action ('back' | 'forward' | 'reload')")
        }
        return done(await ops.navigate(url !== undefined ? { url } : { action: action as 'back' | 'forward' | 'reload' }))
      }
      case 'snapshot': {
        // A conferência (inteiro positivo) é da operação.
        const depth = body.depth ?? undefined
        return done(await ops.snapshot(depth as number | undefined))
      }
      case 'act': {
        const a: ActArgs = { action: body.action as ActAction }
        const ref = opt(body, 'ref', 'string'); if (ref !== undefined) a.ref = ref
        const text = opt(body, 'text', 'string'); if (text !== undefined) a.text = text
        const pressKey = opt(body, 'key', 'string'); if (pressKey !== undefined) a.key = pressKey
        const dx = opt(body, 'dx', 'number'); if (dx !== undefined) a.dx = dx
        const dy = opt(body, 'dy', 'number'); if (dy !== undefined) a.dy = dy
        const accept = opt(body, 'accept', 'boolean'); if (accept !== undefined) a.accept = accept
        return done(await ops.act(a))
      }
      case 'wait': {
        // Só as quatro chaves da espera: `projectId` e `engine` não contam.
        const w: Record<string, unknown> = {}
        for (const k of ['text', 'textGone', 'url', 'seconds']) {
          if (body[k] !== undefined && body[k] !== null) w[k] = body[k]
        }
        return done(await ops.wait(w as WaitArgs))
      }
      case 'screenshot': {
        const fullPage = opt(body, 'fullPage', 'boolean')
        const buf = await ops.screenshot(fullPage)
        // Também em arquivo: motor que não mostra imagem de ferramenta MCP lê o caminho.
        const saved = await saveUpload(d.uploadsDir, 'navegador.png', Readable.from(buf))
        return { ...done(`screenshot of ${tab.state().url}`), png: buf.toString('base64'), path: saved.path }
      }
      case 'console': {
        const entries = ops.console()
        const text = entries.length === 0 ? 'no console messages' : entries.map((e) => `[${e.type}] ${e.text}`).join('\n')
        return done(text)
      }
      case 'close':
        await ops.close()
        return { text: 'browser closed', status: CLOSED_STATUS }
    }
    // O `op` já foi conferido contra BROWSER_OPS.
    throw new BadArgsError(`unknown browser op '${op as string}'`)
  }

  app.post('/api/hermes/browser/:op', async (req, reply) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Body
    const key = terminalOf(req, reply, d.projects, body.projectId, body.engine)
    if (!key) return reply
    const op = (req.params as { op: string }).op
    if (!(BROWSER_OPS as readonly string[]).includes(op)) {
      return reply.code(404).send({ error: `unknown browser op '${op}'; use one of ${BROWSER_OPS.join(', ')}`, code: 'unknown_op' })
    }
    // Guardada fora do `try`: fechada, a aba sai do host, e o `catch` ainda a lê.
    let tab: TerminalTab | undefined
    try {
      return await run(op as BrowserOp, key, body, (t) => { tab = t })
    } catch (err) {
      return sendBrowserError(reply, errorInTab(err, tab), `browser ${op}`)
    }
  })
}
