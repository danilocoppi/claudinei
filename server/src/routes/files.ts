import type { FastifyInstance, FastifyRequest } from 'fastify'
import { spawn } from 'node:child_process'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, sep } from 'node:path'
import { canAccessProject } from '../auth/guards.js'
import { isTrustedLocal } from '../auth/plugin.js'
import { hashContent } from '../files/hash.js'
import { createPreviewStore, pathFromPreviewUrl, previewUrl, type PreviewStore } from '../files/preview.js'
import { resolveInScope } from '../files/scope.js'
import type { ProjectsService } from '../projects.js'

const TEXT_CAP = 2 * 1024 * 1024 // 2 MB p/ texto/markdown/código
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
}

// Tipos que uma página puxa por conta própria. Fora desta lista vai
// `application/octet-stream`: adivinhar tipo é justamente o que o `nosniff` veio
// impedir, e um tipo errado aqui só faria o navegador executar o que não devia.
const PREVIEW_MIME: Record<string, string> = {
  ...MIME,
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
}

const HTML_EXT = new Set(['.html', '.htm', '.xhtml'])
export const isHtmlFile = (p: string) => HTML_EXT.has(extname(p).toLowerCase())

// Host é dado do cliente: sem esta peneira, um `;` nele reescreve a política.
const HOST_OK = /^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/

/**
 * A política do documento renderizado.
 *
 * `sandbox` vale mesmo se alguém abrir a URL direto numa aba, onde o atributo do
 * iframe não existiria: sem `allow-same-origin`, a página fica numa origem opaca
 * e não alcança cookie, storage nem a API do Claudinei. `allow-scripts` fica
 * porque página real usa script — a galeria que motivou isto monta os `src` em
 * JS, e sem ele o operador veria uma casca vazia.
 *
 * E todo subrecurso fica preso à origem que serviu a página. O motivo é o token:
 * ele viaja na URL, e qualquer script da própria página lê `location.href` —
 * então `connect-src 'none'` sozinho não bastava, bastava um
 * `<img src="https://alheio/?t=…">` para a capacidade de leitura ir embora
 * calada. O custo é consciente: página que puxa CSS/fonte de CDN aparece sem
 * eles. Entre renderizar bonito e não vazar chave de leitura, fica o segundo.
 *
 * `'self'` NÃO serve aqui: em origem opaca ele não casa com nada e derrubaria
 * até as imagens do próprio preview — por isso a origem entra escrita.
 */
function previewCsp(host?: string): string {
  // Sem Host confiável não dá para escrever a origem; então nada carrega. A
  // página ainda aparece (o HTML é o próprio documento), só sem subrecurso.
  const origem = host && HOST_OK.test(host) ? `http://${host} https://${host}` : "'none'"
  return [
    'sandbox allow-scripts',
    `default-src ${origem}`,
    `img-src ${origem} data: blob:`,
    `style-src ${origem} 'unsafe-inline'`,
    // Página local é feita de script inline; sem isto sobra a casca.
    `script-src ${origem} 'unsafe-inline' 'unsafe-eval'`,
    `font-src ${origem} data:`,
    `media-src ${origem} data: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    // <base href="https://alheio/"> reapontaria todo relativo para fora.
    "base-uri 'none'",
  ].join('; ')
}

/**
 * Raiz que o token libera. O projeto inteiro quando o arquivo está dentro dele —
 * é preciso: `../fotos/p.png` sai do diretório do HTML, e travar no diretório
 * deixaria a página sem imagem. Fora de projeto (admin abrindo caminho solto),
 * fica só a pasta do arquivo.
 */
function previewRoot(real: string, project: { id: number; path: string } | null): string {
  if (project) {
    try {
      const raiz = realpathSync(project.path)
      if (real === raiz || real.startsWith(raiz + sep)) return raiz
    } catch { /* projeto sumiu do disco: cai na pasta do arquivo */ }
  }
  return dirname(real)
}

/**
 * Abre a pasta no gerenciador de arquivos do desktop. Desacoplado (spawn sem shell,
 * detached) para o processo do Claudinei não ficar preso ao gerenciador — e para o
 * teste poder injetar um dublê no lugar.
 */
function defaultRevealInFolder(dir: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' })
  child.unref()
}

// authUser === undefined = auth desativada (modo local single-user) → trata como admin.
function isAdminReq(req: FastifyRequest): boolean {
  const u = req.authUser
  if (!u) return true
  return u.kind === 'user' && u.isAdmin
}

// Projeto acessível pelo usuário, ou null (relativo será ignorado; absoluto só p/ admin).
function projectFor(req: FastifyRequest, projects: ProjectsService, projectId?: number): { id: number; path: string } | null {
  if (!projectId) return null
  if (!canAccessProject(req.authUser, projectId)) return null
  const p = projects.get(projectId)
  return p ? { id: p.id, path: p.path } : null
}

/**
 * A requisição veio da PRÓPRIA máquina do servidor?
 *
 * "Abrir na pasta" executa um programa no host. A UI já esconde o item fora de
 * localhost, mas esconder um botão não impede ninguém de chamar a rota direto —
 * quem chega pela rede é barrado aqui.
 */
// O gate mora em auth/plugin.ts: lê o par TCP, e não `req.ip`, que vira o
// `X-Forwarded-For` se algum dia alguém ligar `trustProxy`.

export function registerFileRoutes(
  app: FastifyInstance,
  deps: { projects: ProjectsService; revealInFolder?: (dir: string) => void; previews?: PreviewStore },
): void {
  const previews = deps.previews ?? createPreviewStore()

  // Abre o gerenciador de arquivos na pasta do arquivo. O caminho NUNCA vai cru
  // para o SO: passa pelo mesmo resolveInScope das outras rotas, então o
  // parâmetro não vira "abra qualquer pasta da máquina".
  app.post('/api/files/reveal', async (req, reply) => {
    if (!isTrustedLocal(req)) return reply.code(403).send({ error: 'somente local' })
    const body = req.body as { path?: unknown; projectId?: number }
    const raw = typeof body?.path === 'string' ? body.path : ''
    if (!raw) return reply.code(404).send({ error: 'arquivo não encontrado' })
    const project = projectFor(req, deps.projects, body?.projectId)
    const r = resolveInScope(raw, project, isAdminReq(req))
    if (!r.exists || !r.inScope || !r.real) return reply.code(404).send({ error: 'arquivo não encontrado' })
    const open = deps.revealInFolder ?? defaultRevealInFolder
    try { open(dirname(r.real)) } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
    return { ok: true }
  })

  app.post('/api/files/resolve', async (req) => {
    const body = req.body as { paths?: unknown; projectId?: number }
    const paths = Array.isArray(body?.paths)
      ? body.paths.filter((p): p is string => typeof p === 'string').slice(0, 200)
      : []
    const project = projectFor(req, deps.projects, body?.projectId)
    const admin = isAdminReq(req)
    // `real` (realpath absoluto no servidor) é SÓ para uso server-side (a rota
    // content). Nunca vai pro cliente — vazaria layout de diretório/username do SO.
    return paths.map((raw) => {
      const { real: _real, ...rest } = resolveInScope(raw, project, admin)
      return rest
    })
  })
  app.get('/api/files/content', async (req, reply) => {
    const q = req.query as { path?: string; projectId?: string }
    if (!q?.path) return reply.code(400).send({ error: 'path required' })
    const projectId = q.projectId ? Number(q.projectId) : undefined
    const project = projectFor(req, deps.projects, projectId)
    const r = resolveInScope(q.path, project, isAdminReq(req))
    if (!r.exists) return reply.code(404).send({ error: 'not found' })
    if (!r.inScope) return reply.code(403).send({ error: 'forbidden' })
    const real = r.real!
    const filename = basename(real).replace(/["\\]/g, '\\$&')
    // Segurança: o conteúdo é servido na MESMA origem do app. `nosniff` impede o
    // browser de re-interpretar um texto como HTML; `sandbox` neutraliza scripts se
    // o recurso for renderizado como documento (ex.: um .svg malicioso com <script>
    // aberto direto na URL → XSS que roubaria o cookie de auth). Ver review HIGH.
    reply.header('X-Content-Type-Options', 'nosniff')
    if (r.kind === 'image' || r.kind === 'pdf') {
      const ext = extname(real).toLowerCase()
      reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream')
      reply.header('Content-Disposition', `inline; filename="${filename}"`)
      // SVG pode conter script executável; PDF é renderizado isolado (não vira XSS
      // na origem do app), então o sandbox vai só nas imagens.
      if (r.kind === 'image') reply.header('Content-Security-Policy', 'sandbox')
      return reply.send(createReadStream(real))
    }
    if (r.kind === 'binary') {
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      reply.header('Content-Security-Policy', 'sandbox') // defesa em profundidade (já é attachment)
      return reply.send(createReadStream(real))
    }
    // text/markdown/code: lê com teto
    if ((r.size ?? 0) > TEXT_CAP) return reply.code(413).send({ error: 'file too large' })
    const buf = await readFile(real)
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    reply.header('Content-Security-Policy', 'sandbox')
    // A identidade do que está sendo lido. Quem for editar devolve este valor
    // na gravação; se o disco tiver mudado no meio, o servidor recusa em vez de
    // apagar o que o agente escreveu.
    reply.header('X-Content-Hash', hashContent(buf))
    return reply.send(buf)
  })

  /**
   * Emite a URL da prévia RENDERIZADA de um HTML (o "ver a página", ao lado do
   * "ver o fonte"). Autorização idêntica à da rota de conteúdo — o token não dá
   * acesso novo a ninguém, só transporta o que o requisitante já tinha para um
   * contexto onde o cookie não chega.
   */
  app.post('/api/files/preview', async (req, reply) => {
    const body = req.body as { path?: unknown; projectId?: number }
    const raw = typeof body?.path === 'string' ? body.path : ''
    if (!raw) return reply.code(400).send({ error: 'path required' })
    const project = projectFor(req, deps.projects, body?.projectId)
    const r = resolveInScope(raw, project, isAdminReq(req))
    if (!r.exists) return reply.code(404).send({ error: 'not found' })
    if (!r.inScope) return reply.code(403).send({ error: 'forbidden' })
    const real = r.real!
    // Só HTML: é o único tipo que precisa de documento próprio para ser visto, e
    // cada extensão a mais aqui alarga uma rota que responde sem cookie.
    if (!isHtmlFile(real)) return reply.code(415).send({ error: 'not html' })
    return { url: previewUrl(previews.issue(previewRoot(real, project), req.socket.remoteAddress, req.accessAllowed), real) }
  })

  /**
   * Serve a página e tudo que ela puxa. Pública de propósito (ver files/preview.ts):
   * quem autoriza é o token do caminho, porque o iframe sandbox não manda cookie.
   */
  app.get('/api/files/preview/:token/*', async (req, reply) => {
    const p = req.params as Record<string, string>
    // 404 para tudo — token inválido, fora da raiz, diretório: nada aqui deve
    // servir de oráculo sobre o que existe no disco do servidor.
    const semNada = () => reply.code(404).send({ error: 'not found' })
    const grant = previews.resolve(p.token, req.socket.remoteAddress)
    if (!grant) return semNada()
    const pedido = pathFromPreviewUrl(p['*'] ?? '')
    if (!pedido) return semNada()
    let real: string
    let st: ReturnType<typeof statSync>
    try { real = realpathSync(pedido); st = statSync(real) } catch { return semNada() }
    if (!st.isFile()) return semNada()
    if (real !== grant.root && !real.startsWith(grant.root + sep)) return semNada()

    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Cache-Control', 'no-store')
    if (isHtmlFile(real)) {
      reply.header('Content-Type', 'text/html; charset=utf-8')
      reply.header('Content-Security-Policy', previewCsp(req.headers.host))
      // O app inteiro responde DENY; aqui o visualizador PRECISA embutir.
      reply.header('X-Frame-Options', 'SAMEORIGIN')
    } else {
      reply.header('Content-Type', PREVIEW_MIME[extname(real).toLowerCase()] ?? 'application/octet-stream')
      reply.header('Content-Security-Policy', 'sandbox')
    }
    return reply.send(createReadStream(real))
  })
}
