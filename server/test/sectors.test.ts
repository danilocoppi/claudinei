import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createGroupsService } from '../src/groups.js'
import { createProjectsService } from '../src/projects.js'

let db: Db
let svc: ReturnType<typeof createGroupsService>
let projects: ReturnType<typeof createProjectsService>

// projects.create valida que a pasta existe — cada terminal ganha um dir real.
const proj = (name: string) => projects.create({ name, path: mkdtempSync(join(tmpdir(), `sec-${name}-`)) }).id
const rowOf = (id: number) => db.prepare('SELECT group_id, sector_id, sort_order FROM projects WHERE id=?').get(id) as any
const groupRow = (id: number) => db.prepare('SELECT sector_id, sort_order FROM project_groups WHERE id=?').get(id) as any

beforeEach(() => {
  db = openDb(':memory:')
  svc = createGroupsService(db)
  projects = createProjectsService(db)
})

describe('CRUD de setor', () => {
  it('cria, lista e atualiza como o grupo', () => {
    const s = svc.createSector('Trading')
    expect(s.name).toBe('Trading')
    expect(svc.listSectors().map((x) => x.name)).toEqual(['Trading'])
    svc.updateSector(s.id, { name: 'Trading BR', icon: '📈', color: '#fff' })
    expect(svc.listSectors()[0]).toMatchObject({ name: 'Trading BR', icon: '📈' })
  })

  /** Espelha o remove() de grupo: apagar contêiner nunca apaga conteúdo. */
  it('apagar setor promove grupos e terminais à raiz', () => {
    const s = svc.createSector('Trading')
    const g = svc.create('Backend')
    const p = proj('solto')
    svc.setGroupSector(g.id, s.id)
    svc.setProjectSector(p, s.id)

    svc.removeSector(s.id)

    expect(svc.list().map((x) => x.id)).toContain(g.id)   // grupo continua existindo
    expect(groupRow(g.id).sector_id).toBeNull()
    expect(rowOf(p).sector_id).toBeNull()
  })
})

describe('pertencimento único (group_id XOR sector_id)', () => {
  it('mover para grupo limpa o setor', () => {
    const s = svc.createSector('S'); const g = svc.create('G'); const p = proj('p')
    svc.setProjectSector(p, s.id)
    svc.setProjectGroup(p, g.id)
    expect(rowOf(p)).toMatchObject({ group_id: g.id, sector_id: null })
  })

  it('mover para setor limpa o grupo', () => {
    const s = svc.createSector('S'); const g = svc.create('G'); const p = proj('p')
    svc.setProjectGroup(p, g.id)
    svc.setProjectSector(p, s.id)
    expect(rowOf(p)).toMatchObject({ group_id: null, sector_id: s.id })
  })

  it('mover para setor inexistente falha', () => {
    const p = proj('p')
    expect(() => svc.setProjectSector(p, 999)).toThrow(/setor/)
  })
})

/**
 * Apagar um grupo que vive num setor NÃO pode jogar os terminais na raiz: o
 * operador perderia o setor que acabou de montar.
 */
describe('apagar grupo dentro de setor', () => {
  it('os terminais ficam no setor', () => {
    const s = svc.createSector('S'); const g = svc.create('G'); const p = proj('p')
    svc.setGroupSector(g.id, s.id)
    svc.setProjectGroup(p, g.id)

    svc.remove(g.id)

    expect(rowOf(p)).toMatchObject({ group_id: null, sector_id: s.id })
  })

  it('grupo na raiz continua soltando os terminais na raiz', () => {
    const g = svc.create('G'); const p = proj('p')
    svc.setProjectGroup(p, g.id)
    svc.remove(g.id)
    expect(rowOf(p)).toMatchObject({ group_id: null, sector_id: null })
  })
})

describe('applySidebarOrder com três níveis', () => {
  it('grava a árvore inteira: setor > grupo > terminal', () => {
    const s = svc.createSector('S'); const g = svc.create('G')
    const dentroGrupo = proj('a'); const soltoNoSetor = proj('b'); const naRaiz = proj('c')

    svc.applySidebarOrder([
      { kind: 'sector', id: s.id, children: [
        { kind: 'group', id: g.id, children: [dentroGrupo] },
        { kind: 'project', id: soltoNoSetor },
      ] },
      { kind: 'project', id: naRaiz },
    ])

    expect(groupRow(g.id).sector_id).toBe(s.id)
    expect(rowOf(dentroGrupo)).toMatchObject({ group_id: g.id, sector_id: null })
    expect(rowOf(soltoNoSetor)).toMatchObject({ group_id: null, sector_id: s.id })
    expect(rowOf(naRaiz)).toMatchObject({ group_id: null, sector_id: null })
  })

  it('a ordem segue a travessia em profundidade', () => {
    const s = svc.createSector('S'); const g = svc.create('G')
    const p1 = proj('p1'); const p2 = proj('p2')
    svc.applySidebarOrder([
      { kind: 'sector', id: s.id, children: [{ kind: 'group', id: g.id, children: [p1] }] },
      { kind: 'project', id: p2 },
    ])
    const sector = db.prepare('SELECT sort_order FROM sectors WHERE id=?').get(s.id) as any
    expect(sector.sort_order).toBeLessThan(groupRow(g.id).sort_order)
    expect(groupRow(g.id).sort_order).toBeLessThan(rowOf(p1).sort_order)
    expect(rowOf(p1).sort_order).toBeLessThan(rowOf(p2).sort_order)
  })

  it('tirar um grupo do setor limpa o sector_id dele', () => {
    const s = svc.createSector('S'); const g = svc.create('G')
    svc.setGroupSector(g.id, s.id)
    svc.applySidebarOrder([{ kind: 'group', id: g.id, children: [] }])
    expect(groupRow(g.id).sector_id).toBeNull()
  })

  it('estrutura de dois níveis (sem setor) continua funcionando', () => {
    const g = svc.create('G'); const p = proj('p')
    svc.applySidebarOrder([{ kind: 'group', id: g.id, children: [p] }])
    expect(rowOf(p)).toMatchObject({ group_id: g.id, sector_id: null })
  })
})

/**
 * O front monta a árvore a partir de `groups` + `projects`: sem o `sectorId` em
 * cada grupo, ele não tem como saber que um grupo mora dentro de um setor — e o
 * desenharia na raiz, contradizendo a ordem que o backend acabou de gravar.
 */
describe('list() expõe o setor do grupo', () => {
  it('devolve sectorId nulo na raiz e preenchido dentro de um setor', () => {
    const s = svc.createSector('Trading')
    const raiz = svc.create('Raiz')
    const dentro = svc.create('Dentro')
    svc.setGroupSector(dentro.id, s.id)
    const byName = Object.fromEntries(svc.list().map((g) => [g.name, g]))
    expect(byName['Raiz'].sectorId).toBeNull()
    expect(byName['Dentro'].sectorId).toBe(s.id)
  })
})
