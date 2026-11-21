import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { migratePages } from '../src/pages/schema.js'
import { createPagesStore, type NewPage, type PagesStore } from '../src/pages/store.js'
import { loadConfig } from '../src/config.js'
import { isShowPageName, pageIdIn } from '../../shared/visual-pages.js'

let db: Db
let store: PagesStore
let projectId: number
let otherProjectId: number

const addProject = (name: string) =>
  Number(db.prepare(`INSERT INTO projects (name, path) VALUES (?, ?)`).run(name, `/tmp/${name}`).lastInsertRowid)

let seq = 0
const page = (over: Partial<NewPage> = {}): NewPage => ({
  id: `pg_${(++seq).toString(16).padStart(16, '0')}`,
  projectId,
  engine: 'claude',
  localId: 'loc-1',
  conversationId: 'conv-1',
  turnId: null,
  turnKey: null,
  title: 'Página',
  height: null,
  bytes: 100,
  source: 'html',
  sourcePath: null,
  ...over,
})

beforeEach(() => {
  db = openDb(':memory:')
  store = createPagesStore(db)
  projectId = addProject('a')
  otherProjectId = addProject('b')
})

afterEach(() => db.close())

describe('visual_pages', () => {
  it('migratePages é idempotente e openDb já cria visual_pages', () => {
    const cols = () => (db.prepare(`PRAGMA table_info(visual_pages)`).all() as { name: string }[]).map((c) => c.name)
    expect(cols()).toEqual([
      'id', 'project_id', 'engine', 'local_id', 'conversation_id', 'turn_id', 'turn_key',
      'title', 'height', 'bytes', 'source', 'source_path', 'created_at',
    ])
    expect(() => { migratePages(db); migratePages(db) }).not.toThrow()
    const idx = db.prepare(`PRAGMA index_list(visual_pages)`).all() as { name: string }[]
    expect(idx.map((i) => i.name)).toContain('idx_visual_pages_conv')
  })

  it('insert e get devolvem o DTO sem source_path', () => {
    const dto = store.insert(page({
      id: 'pg_00112233445566ff', turnId: 7, turnKey: 'k7', title: 'Gráfico', height: 480, bytes: 2048,
      source: 'path', sourcePath: '/tmp/a/x.html',
    }))
    expect(dto).toEqual({
      id: 'pg_00112233445566ff', projectId, engine: 'claude', localId: 'loc-1', conversationId: 'conv-1',
      turnId: 7, turnKey: 'k7', title: 'Gráfico', height: 480, bytes: 2048, source: 'path',
      createdAt: expect.any(String),
    })
    expect(dto).not.toHaveProperty('sourcePath')
    expect(store.get('pg_00112233445566ff')).toEqual(dto)
    expect(store.get('pg_ffffffffffffffff')).toBeUndefined()
    // O caminho fica gravado no banco, só não sai no DTO.
    const raw = db.prepare(`SELECT source_path FROM visual_pages WHERE id = ?`).get(dto.id) as { source_path: string }
    expect(raw.source_path).toBe('/tmp/a/x.html')
  })

  it('listConversation: por conversation_id; sem id, por local_id; ordem de criação; outro motor fica de fora', () => {
    // Mesmo created_at (datetime('now') tem resolução de segundo): o desempate é o rowid.
    const a = store.insert(page({ title: 'a' }))
    const b = store.insert(page({ title: 'b', localId: 'loc-velho' }))
    store.insert(page({ title: 'outro motor', engine: 'codex' }))
    store.insert(page({ title: 'outra conversa', conversationId: 'conv-2' }))
    store.insert(page({ title: 'outro projeto', projectId: otherProjectId }))
    const semId1 = store.insert(page({ title: 'sem id 1', conversationId: null, localId: 'loc-2' }))
    store.insert(page({ title: 'sem id, outro local', conversationId: null, localId: 'loc-3' }))
    const semId2 = store.insert(page({ title: 'sem id 2', conversationId: null, localId: 'loc-2' }))
    store.insert(page({ title: 'com id, mesmo local', conversationId: 'conv-9', localId: 'loc-2' }))

    expect(store.listConversation(projectId, 'claude', 'conv-1', 'qualquer').map((p) => p.id)).toEqual([a.id, b.id])
    expect(store.listConversation(projectId, 'claude', null, 'loc-2').map((p) => p.id)).toEqual([semId1.id, semId2.id])
    expect(store.listConversation(projectId, 'codex', null, 'loc-2')).toEqual([])
    expect(store.listConversation(otherProjectId, 'claude', 'conv-1', 'loc-1').map((p) => p.title)).toEqual(['outro projeto'])
  })

  it('listConversation ordena por created_at antes do rowid', () => {
    const novo = store.insert(page({ title: 'novo' }))
    const velho = store.insert(page({ title: 'velho' }))
    db.prepare(`UPDATE visual_pages SET created_at = '2020-01-01 00:00:00' WHERE id = ?`).run(velho.id)
    expect(store.listConversation(projectId, 'claude', 'conv-1', 'loc-1').map((p) => p.id)).toEqual([velho.id, novo.id])
  })

  it('moveTurns troca a conversa só das páginas desses turnos', () => {
    const t1 = store.insert(page({ turnId: 1, conversationId: null }))
    const t2 = store.insert(page({ turnId: 2, conversationId: 'conv-1' }))
    const t3 = store.insert(page({ turnId: 3, conversationId: 'conv-1' }))
    const semTurno = store.insert(page({ turnId: null, conversationId: 'conv-1' }))
    expect(store.moveTurns([1, 2], 'conv-novo')).toBe(2)
    expect(store.get(t1.id)!.conversationId).toBe('conv-novo')
    expect(store.get(t2.id)!.conversationId).toBe('conv-novo')
    expect(store.get(t3.id)!.conversationId).toBe('conv-1')
    expect(store.get(semTurno.id)!.conversationId).toBe('conv-1')
    expect(store.moveTurns([], 'conv-x')).toBe(0)
  })

  it('idsOfTurns, idsOfProject, allIds e remove', () => {
    const t1 = store.insert(page({ turnId: 1 }))
    const t2 = store.insert(page({ turnId: 2 }))
    const outro = store.insert(page({ projectId: otherProjectId, turnId: 3 }))
    expect(store.idsOfTurns([1, 3]).sort()).toEqual([t1.id, outro.id].sort())
    expect(store.idsOfTurns([])).toEqual([])
    expect(store.idsOfProject(projectId).sort()).toEqual([t1.id, t2.id].sort())
    expect(store.allIds().sort()).toEqual([t1.id, t2.id, outro.id].sort())
    store.remove([t1.id, outro.id])
    store.remove([])
    expect(store.allIds()).toEqual([t2.id])
  })

  it('apagar o projeto leva as linhas (cascata)', () => {
    store.insert(page())
    const fica = store.insert(page({ projectId: otherProjectId }))
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId)
    expect(store.idsOfProject(projectId)).toEqual([])
    expect(store.allIds()).toEqual([fica.id])
  })
})

describe('shared/visual-pages', () => {
  it('pageIdIn acha pg_ seguido de 16 hex e recusa 15 ou 17', () => {
    expect(pageIdIn('Página pg_0123456789abcdef publicada')).toBe('pg_0123456789abcdef')
    expect(pageIdIn('{"id":"pg_0123456789abcdef"} e pg_ffffffffffffffff')).toBe('pg_0123456789abcdef')
    expect(pageIdIn('pg_0123456789abcde')).toBeNull()
    expect(pageIdIn('pg_0123456789abcdef0')).toBeNull()
    expect(pageIdIn('pg_0123456789ABCDEF')).toBeNull()
    expect(pageIdIn('xpg_0123456789abcdef')).toBeNull()
    expect(pageIdIn('')).toBeNull()
  })

  it('isShowPageName: mcp__hermes__show_page, hermes/show_page, hermes_show_page, show_page sim; myshow_page e show_pages não', () => {
    for (const n of ['mcp__hermes__show_page', 'hermes/show_page', 'hermes_show_page', 'show_page']) {
      expect(isShowPageName(n), n).toBe(true)
    }
    for (const n of ['myshow_page', 'show_pages', 'check_page', '']) {
      expect(isShowPageName(n), n).toBe(false)
    }
  })
})

describe('loadConfig: pasta das páginas', () => {
  it('loadConfig: CLAUDINEI_PAGES vence o padrão ~/.claudinei/pages', () => {
    expect(loadConfig({}).pagesDir).toBe(join(homedir(), '.claudinei', 'pages'))
    expect(loadConfig({ CLAUDINEI_PAGES: '/srv/paginas' }).pagesDir).toBe('/srv/paginas')
  })
})
