import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSchedulesStore, type SchedulesStore } from '../src/schedules/store.js'

let db: Db
let store: SchedulesStore
let dir: string
let projectId: number

const newProject = (name: string) =>
  createProjectsService(db).create({ name, path: mkdtempSync(join(tmpdir(), `sch-${name}-`)) }).id

beforeEach(() => {
  db = openDb(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'sch-results-'))
  store = createSchedulesStore(db, { dir })
  projectId = newProject('alpha')
})

const base = { name: 'Preços', task: 'buscar preços', cadence: { kind: 'daily' as const, at: '12:00' } }

describe('CRUD de agendamento', () => {
  it('cria já com a próxima execução calculada', () => {
    const s = store.create(projectId, base)
    expect(s.name).toBe('Preços')
    expect(s.enabled).toBe(true)
    expect(new Date(s.nextRunAt!).getHours()).toBe(12)
  })

  it('pausar zera a próxima execução; retomar recalcula a partir de agora', () => {
    const s = store.create(projectId, base)
    expect(store.setEnabled(s.id, false).nextRunAt).toBeNull()
    const back = store.setEnabled(s.id, true)
    expect(back.nextRunAt).toBeTruthy()
    expect(new Date(back.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
  })

  it('editar a cadência recalcula a próxima execução', () => {
    const s = store.create(projectId, base)
    const upd = store.update(s.id, { cadence: { kind: 'daily', at: '23:30' } })
    expect(new Date(upd.nextRunAt!).getHours()).toBe(23)
  })

  it('due() traz só os habilitados cujo horário já chegou', () => {
    const past = store.create(projectId, base)
    const future = store.create(projectId, base)
    const paused = store.create(projectId, base)
    db.prepare(`UPDATE schedules SET next_run_at=? WHERE id=?`).run(new Date(Date.now() - 60_000).toISOString(), past.id)
    store.setEnabled(paused.id, false)
    db.prepare(`UPDATE schedules SET next_run_at=? WHERE id=?`).run(new Date(Date.now() - 60_000).toISOString(), paused.id)
    const due = store.due(new Date()).map((x) => x.id)
    expect(due).toContain(past.id)
    expect(due).not.toContain(future.id)
    expect(due).not.toContain(paused.id)  // pausado não dispara nem com horário vencido
  })
})

describe('execuções e resultado em arquivo', () => {
  it('grava o conteúdo em arquivo e guarda só o título no banco', () => {
    const s = store.create(projectId, base)
    const run = store.startRun(s.id, {})
    store.finishRun(run.id, { status: 'ok', content: '## Três lojas\n1. Loja A — R$ 189,90\n' })

    const row = db.prepare(`SELECT title, content_size FROM schedule_runs WHERE id=?`).get(run.id) as any
    expect(row.title).toBe('Três lojas')          // sem a marca de cabeçalho
    expect(row.content_size).toBeGreaterThan(0)
    expect(store.readContent(s.id, run.seq)).toContain('Loja A')
    expect(readdirSync(join(dir, String(s.id)))).toEqual([`${run.seq}.md`])
  })

  it('numera as execuções sem reusar seq, mesmo depois da poda', () => {
    const s = store.create(projectId, { ...base, keepResults: 2 })
    const seqs: number[] = []
    for (let i = 0; i < 4; i++) {
      const r = store.startRun(s.id, {})
      store.finishRun(r.id, { status: 'ok', content: `resultado ${i}` })
      seqs.push(r.seq)
    }
    expect(seqs).toEqual([1, 2, 3, 4])
    expect(store.listRuns(s.id, 10).map((r) => r.seq)).toEqual([4, 3])
  })

  it('a poda apaga a linha E o arquivo', () => {
    const s = store.create(projectId, { ...base, keepResults: 1 })
    const first = store.startRun(s.id, {})
    store.finishRun(first.id, { status: 'ok', content: 'antigo' })
    const firstFile = join(dir, String(s.id), `${first.seq}.md`)
    expect(existsSync(firstFile)).toBe(true)

    const second = store.startRun(s.id, {})
    store.finishRun(second.id, { status: 'ok', content: 'novo' })
    expect(existsSync(firstFile)).toBe(false)
    expect(store.listRuns(s.id, 10)).toHaveLength(1)
  })

  it('corta em 128 KB e marca o corte', () => {
    const s = store.create(projectId, base)
    const r = store.startRun(s.id, {})
    store.finishRun(r.id, { status: 'ok', content: 'x'.repeat(200_000) })
    const content = store.readContent(s.id, r.seq)!
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(128 * 1024 + 200)
    expect(content).toMatch(/cortad/i)
  })

  /** Uma execução que aconteceu não pode sumir do histórico porque o arquivo se perdeu. */
  it('arquivo ausente não derruba o feed', () => {
    const s = store.create(projectId, base)
    const r = store.startRun(s.id, {})
    store.finishRun(r.id, { status: 'ok', content: 'algo' })
    rmSync(join(dir, String(s.id), `${r.seq}.md`))
    expect(store.readContent(s.id, r.seq)).toBeNull()
    expect(store.listRuns(s.id, 10)).toHaveLength(1)
  })

  it('sem conteúdo (só disparar), guarda o carimbo sem arquivo', () => {
    const s = store.create(projectId, { ...base, expectsResult: false })
    const r = store.startRun(s.id, {})
    store.finishRun(r.id, { status: 'ok' })
    expect(store.listRuns(s.id, 10)[0].contentSize).toBeNull()
    expect(existsSync(join(dir, String(s.id)))).toBe(false)
  })

  it('falha guarda o erro e conta as falhas seguidas; sucesso zera', () => {
    const s = store.create(projectId, base)
    for (let i = 0; i < 2; i++) {
      const r = store.startRun(s.id, {})
      store.finishRun(r.id, { status: 'error', error: 'sessão não subiu' })
    }
    expect(store.get(s.id)!.consecutiveFailures).toBe(2)
    expect(store.listRuns(s.id, 1)[0].error).toBe('sessão não subiu')

    const ok = store.startRun(s.id, {})
    store.finishRun(ok.id, { status: 'ok', content: 'foi' })
    expect(store.get(s.id)!.consecutiveFailures).toBe(0)
  })

  it('execução em curso é visível (para a regra de sobreposição)', () => {
    const s = store.create(projectId, base)
    const r = store.startRun(s.id, {})
    expect(store.hasRunning(s.id)).toBe(true)
    store.finishRun(r.id, { status: 'ok', content: 'fim' })
    expect(store.hasRunning(s.id)).toBe(false)
  })
})

describe('listagem', () => {
  it('traz o preview do último resultado, sem carregar o arquivo inteiro', () => {
    const s = store.create(projectId, base)
    const r = store.startRun(s.id, {})
    store.finishRun(r.id, { status: 'ok', content: 'y'.repeat(10_000) })
    const [item] = store.listByProject(projectId)
    expect(item.lastRun!.preview!.length).toBeLessThanOrEqual(4096)
    expect(item.lastRun!.contentSize).toBe(10_000)
  })

  it('apagar o agendamento leva a pasta de resultados junto', () => {
    const s = store.create(projectId, base)
    const r = store.startRun(s.id, {})
    store.finishRun(r.id, { status: 'ok', content: 'algo' })
    store.remove(s.id)
    expect(existsSync(join(dir, String(s.id)))).toBe(false)
    expect(store.listByProject(projectId)).toEqual([])
  })
})
