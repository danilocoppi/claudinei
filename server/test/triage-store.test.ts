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
    expect(store.get(1, p1)).toEqual({ projectId: p1, pinned: false, settled: false, snoozedUntil: null, pinOrder: null })
    expect(store.list(1)).toEqual([])
  })

  it('assentar tira o pin e o adiamento', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { pinned: true, snoozedUntil: daqui(HORA) })
    expect(store.update(1, p1, { settled: true })).toEqual({ projectId: p1, pinned: false, settled: true, snoozedUntil: null, pinOrder: null })
    expect(store.get(1, p1)).toEqual({ projectId: p1, pinned: false, settled: true, snoozedUntil: null, pinOrder: null })
  })

  it('adiar tira o assentado e mantém o pin', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { pinned: true })
    store.update(1, p2, { settled: true })
    const ate = daqui(HORA)
    expect(store.update(1, p1, { snoozedUntil: ate })).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: ate, pinOrder: 0 })
    expect(store.update(1, p2, { snoozedUntil: ate })).toEqual({ projectId: p2, pinned: false, settled: false, snoozedUntil: ate, pinOrder: null })
  })

  it('fixar tira o assentado', () => {
    const store = createTriageStore(db)
    store.update(1, p1, { settled: true })
    expect(store.update(1, p1, { pinned: true })).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 })
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
    expect(store.list(1)).toEqual([{ projectId: p1, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 }])
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
    expect(store.get(1, p1)).toEqual({ projectId: p1, pinned: false, settled: false, snoozedUntil: null, pinOrder: null })
    expect(store.get(2, p1)).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 })
    expect(store.get(3, p1)).toEqual({ projectId: p1, pinned: true, settled: false, snoozedUntil: null, pinOrder: 0 })
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

describe('ordem dos fixados', () => {
  let p3: number
  beforeEach(() => { p3 = createProjectsService(db).create({ name: 'Gama', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id })

  it('fixar põe no fim; desafixar ou assentar esquece a posição', () => {
    const store = createTriageStore(db)
    expect(store.update(1, p1, { pinned: true }).pinOrder).toBe(0)
    expect(store.update(1, p2, { pinned: true }).pinOrder).toBe(1)
    // Fixar de novo quem já está fixado não o move.
    expect(store.update(1, p1, { pinned: true }).pinOrder).toBe(0)
    // Adiar mantém o pin e a posição.
    expect(store.update(1, p1, { snoozedUntil: daqui(HORA) }).pinOrder).toBe(0)
    expect(store.update(1, p1, { pinned: false }).pinOrder).toBeNull()
    expect(store.update(1, p1, { pinned: true }).pinOrder).toBe(2)
    expect(store.update(1, p1, { settled: true }).pinOrder).toBeNull()
    // Sem pin, não há posição a mostrar.
    expect(store.get(1, p3).pinOrder).toBeNull()
  })

  it('fixar de novo com pinOrder (o desfazer) volta à posição de antes', () => {
    const store = createTriageStore(db)
    for (const p of [p1, p2, p3]) store.update(1, p, { pinned: true })
    store.update(1, p2, { pinned: false })
    expect(store.update(1, p2, { pinned: true, pinOrder: 1 }).pinOrder).toBe(1)
    store.update(1, p2, { settled: true })
    expect(store.update(1, p2, { pinned: true, settled: false, pinOrder: 1 }).pinOrder).toBe(1)
    // Já fixado, o pinOrder do PATCH não move (a ordem é do PUT).
    expect(store.update(1, p2, { pinned: true, pinOrder: 7 }).pinOrder).toBe(1)
    // null: pin sem posição, como os de antes da ordem.
    store.update(1, p3, { pinned: false })
    expect(store.update(1, p3, { pinned: true, pinOrder: null }).pinOrder).toBeNull()
  })

  it('fixado de antes da ordem (pin_order nulo) vem antes do recém-fixado', () => {
    const store = createTriageStore(db)
    db.prepare(`INSERT INTO user_triage (user_id, project_id, pinned_at) VALUES (1, ?, ?)`).run(p1, new Date().toISOString())
    expect(store.get(1, p1)).toMatchObject({ pinned: true, pinOrder: null })
    expect(store.update(1, p2, { pinned: true }).pinOrder).toBe(0)
  })

  it('setPinOrder grava a ordem só deste usuário', () => {
    const store = createTriageStore(db)
    for (const u of [1, 2]) for (const p of [p1, p2, p3]) store.update(u, p, { pinned: true })
    store.setPinOrder(1, [p3, p1, p2])
    expect([p1, p2, p3].map((p) => store.get(1, p).pinOrder)).toEqual([1, 2, 0])
    expect([p1, p2, p3].map((p) => store.get(2, p).pinOrder)).toEqual([0, 1, 2])
    // Fixar depois de ordenar continua indo para o fim.
    store.update(1, p3, { pinned: false })
    expect(store.update(1, p3, { pinned: true }).pinOrder).toBe(3)
  })

  it('setPinOrder põe no fim os fixados que não vieram na lista, na ordem que tinham', () => {
    const store = createTriageStore(db)
    for (const p of [p1, p2, p3]) store.update(1, p, { pinned: true })
    store.setPinOrder(1, [p3])
    expect([p3, p1, p2].map((p) => store.get(1, p).pinOrder)).toEqual([0, 1, 2])
  })
})

describe('migração da coluna pin_order', () => {
  it('banco sem a coluna ganha a coluna na abertura, com os pins mantidos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tri-db-'))
    const path = join(dir, 'c.db')
    try {
      let d = openDb(path)
      const a = createProjectsService(d).create({ name: 'A', path: mkdtempSync(join(tmpdir(), 'tri-')) }).id
      d.prepare(`INSERT INTO user_triage (user_id, project_id, pinned_at) VALUES (1, ?, ?)`).run(a, new Date().toISOString())
      d.exec('ALTER TABLE user_triage DROP COLUMN pin_order')
      d.close()
      d = openDb(path)
      try {
        const cols = (d.prepare('PRAGMA table_info(user_triage)').all() as { name: string }[]).map((c) => c.name)
        expect(cols).toContain('pin_order')
        expect(createTriageStore(d).get(1, a)).toMatchObject({ pinned: true, pinOrder: null })
      } finally { d.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
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
