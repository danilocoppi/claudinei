import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createPagesService, type PagesService } from '../src/pages/service.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'

/**
 * Retenção das páginas: saem com o turno cortado ("Editar a partir daqui") e
 * com o terminal excluído, acompanham a conversa nova nos turnos que ficam, e a
 * varredura da subida limpa o que sobrou de um lado sem o outro.
 */

let db: Db
let dir: string
let projectId: number
let service: PagesService
let turn: { turnId: number; turnKey: string | null } | undefined
const temps: string[] = []

const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d }
const rowIds = () => (db.prepare('SELECT id FROM visual_pages ORDER BY rowid').all() as { id: string }[]).map((r) => r.id)
const files = (d = dir) => (existsSync(d) ? readdirSync(d).sort() : [])

function serviceOver(pagesDir: string): PagesService {
  return createPagesService({
    db, dir: pagesDir,
    projects: createProjectsService(db),
    liveSession: (pid, engine) => (engine === 'claude' ? { localId: `loc-${pid}`, engineSessionId: 'conv-1' } : undefined),
    openTurn: () => turn,
    broadcast: () => {},
    log: () => {},
  })
}

/** Publica uma página no turno `turnId` do projeto `pid`. */
function publishIn(turnId: number, pid = projectId, svc = service): string {
  turn = { turnId, turnKey: `k${turnId}` }
  return svc.publish({ projectId: pid, engine: 'claude', title: `turno ${turnId}`, html: `<p>${turnId}</p>` }).id
}

beforeEach(() => {
  db = openDb(':memory:')
  dir = join(tmp('pg-ret-'), 'pages')
  projectId = createProjectsService(db).create({ name: 'Alfa', path: tmp('pg-ret-proj-') }).id
  turn = undefined
  service = serviceOver(dir)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('retenção das páginas', () => {
  it('onTurnsRewound apaga arquivo e linha só das páginas desses turnos', () => {
    const a = publishIn(7)
    const b = publishIn(8)
    const c = publishIn(9)
    const d = publishIn(9)
    service.onTurnsRewound([8, 9])
    expect(rowIds()).toEqual([a])
    expect(files()).toEqual([`${a}.html`])
    for (const id of [b, c, d]) expect(existsSync(service.filePath(id))).toBe(false)
    // Turno sem página e lista vazia: nada muda.
    service.onTurnsRewound([42])
    service.onTurnsRewound([])
    expect(rowIds()).toEqual([a])
  })

  it('onTurnsRelabeled passa as páginas dos turnos que ficaram para a conversa nova: a listagem pela conversa nova as traz', () => {
    const a = publishIn(7)
    const b = publishIn(8)
    const c = publishIn(9)
    service.onTurnsRelabeled([7, 8], 'conv-2')
    const local = `loc-${projectId}`
    expect(service.store.listConversation(projectId, 'claude', 'conv-2', local).map((p) => p.id)).toEqual([a, b])
    expect(service.store.listConversation(projectId, 'claude', 'conv-1', local).map((p) => p.id)).toEqual([c])
    // Só o rótulo muda: os arquivos ficam.
    expect(files()).toEqual([a, b, c].map((id) => `${id}.html`).sort())
  })

  it('DELETE /api/projects/:id apaga os arquivos das páginas e a cascata leva as linhas', async () => {
    const pagesDir = join(tmp('pg-ret-app-'), 'pages')
    const manager = createSessionManager({ db, broadcast: () => {} })
    const app = await buildApp({ config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager })
    try {
      const other = createProjectsService(db).create({ name: 'Beta', path: tmp('pg-ret-beta-') }).id
      // O mesmo banco e a mesma pasta do app.
      const svc = serviceOver(pagesDir)
      publishIn(1, projectId, svc)
      publishIn(2, projectId, svc)
      const fica = publishIn(3, other, svc)
      const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` })
      expect(res.statusCode).toBe(204)
      expect(rowIds()).toEqual([fica])
      expect(files(pagesDir)).toEqual([`${fica}.html`])
    } finally {
      await app.close()
    }
  })

  it('DELETE /api/projects/:id: falha ao apagar as páginas vai ao log e o terminal sai mesmo assim', async () => {
    const pagesDir = join(tmp('pg-ret-app-'), 'pages')
    const manager = createSessionManager({ db, broadcast: () => {} })
    const app = await buildApp({ config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Sem a tabela, a busca das páginas do terminal lança.
      db.exec('DROP TABLE visual_pages')
      const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` })
      expect(res.statusCode).toBe(204)
      expect(createProjectsService(db).get(projectId)).toBeUndefined()
      expect(errors.mock.calls.some((c) => String(c[0]).includes(`páginas do terminal ${projectId}`))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('sweep: arquivo sem linha, .tmp esquecido e linha sem arquivo saem; o resto fica', () => {
    const fica = publishIn(1)
    const semArquivo = publishIn(2)
    rmSync(service.filePath(semArquivo))
    const orfao = 'pg_00000000000000aa'
    writeFileSync(join(dir, `${orfao}.html`), '<p>sem linha</p>')
    writeFileSync(join(dir, `${orfao}.html.123.0badcafe.tmp`), '<p>gravação interrompida</p>')
    // O que não é página fica: outro nome, outra extensão, subpasta.
    writeFileSync(join(dir, 'notas.txt'), 'x')
    writeFileSync(join(dir, 'pg_curto.html'), 'x')
    // Só o temporário com o nome do writeAtomic (`<id>.html.<pid>.<8 hex>.tmp`) sai.
    writeFileSync(join(dir, 'pg_qualquer.tmp'), 'x')
    writeFileSync(join(dir, `${orfao}.tmp`), 'x')
    mkdirSync(join(dir, 'sub'))
    expect(service.sweep()).toEqual({ files: 2, rows: 1 })
    expect(rowIds()).toEqual([fica])
    expect(files()).toEqual([`${fica}.html`, `${orfao}.tmp`, 'notas.txt', 'pg_curto.html', 'pg_qualquer.tmp', 'sub'].sort())
    // Segunda passada: nada a fazer.
    expect(service.sweep()).toEqual({ files: 0, rows: 0 })
  })

  it('pasta das páginas ausente: sweep não lança', () => {
    // Nunca publicou: a pasta ainda não existe.
    expect(existsSync(dir)).toBe(false)
    expect(service.sweep()).toEqual({ files: 0, rows: 0 })
    // Com linhas e sem a pasta (desmontada, CLAUDINEI_PAGES trocada), as linhas
    // ficam: sem a pasta não há como distinguir página perdida de pasta errada.
    const id = publishIn(1)
    rmSync(dir, { recursive: true })
    expect(service.sweep()).toEqual({ files: 0, rows: 0 })
    expect(rowIds()).toEqual([id])
  })

  it('buildApp com sweepPages varre a pasta na subida; sem ele, não toca nela', async () => {
    const pagesDir = join(tmp('pg-ret-boot-'), 'pages')
    mkdirSync(pagesDir, { recursive: true })
    const orfao = join(pagesDir, 'pg_00000000000000bb.html')
    writeFileSync(orfao, 'x')
    const manager = createSessionManager({ db, broadcast: () => {} })
    // Sem o sinal (testes, ensaio com outro banco): a pasta não é varrida.
    const quieto = await buildApp({ config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager })
    await quieto.close()
    expect(existsSync(orfao)).toBe(true)
    // O log da varredura vai ao console.error: confere a linha e não suja a saída.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = await buildApp({ config: loadConfig({ CLAUDINEI_PAGES: pagesDir }), db, manager, sweepPages: true })
    await app.close()
    expect(existsSync(orfao)).toBe(false)
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain('[páginas] varredura: 1 arquivo(s) e 0 linha(s) órfãos apagados')
  })
})
