import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { createSessionManager } from '../src/claude/manager.js'

/**
 * Rotas do acompanhamento de tarefas longas: o Hermes publica
 * (POST /api/hermes/progress), a coluna lê e descarta
 * (GET/DELETE /api/projects/:id/progress), e cada mudança vai às telas.
 */
const estado = {
  title: 'Três páginas do site',
  now: { title: 'Fazendo encomendas.html' },
  tasks: [{ name: 'cardapio.html', status: 'done' }, { name: 'encomendas.html', status: 'in_progress' }],
  waiting: [],
}

let app: Awaited<ReturnType<typeof buildApp>>
let db: Db
let projectId: number
let broadcasts: any[]
let dir: string

beforeEach(async () => {
  db = openDb(':memory:')
  broadcasts = []
  dir = join(mkdtempSync(join(tmpdir(), 'acomp-rotas-')), 'acompanhamento')
  const manager = createSessionManager({ db, broadcast: () => {} })
  app = await buildApp({
    config: loadConfig({ CLAUDINEI_PROGRESS: dir }), db, manager,
    wsHub: { broadcast: (m: object) => broadcasts.push(m), register: () => {} } as never,
  })
  projectId = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Padaria', path: mkdtempSync(join(tmpdir(), 'pad-')) } })).json().id
})

const publicar = (state: unknown, engine = 'claude', pid = projectId) =>
  app.inject({ method: 'POST', url: '/api/hermes/progress', payload: { projectId: pid, engine, state } })
const progressos = () => broadcasts.filter((b) => b.type === 'progress')

describe('rotas do acompanhamento', () => {
  it('POST grava, devolve o estado e transmite', async () => {
    const res = await publicar(estado)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ title: 'Três páginas do site', updatedAt: expect.any(String) })
    expect(progressos()).toEqual([{ type: 'progress', projectId, engine: 'claude', progress: res.json() }])
  })

  it('POST inválido: 400 com o campo, e o estado anterior fica', async () => {
    await publicar(estado)
    const res = await publicar({ ...estado, tasks: [{ name: 'x', status: 'feito' }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('tasks[0].status')
    const atual = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/progress?engine=claude` })
    expect(atual.json().progress.title).toBe('Três páginas do site')
    expect(progressos()).toHaveLength(1)
  })

  it('GET devolve o estado e o caminho do arquivo', async () => {
    await publicar(estado, 'codex')
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/progress?engine=codex` })
    expect(res.statusCode).toBe(200)
    expect(res.json().progress.now.title).toBe('Fazendo encomendas.html')
    expect(res.json().path).toBe(join(dir, `${projectId}-codex.json`))
  })

  it('GET de terminal sem acompanhamento: progress null', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/progress?engine=claude` })
    expect(res.statusCode).toBe(200)
    expect(res.json().progress).toBeNull()
  })

  it('DELETE apaga e transmite null', async () => {
    await publicar(estado)
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/progress?engine=claude` })
    expect(res.statusCode).toBe(204)
    expect(progressos().at(-1)).toEqual({ type: 'progress', projectId, engine: 'claude', progress: null })
    const atual = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/progress?engine=claude` })
    expect(atual.json().progress).toBeNull()
  })

  it('projeto inexistente: 404', async () => {
    expect((await publicar(estado, 'claude', 999)).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/projects/999/progress?engine=claude' })).statusCode).toBe(404)
  })

  it('engine com caminho: 400', async () => {
    expect((await publicar(estado, '../x')).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/projects/${projectId}/progress?engine=a%2Fb` })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/projects/${projectId}/progress` })).statusCode).toBe(400)
  })
})
