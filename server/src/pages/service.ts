import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { Db } from '../db.js'
import { resolveInScope } from '../files/scope.js'
import { UserError } from '../user-error.js'
import type { VisualPageDto } from '../../../shared/visual-pages.js'
import { embedLocalResources } from './embed.js'
import { createPagesStore } from './store.js'

export { registerPageRoutes } from './routes.js'

/**
 * Publicar uma página: valida a entrada do `show_page`, monta o documento
 * (lido do `path` ou o `html` recebido, com os recursos locais embutidos),
 * aplica o teto, grava o arquivo, a linha e avisa a tela.
 *
 * O Hermes só conhece projeto + motor: a conversa e o turno saem da sessão viva
 * desse terminal (`liveSession`) e do trecho aberto do desfazer (`openTurn`).
 */

/** Teto do `html` recebido, em caracteres (o mesmo do esquema do `show_page`). */
export const PAGE_HTML_MAX_CHARS = 524_288
/** Teto do documento final, depois de embutir, em bytes UTF-8. */
export const PAGE_MAX_BYTES = 524_288

const TITLE_MAX = 120
const HEIGHT_MIN = 120
const HEIGHT_MAX = 2000
/** Quantas referências o aviso cita pelo nome. */
const WARN_REFS = 10
const ID_RE = /^pg_[0-9a-f]{16}$/
/** O arquivo de uma página, na pasta das páginas. */
const PAGE_FILE_RE = /^(pg_[0-9a-f]{16})\.html$/
/** O temporário do `writeAtomic` que uma gravação interrompida deixou: `<id>.html.<pid>.<8 hex>.tmp`. */
const TEMP_FILE_RE = /^pg_[0-9a-f]{16}\.html\.\d+\.[0-9a-f]{8}\.tmp$/

export interface PageSourceInput { html?: unknown; path?: unknown }
export interface PublishInput extends PageSourceInput { projectId: number; engine: string; title?: unknown; height?: unknown }
export interface PagesDeps {
  db: Db
  dir: string
  projects: { get(id: number): { id: number; path: string } | undefined }
  liveSession(projectId: number, engine: string): { localId: string; engineSessionId: string | null } | undefined
  openTurn(localId: string): { turnId: number; turnKey: string | null } | undefined
  broadcast(msg: object): void
  log?: (m: string) => void
}

/** KB para mensagem: nunca "0 KB". */
const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024))
const given = (v: unknown) => v !== undefined && v !== null

export function createPagesService(deps: PagesDeps) {
  const store = createPagesStore(deps.db)
  const log = deps.log ?? ((m: string) => console.error(`[páginas] ${m}`))

  function filePath(id: string): string {
    // O id vira nome de arquivo: só o formato gerado aqui, nada de `../`.
    if (!ID_RE.test(id)) throw new Error(`id de página inválido: ${id}`)
    return join(deps.dir, `${id}.html`)
  }

  /** Lê o `.html`/`.htm` do projeto; devolve o texto e o caminho real. */
  function readSource(project: { id: number; path: string }, raw: unknown): { html: string; real: string } {
    if (typeof raw !== 'string' || !raw.trim()) throw new UserError('page_path', 'path must be a non-empty string')
    const ext = extname(raw.trim()).toLowerCase()
    if (ext !== '.html' && ext !== '.htm') throw new UserError('page_path', `path must be an .html or .htm file: ${raw}`)
    // Sem privilégio de admin: só o que, depois do realpath, fica dentro do projeto.
    const scope = resolveInScope(raw, project, false)
    if (!scope.inScope || !scope.real) throw new UserError('page_path', `path not found inside the project: ${raw}`)
    const realExt = extname(scope.real).toLowerCase()
    if (realExt !== '.html' && realExt !== '.htm') throw new UserError('page_path', `path must be an .html or .htm file: ${raw}`)
    // Maior que o teto nem se lê: embutir só faria crescer.
    if ((scope.size ?? 0) > PAGE_MAX_BYTES) {
      throw new UserError('page_too_large', `file is ${kb(scope.size!)} KB, over the 512 KB limit`)
    }
    return { html: readFileSync(scope.real, 'utf8'), real: scope.real }
  }

  function buildDocument(projectId: number, src: PageSourceInput) {
    const project = deps.projects.get(projectId)
    if (!project) throw new UserError('project_not_found', 'project does not exist')
    if (given(src.html) === given(src.path)) throw new UserError('page_source', 'pass exactly one of html and path')

    let html: string
    let baseDir: string
    let sourcePath: string | null = null
    if (given(src.html)) {
      if (typeof src.html !== 'string') throw new UserError('page_source', 'html must be a string')
      if (src.html.length > PAGE_HTML_MAX_CHARS) {
        throw new UserError('page_too_large', `html has ${src.html.length} characters, over the ${PAGE_HTML_MAX_CHARS} limit`)
      }
      html = src.html
      baseDir = project.path
    } else {
      const read = readSource(project, src.path)
      html = read.html
      sourcePath = read.real
      baseDir = dirname(read.real)
    }

    const out = embedLocalResources(html, { baseDir, projectRoot: project.path })
    // O documento final, e não a soma de `embedded`: o CSS conta as imagens que
    // embutiu e elas aparecem de novo como itens próprios.
    const bytes = Buffer.byteLength(out.html, 'utf8')
    if (bytes > PAGE_MAX_BYTES) {
      const byRef = new Map<string, number>()
      for (const e of out.embedded) byRef.set(e.ref, Math.max(byRef.get(e.ref) ?? 0, e.bytes))
      const largest = [...byRef].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ref, b]) => `${ref} ${kb(b)} KB`)
      // Arredonda para cima: 512,001 KB não pode sair como "512 KB, over the 512 KB limit".
      const msg = `page is ${Math.ceil(bytes / 1024)} KB after embedding, over the 512 KB limit`
      throw new UserError('page_too_large', largest.length ? `${msg}; largest resources: ${largest.join(', ')}` : msg)
    }

    const missing = [...new Set(out.missing)]
    const n = missing.length
    const warnings = n
      ? [`${n} local reference${n === 1 ? '' : 's'} not embedded: ${missing.slice(0, WARN_REFS).join(', ')}`]
      : []
    return { html: out.html, bytes, source: (sourcePath ? 'path' : 'html') as 'html' | 'path', sourcePath, warnings }
  }

  /** Grava atômico: temporário na mesma pasta e `rename`. Sem sobra se falhar. */
  function writeAtomic(target: string, html: string): void {
    mkdirSync(deps.dir, { recursive: true })
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, html)
      renameSync(tmp, target)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  }

  function publish(input: PublishInput): { id: string; bytes: number; warnings: string[] } {
    const { title, height } = input
    if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) {
      throw new UserError('page_title', `title must have 1 to ${TITLE_MAX} characters`)
    }
    if (given(height) && !(Number.isInteger(height) && (height as number) >= HEIGHT_MIN && (height as number) <= HEIGHT_MAX)) {
      throw new UserError('page_height', `height must be an integer from ${HEIGHT_MIN} to ${HEIGHT_MAX}`)
    }
    const doc = buildDocument(input.projectId, input)

    const session = deps.liveSession(input.projectId, input.engine)
    if (!session) throw new UserError('no_live_session', 'no live session in this terminal; open it in Claudinei first')
    const turn = deps.openTurn(session.localId)

    const id = `pg_${randomBytes(8).toString('hex')}`
    const target = filePath(id)
    writeAtomic(target, doc.html)
    let page: VisualPageDto
    try {
      page = store.insert({
        id, projectId: input.projectId, engine: input.engine, localId: session.localId,
        conversationId: session.engineSessionId, turnId: turn?.turnId ?? null, turnKey: turn?.turnKey ?? null,
        title, height: given(height) ? (height as number) : null, bytes: doc.bytes,
        source: doc.source, sourcePath: doc.sourcePath,
      })
    } catch (e) {
      // Sem linha, o arquivo seria órfão: sai junto.
      rmSync(target, { force: true })
      throw e
    }
    log(`página ${id} publicada em ${session.localId} (${doc.bytes} bytes)`)
    deps.broadcast({ type: 'visual_page', projectId: input.projectId, engine: input.engine, localId: session.localId, page })
    return { id, bytes: doc.bytes, warnings: doc.warnings }
  }

  /** Apaga os arquivos dessas páginas; o que falhar vai ao log (a varredura da subida pega depois). */
  function removeFiles(ids: string[]): void {
    for (const id of ids) {
      try {
        rmSync(filePath(id), { force: true })
      } catch (e) {
        log(`apagar o arquivo da página ${id}: ${(e as Error).message}`)
      }
    }
  }

  /** "Editar a partir daqui" cortou esses turnos: as páginas deles saem (linha antes, arquivo depois). */
  function onTurnsRewound(turnIds: number[]): void {
    const ids = store.idsOfTurns(turnIds)
    if (!ids.length) return
    store.remove(ids)
    removeFiles(ids)
    log(`${ids.length} página(s) saíram com o trecho cortado`)
  }

  /** Os turnos que ficaram passaram à conversa nova (Claude: id novo; Codex: fork): as páginas vão junto. */
  function onTurnsRelabeled(turnIds: number[], conversationId: string): void {
    store.moveTurns(turnIds, conversationId)
  }

  /** O terminal vai ser excluído: os arquivos saem aqui; as linhas, pela cascata do `DELETE` do projeto. */
  function removeProject(projectId: number): void {
    removeFiles(store.idsOfProject(projectId))
  }

  /**
   * Subida: apaga o arquivo de página sem linha, o temporário esquecido e a
   * linha sem arquivo. Outros nomes na pasta ficam. Sem a pasta, nada sai: não
   * há como distinguir página perdida de pasta desmontada ou trocada.
   */
  function sweep(): { files: number; rows: number } {
    if (!existsSync(deps.dir)) return { files: 0, rows: 0 }
    const known = new Set(store.allIds())
    let files = 0
    for (const entry of readdirSync(deps.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const page = PAGE_FILE_RE.exec(entry.name)
      if (page ? known.has(page[1]) : !TEMP_FILE_RE.test(entry.name)) continue
      try {
        rmSync(join(deps.dir, entry.name), { force: true })
        files++
      } catch (e) {
        log(`varredura: apagar ${entry.name}: ${(e as Error).message}`)
      }
    }
    const lost = [...known].filter((id) => !existsSync(filePath(id)))
    store.remove(lost)
    if (files || lost.length) log(`varredura: ${files} arquivo(s) e ${lost.length} linha(s) órfãos apagados`)
    return { files, rows: lost.length }
  }

  return {
    buildDocument,
    publish,
    onTurnsRewound,
    onTurnsRelabeled,
    removeProject,
    sweep,
    get: (id: string): VisualPageDto | undefined => store.get(id),
    filePath,
    store,
  }
}

export type PagesService = ReturnType<typeof createPagesService>
