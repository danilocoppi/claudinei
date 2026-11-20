import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createAuthService } from '../src/auth/index.js'
import { createTriageStore, migrateFavoritesToPins } from '../src/triage/store.js'

const daqui = (ms: number) => new Date(Date.now() + ms).toISOString()
const HORA = 3600_000

let db: Db
let p1: number
let p2: number

beforeEach(() => {
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  p1 = projects.create({ name: 'Alfa', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
  p2 = projects.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
})

afterEach(() => { db.close() })

describe('store da triagem', () => {
  it('sem linha, nada aplicado', () => {
    const store = createTriageStore(db)
    expect(store.get(1, p1)).toEqual({ projectId: p1, pinned: false, settled: false, snoozedUntil: null })
    expect(store.list(1)).toEqual([])
  })

  it('assentar tira o pin e o adiamento', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { pinned: true, snoozedUntil: daqui(HORA) })
    expect(store.update(1, p1, { settled: true })).toEqual({ projectId: p1, pinned: false, settled: true, snoozedUntil: null })
    expect(store.get(1, p1)).toEqual({ projectId: p1, pinned: false, settled: true, snoozedUntil: null })
  })

  it('adiar tira o assentado e mantém o pin', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { pinned: true })
    store.update(1, p2, { settled: true })
    const ate = daqui(HORA)
    expect(store.update(1, p1, { snoozedUntil: ate })).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: ate })
    expect(store.update(1, p2, { snoozedUntil: ate })).toEqual({ projectId: p2, pinned: false, settled: false, snoozedUntil: ate })
  })

  it('fixar tira o assentado', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { settled: true })
    expect(store.update(1, p1, { pinned: true })).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: null })
  })

  it('snoozedUntil vencido é lido como null', () => {
    const store = createTriageStore(db)
    db.prepare(`INSERT INTO user_triage (user_id, project_id, snoozed_until) VALUES (1, ?, ?)`).run(p1, daqui(-1000))
    expect(store.get(1, p1).snoozedUntil).toBeNull()
    // Vencido e sem mais nada: não há o que mostrar.
    expect(store.list(1)).toEqual([])
  })

  it('cada usuário tem a sua triagem', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { pinned: true })
    expect(store.list(1)).toEqual([{ projectId: p1, pinned: true, settled: false, snoozedUntil: null }])
    expect(store.list(2)).toEqual([])
    expect(store.get(2, p1).pinned).toBe(false)
  })

  it('wakeProject limpa settled e snoozed de todos os usuários, mantém o pin e devolve os afetados', () => {
    const store = createTriageStore(db)
    const ate = daqui(HORA)
    store.update(1, p1, { settled: true })
    store.update(2, p1, { pinned: true, snoozedUntil: ate })
    store.update(3, p1, { pinned: true })          // nada a acordar
    store.update(1, p2, { settled: true })          // outro projeto: fica

    expect(store.wakeProject(p1).sort()).toEqual([1, 2])
    expect(store.get(1, p1)).toEqual({ projectId: p1, pinned: false, settled: false, snoozedUntil: null })
    expect(store.get(2, p1)).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: null })
    expect(store.get(3, p1)).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: null })
    expect(store.get(1, p2).settled).toBe(true)
    // Já acordado: chamar de novo não afeta ninguém.
    expect(store.wakeProject(p1)).toEqual([])
  })

  it('wakeProject não conta como afetado quem só tinha um adiamento vencido', () => {
    const store = createTriageStore(db)
    db.prepare(`INSERT INTO user_triage (user_id, project_id, snoozed_until) VALUES (1, ?, ?)`).run(p1, daqui(-1000))
    expect(store.wakeProject(p1)).toEqual([])
  })

  it('apagar o projeto apaga a triagem', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { pinned: true })
    createProjectsService(db).remove(p1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_triage').get() as { n: number }).n).toBe(0)
  })

  it('apagar o usuário apaga a triagem dele', () => {
    const auth = createAuthService({ db })
    auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true })
    const ana = auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [p1] })
    const store = createTriageStore(db)
    store.update(ana.id, p1, { pinned: true })
    auth.users.remove(ana.id)
    expect(store.list(ana.id)).toEqual([])
  })
})

describe('migração da ⭐ para pin', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tri-db-'))
    path = join(dir, 'c.db')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /**
   * Monta um banco "de antes da triagem": favoritos marcados e a chave da
   * migração ausente, como numa instalação que ainda não passou por ela.
   */
  const bancoAntigo = () => {
    const d = openDb(path)
    const projects = createProjectsService(d)
    const a = projects.create({ name: 'A', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
    const b = projects.create({ name: 'B', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
    const c = projects.create({ name: 'C', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
    projects.setFavorite(a, true)
    projects.setFavorite(b, true)
    const auth = createAuthService({ db: d })
    const root = auth.users.create({ username: 'root', password: 'abcd1234', isAdmin: true }).id
    const ana = auth.users.create({ username: 'ana', password: 'abcd1234', projectIds: [a, c] }).id
    const bia = auth.users.create({ username: 'bia', password: 'abcd1234', projectIds: [c] }).id
    d.prepare(`DELETE FROM settings WHERE key='triage_favorites_migrated'`).run()
    d.close()
    return { a, b, c, root, ana, bia }
  }

  const fixados = (d: Db, userId: number) =>
    createTriageStore(d).list(userId).filter((t) => t.pinned).map((t) => t.projectId).sort()

  it('migração: favorite=1 vira pin para admin, para o usuário 0 e para quem tem acesso; quem não tem acesso não ganha', () => {
    const { a, b, root, ana, bia } = bancoAntigo()
    const d = openDb(path)  // a migração roda na abertura, junto das outras
    try {
      expect(fixados(d, root)).toEqual([a, b])
      expect(fixados(d, 0)).toEqual([a, b])
      expect(fixados(d, ana)).toEqual([a])
      expect(fixados(d, bia)).toEqual([])
    } finally { d.close() }
  })

  it('migração roda uma vez só', () => {
    const { a, root } = bancoAntigo()
    let d = openDb(path)
    createTriageStore(d).update(root, a, { pinned: false })
    d.close()
    d = openDb(path)
    try {
      expect(createTriageStore(d).get(root, a).pinned).toBe(false)
      // Chamada direta também respeita a marca.
      migrateFavoritesToPins(d)
      expect(createTriageStore(d).get(root, a).pinned).toBe(false)
    } finally { d.close() }
  })
})
