import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService, type Project } from '../src/projects.js'
import { createMuralService } from '../src/mural.js'
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

describe('board service', () => {
  it('publish grava e retorna o id gerado', () => {
    const svc = createMuralService(db)
    const { id } = svc.publish(p1.id, 'Título', 'Conteúdo')
    expect(id).toBeGreaterThan(0)
  })

  it('list retorna posts mais novos primeiro, com o nome do projeto', () => {
    const svc = createMuralService(db)
    svc.publish(p1.id, 'Primeiro', 'conteúdo 1')
    svc.publish(p2.id, 'Segundo', 'conteúdo 2')
    const list = svc.list()
    expect(list).toHaveLength(2)
    expect(list[0].title).toBe('Segundo')
    expect(list[0].projectName).toBe('Beta')
    expect(list[0].projectId).toBe(p2.id)
    expect(list[1].title).toBe('Primeiro')
    expect(list[1].projectName).toBe('Alpha')
    expect(typeof list[0].createdAt).toBe('string')
  })

  it('list respeita o limit', () => {
    const svc = createMuralService(db)
    for (let i = 0; i < 5; i++) svc.publish(p1.id, `t${i}`, `c${i}`)
    expect(svc.list(2)).toHaveLength(2)
  })
})
