import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createTasksService } from '../src/tasks.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: Db
let p1: Project
let p2: Project

beforeEach(() => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alpha', path: mkdtempSync(join(tmpdir(), 'tm-')) })
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'tm-')) })
})

describe('tasks service', () => {
  it('create sem status explícito grava como queued (default) e retorna o id gerado', () => {
    const svc = createTasksService(db)
    const { id } = svc.create(p1.id, p2.id, 'faça algo')
    expect(id).toBeGreaterThan(0)
    const [task] = svc.list()
    expect(task.status).toBe('queued')
    expect(task.result).toBeNull()
  })

  it('create com status explícito grava o status pedido (ex.: in_progress na entrega imediata)', () => {
    const svc = createTasksService(db)
    const { id } = svc.create(p1.id, p2.id, 'faça algo', 'in_progress')
    expect(id).toBeGreaterThan(0)
    const [task] = svc.list()
    expect(task.status).toBe('in_progress')
  })

  it('create aceita fromProjectId nulo (despacho sem origem conhecida)', () => {
    const svc = createTasksService(db)
    const { id } = svc.create(null, p2.id, 'faça algo')
    expect(id).toBeGreaterThan(0)
    const [task] = svc.list()
    expect(task.fromProjectId).toBeNull()
    expect(task.fromProjectName).toBeNull()
  })

  it('setResult atualiza status e result', () => {
    const svc = createTasksService(db)
    const { id } = svc.create(p1.id, p2.id, 'faça algo')
    svc.setResult(id, 'completed', 'feito!')
    const [task] = svc.list()
    expect(task.status).toBe('completed')
    expect(task.result).toBe('feito!')
  })

  it('setResult aceita status failed', () => {
    const svc = createTasksService(db)
    const { id } = svc.create(p1.id, p2.id, 'faça algo')
    svc.setResult(id, 'failed', 'deu erro')
    const [task] = svc.list()
    expect(task.status).toBe('failed')
    expect(task.result).toBe('deu erro')
  })

  it('list retorna as tarefas mais novas primeiro, com nomes dos projetos', () => {
    const svc = createTasksService(db)
    svc.create(p1.id, p2.id, 'primeira')
    svc.create(p2.id, p1.id, 'segunda')
    const list = svc.list()
    expect(list).toHaveLength(2)
    expect(list[0].description).toBe('segunda')
    expect(list[0].fromProjectName).toBe('Beta')
    expect(list[0].toProjectName).toBe('Alpha')
    expect(list[1].description).toBe('primeira')
    expect(list[1].fromProjectName).toBe('Alpha')
    expect(list[1].toProjectName).toBe('Beta')
    expect(typeof list[0].createdAt).toBe('string')
    expect(typeof list[0].updatedAt).toBe('string')
  })

  it('list respeita o limit', () => {
    const svc = createTasksService(db)
    for (let i = 0; i < 5; i++) svc.create(p1.id, p2.id, `t${i}`)
    expect(svc.list(2)).toHaveLength(2)
  })

  describe('nextQueued / markInProgress', () => {
    it('nextQueued retorna undefined quando não há queued para o projeto', () => {
      const svc = createTasksService(db)
      svc.create(p1.id, p2.id, 'em progresso', 'in_progress')
      expect(svc.nextQueued(p2.id)).toBeUndefined()
    })

    it('nextQueued retorna a mais antiga (FIFO) entre várias queued do mesmo alvo', () => {
      const svc = createTasksService(db)
      const first = svc.create(p1.id, p2.id, 'primeira')
      svc.create(p1.id, p2.id, 'segunda')
      const next = svc.nextQueued(p2.id)
      expect(next?.id).toBe(first.id)
      expect(next?.description).toBe('primeira')
      expect(next?.status).toBe('queued')
    })

    it('nextQueued ignora queued de outro projeto alvo', () => {
      const svc = createTasksService(db)
      svc.create(p1.id, p2.id, 'para beta')
      expect(svc.nextQueued(p1.id)).toBeUndefined()
    })

    it('markInProgress promove o status e não afeta outras tarefas', () => {
      const svc = createTasksService(db)
      const { id } = svc.create(p1.id, p2.id, 'primeira')
      const { id: id2 } = svc.create(p1.id, p2.id, 'segunda')
      svc.markInProgress(id)
      expect(svc.get(id)?.status).toBe('in_progress')
      expect(svc.get(id2)?.status).toBe('queued')
      // a promovida não é mais retornada por nextQueued; a próxima passa a ser a segunda
      expect(svc.nextQueued(p2.id)?.id).toBe(id2)
    })
  })
})

describe('engine de quem despachou/executou (colaboração entre engines do mesmo projeto)', () => {
  it('create grava fromEngine; setToEngine grava a executora; ambos voltam em list/get', () => {
    const svc = createTasksService(db)
    const { id } = svc.create(p1.id, p2.id, 'tarefa', 'queued', 'claude')
    expect(svc.get(id)?.fromEngine).toBe('claude')
    expect(svc.get(id)?.toEngine).toBeNull()
    svc.setToEngine(id, 'codex')
    const task = svc.get(id)!
    expect(task.fromEngine).toBe('claude')
    expect(task.toEngine).toBe('codex')
    expect(svc.list()[0]).toMatchObject({ fromEngine: 'claude', toEngine: 'codex' })
  })

  it('create sem fromEngine → null (operador/desconhecida)', () => {
    const svc = createTasksService(db)
    const { id } = svc.create(null, p2.id, 'tarefa')
    expect(svc.get(id)?.fromEngine).toBeNull()
  })
})
