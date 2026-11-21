import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { SessionManager } from '../claude/manager.js'
import type { SettingsService } from '../settings.js'
import { requireAdmin, requireProjectAccess } from '../auth/guards.js'
import { createPreviewStore, type PreviewStore } from '../files/preview.js'
import { UserError, errorBody } from '../user-error.js'
import type { PageNetwork } from '../../../shared/visual-pages.js'
import { PAGE_PERMISSIONS_POLICY, pageCsp } from './csp.js'
import { withHeightScript } from './height-script.js'
import { PAGE_NETWORK_KEY, readNetwork } from './settings.js'
import type { PagesService } from './service.js'

/** Corpo do `POST /api/hermes/pages`: o `html` vai até 512 K caracteres, que em UTF-8 e JSON passam de 512 KB. */
const PUBLISH_BODY_LIMIT = 2 * 1024 * 1024

/** Status das recusas que não são 400. */
const STATUS: Record<string, number> = { no_live_session: 409, project_not_found: 404 }

const ID_RE = /^pg_[0-9a-f]{16}$/
export const PAGE_VIEW_BASE = '/api/pages/view'

/** O 404 da página servida: aparece dentro do cartão ou da aba, por isso é página e não JSON. */
const EXPIRED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Claudinei</title></head>
<body style="font:14px/1.5 system-ui,sans-serif;color:#777;margin:16px">
<p lang="pt-BR">Esta página expirou ou não existe. Reabra pelo Claudinei.</p>
<p lang="en">This page has expired or does not exist. Reopen it from Claudinei.</p>
<p lang="es">Esta página caducó o no existe. Vuelve a abrirla desde Claudinei.</p>
</body></html>`

/** Cabeçalhos comuns ao documento servido e ao seu 404. */
function frameHeaders(reply: FastifyReply): void {
  reply.header('Content-Type', 'text/html; charset=utf-8')
  // O app inteiro responde DENY; o cartão e a tela cheia PRECISAM embutir.
  reply.header('X-Frame-Options', 'SAMEORIGIN')
  reply.header('Cache-Control', 'no-store')
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Referrer-Policy', 'no-referrer')
  reply.header('Permissions-Policy', PAGE_PERMISSIONS_POLICY)
}

export function registerPageRoutes(
  app: FastifyInstance,
  deps: {
    pages: PagesService
    manager: Pick<SessionManager, 'get'>
    settings: SettingsService
    /** Tokens de exibição: instância própria, separada da prévia de arquivos. */
    views?: PreviewStore
    /** Lida a cada pedido: a mudança vale na próxima abertura. */
    network: () => PageNetwork
  },
): void {
  const views = deps.views ?? createPreviewStore()

  // A rede das páginas: global da instalação, todos leem, só o admin muda (como
  // o auto-compact). Vale na próxima abertura: a rota de exibição lê a cada pedido.
  app.get('/api/visual-pages/settings', async () => ({ network: readNetwork(deps.settings) }))
  app.put('/api/visual-pages/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const network = (req.body as { network?: unknown } | null)?.network
    if (network !== 'cdn' && network !== 'open') {
      return reply.code(400).send({ error: "network must be 'cdn' or 'open'" })
    }
    deps.settings.set(PAGE_NETWORK_KEY, network)
    return { network }
  })

  // O show_page do Hermes: publica a página na conversa viva do terminal (projeto + motor).
  app.post('/api/hermes/pages', { bodyLimit: PUBLISH_BODY_LIMIT }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const projectId = Number(body.projectId)
    if (!Number.isInteger(projectId) || projectId <= 0) return reply.code(400).send({ error: 'projectId is required' })
    // O acesso antes de olhar se o projeto existe: sem oráculo de ids para quem não o vê.
    if (!requireProjectAccess(req, reply, projectId)) return
    const engine = typeof body.engine === 'string' ? body.engine : ''
    if (!engine) return reply.code(400).send({ error: 'engine is required' })
    try {
      const r = deps.pages.publish({
        projectId, engine, html: body.html, path: body.path, title: body.title, height: body.height,
      })
      return reply.code(201).send(r)
    } catch (err) {
      if (err instanceof UserError) return reply.code(STATUS[err.code] ?? 400).send(errorBody(err))
      console.error('[páginas] publicar falhou', err)
      return reply.code(500).send({ error: 'could not publish the page' })
    }
  })

  // As páginas da conversa do terminal, em ordem de criação.
  app.get('/api/sessions/:localId/pages', async (req, reply) => {
    const { localId } = req.params as { localId: string }
    const info = deps.manager.get(localId)
    if (!info) return reply.code(404).send({ error: 'session not found' })
    if (!requireProjectAccess(req, reply, info.projectId)) return
    return deps.pages.store.listConversation(info.projectId, info.engine, info.engineSessionId ?? null, localId)
  })

  app.get('/api/pages/:id', async (req, reply) => {
    const page = deps.pages.get((req.params as { id: string }).id)
    if (!page) return reply.code(404).send({ error: 'page not found' })
    if (!requireProjectAccess(req, reply, page.projectId)) return
    return page
  })

  /**
   * Emite a URL de exibição: token novo a cada pedido (cartão, tela cheia e
   * nova aba têm cada um o seu), preso ao arquivo da página, a quem pediu e à
   * sessão dele (`accessAllowed`). Exige cookie e acesso ao projeto.
   */
  app.post('/api/pages/:id/view', async (req, reply) => {
    const { id } = req.params as { id: string }
    const page = ID_RE.test(id) ? deps.pages.get(id) : undefined
    if (!page) return reply.code(404).send({ error: 'page not found' })
    if (!requireProjectAccess(req, reply, page.projectId)) return
    const file = deps.pages.filePath(id)
    if (!existsSync(file)) return reply.code(404).send({ error: 'page file not found' })
    const token = views.issue(file, req.socket.remoteAddress, req.accessAllowed)
    return { url: `${PAGE_VIEW_BASE}/${token}/${id}.html` }
  })

  /**
   * Serve a página. Pública (auth/plugin.ts): o iframe sandbox não manda
   * cookie, quem autoriza é o token. Só aquele documento; qualquer outro nome,
   * id ou token dá o mesmo 404, sem dizer o que existe.
   */
  app.get(`${PAGE_VIEW_BASE}/:token/:file`, async (req, reply) => {
    const { token, file } = req.params as { token: string; file: string }
    const notFound = () => {
      frameHeaders(reply)
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
      return reply.code(404).send(EXPIRED_HTML)
    }
    const grant = views.resolve(token, req.socket.remoteAddress)
    if (!grant) return notFound()
    const id = file.endsWith('.html') ? file.slice(0, -'.html'.length) : ''
    if (!ID_RE.test(id) || file !== `${id}.html`) return notFound()
    const path = deps.pages.filePath(id)
    if (grant.root !== path) return notFound()
    let html: string
    try { html = await readFile(path, 'utf8') } catch { return notFound() }
    frameHeaders(reply)
    reply.header('Content-Security-Policy', pageCsp(deps.network()))
    return reply.send(withHeightScript(html))
  })
}
