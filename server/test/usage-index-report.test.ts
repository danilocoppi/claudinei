import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { createUsageIndexStore, type UsageIndexStore, type UsageRow } from '../src/usage-index/store.js'
import { buildUsageReport, matchProject, type UsagePeriod } from '../src/usage-index/report.js'

let db: Db
let store: UsageIndexStore
let seq = 0

// "Agora" fixo dos testes: 20/11/2026 15:30 UTC.
const NOW = new Date('2026-11-20T15:30:00Z')

beforeEach(() => {
  db = openDb(':memory:')
  store = createUsageIndexStore(db)
})

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  hour: '2026-11-20T10', engine: 'claude', model: 'claude-opus', cwd: '/fora',
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  ...over,
})

/** Grava as linhas pelo repositório da Task 1, cada uma num arquivo falso próprio. */
function insere(...rows: Partial<UsageRow>[]): void {
  for (const over of rows) {
    const path = `f${++seq}.jsonl`
    store.commitSlice({ path, engine: over.engine ?? 'claude', size: 1, mtimeMs: 1, offset: 1, parser: null }, [{ row: row(over) }])
  }
}

const proj = (id: number, name: string, path: string) => ({ id, name, path })

function relatorio(period: UsagePeriod, projects = [] as ReturnType<typeof proj>[], tzOffsetMin = 0) {
  return buildUsageReport(db, { period, now: NOW, tzOffsetMin, projects })
}

describe('matchProject', () => {
  const projetos = [proj(1, 'A', '/a'), proj(2, 'AB', '/a/b/'), proj(3, 'Proj', '/a/proj'), proj(4, 'Proj2', '/a/proj2')]

  it('pasta mais específica vence', () => {
    expect(matchProject('/a/b/c', projetos).map(p => p.id)).toEqual([2])
    expect(matchProject('/a/b', projetos).map(p => p.id)).toEqual([2])
    expect(matchProject('/a/c', projetos).map(p => p.id)).toEqual([1])
  })

  it('prefixo parecido não casa', () => {
    expect(matchProject('/a/proj2/x', projetos).map(p => p.id)).toEqual([4])
    expect(matchProject('/a/proj/x', projetos).map(p => p.id)).toEqual([3])
    expect(matchProject('/ab', projetos)).toEqual([])
  })

  it('devolve todos os projetos da pasta compartilhada e nada sem cwd', () => {
    const comp = [proj(7, 'X', '/s'), proj(8, 'Y', '/s/')]
    expect(matchProject('/s/sub', comp).map(p => p.id)).toEqual([7, 8])
    expect(matchProject('', comp)).toEqual([])
  })
})

describe('buildUsageReport', () => {
  it('totais e percentual do cache do período', () => {
    insere({ input: 60, output: 40, cacheRead: 200, cacheWrite: 50, reasoning: 5 },
      { engine: 'codex', model: 'gpt-5', input: 40, output: 10, cacheRead: 100, cacheWrite: 50, reasoning: 7 })
    const r = relatorio('24h')
    expect(r.period).toBe('24h')
    expect(r.totals).toEqual({ input: 100, output: 50, cacheRead: 300, cacheWrite: 100, reasoning: 12, spent: 250 })
    expect(r.totals.spent).toBe(r.totals.input + r.totals.output + r.totals.cacheWrite)
    expect(r.cachePct).toBe(60)
  })

  it('cachePct com uma casa decimal', () => {
    insere({ input: 2, cacheRead: 1 })
    expect(relatorio('24h').cachePct).toBe(33.3)
  })

  it('24h exclui o que é mais velho', () => {
    // Início do período: 19/11 15:30 UTC arredondado para 19/11 15 h.
    insere({ hour: '2026-11-19T14', input: 1000 }, { hour: '2026-11-19T15', input: 7 }, { hour: '2026-11-20T15', input: 3 })
    expect(relatorio('24h').totals.input).toBe(10)
    expect(relatorio('7d').totals.input).toBe(1010)
  })

  it('terminais ordenados por gasto, com divisão por motor', () => {
    const projetos = [proj(1, 'Leve', '/p/leve'), proj(2, 'Pesado', '/p/pesado')]
    insere({ cwd: '/p/leve', input: 10 },
      { cwd: '/p/pesado/src', input: 100, output: 20 },
      { cwd: '/p/pesado', engine: 'codex', model: 'gpt-5', input: 50, cacheWrite: 5, reasoning: 3 })
    const r = relatorio('24h', projetos)
    expect(r.terminals.map(t => t.names)).toEqual([['Pesado'], ['Leve']])
    const pesado = r.terminals[0]
    expect(pesado).toMatchObject({ projectIds: [2], path: '/p/pesado' })
    expect(pesado.totals.spent).toBe(175)
    expect(pesado.byEngine.claude).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, spent: 120 })
    expect(pesado.byEngine.codex).toEqual({ input: 50, output: 0, cacheRead: 0, cacheWrite: 5, reasoning: 3, spent: 55 })
    expect(r.terminals[1].byEngine).toEqual({ claude: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, spent: 10 } })
  })

  it('pasta mais específica vence', () => {
    insere({ cwd: '/a/b/c', input: 5 })
    const r = relatorio('24h', [proj(1, 'A', '/a'), proj(2, 'AB', '/a/b')])
    expect(r.terminals).toHaveLength(1)
    expect(r.terminals[0]).toMatchObject({ projectIds: [2], names: ['AB'], path: '/a/b' })
  })

  it('prefixo parecido não casa', () => {
    insere({ cwd: '/a/proj2/x', input: 5 })
    const r = relatorio('24h', [proj(1, 'Proj', '/a/proj'), proj(2, 'Proj2', '/a/proj2')])
    expect(r.terminals).toHaveLength(1)
    expect(r.terminals[0]).toMatchObject({ projectIds: [2], names: ['Proj2'], path: '/a/proj2' })
  })

  it('pasta compartilhada junta os terminais', () => {
    insere({ cwd: '/s', input: 5 }, { cwd: '/s/x', input: 6 })
    const r = relatorio('24h', [proj(3, 'Um', '/s'), proj(9, 'Outro', '/outra'), proj(4, 'Dois', '/s/')])
    expect(r.terminals).toHaveLength(1)
    expect(r.terminals[0]).toMatchObject({ projectIds: [3, 4], names: ['Um', 'Dois'], path: '/s' })
    expect(r.terminals[0].totals.input).toBe(11)
  })

  it('sem casamento vai para Fora do Claudinei', () => {
    insere({ cwd: '/longe', input: 30 }, { cwd: '', engine: 'codex', model: 'gpt-5', input: 20 }, { cwd: '/p', input: 60 })
    const r = relatorio('24h', [proj(1, 'P', '/p')])
    expect(r.terminals).toHaveLength(2)
    expect(r.terminals[0]).toMatchObject({ projectIds: [1], path: '/p' })
    expect(r.terminals[1]).toMatchObject({ projectIds: [], names: [], path: null })
    expect(r.terminals[1].totals.spent).toBe(50)
    expect(Object.keys(r.terminals[1].byEngine).sort()).toEqual(['claude', 'codex'])
    // O balde de fora entra no ranking pelo gasto, como os outros.
    insere({ cwd: '/longe', input: 100 })
    expect(relatorio('24h', [proj(1, 'P', '/p')]).terminals.map(t => t.path)).toEqual([null, '/p'])
  })

  it('omite terminal sem gasto nem cache', () => {
    insere({ cwd: '/p' }, { cwd: '/q', cacheRead: 4 })
    const r = relatorio('24h', [proj(1, 'P', '/p'), proj(2, 'Q', '/q')])
    expect(r.terminals.map(t => t.projectIds)).toEqual([[2]])
  })

  it('modelos ordenados por gasto', () => {
    insere({ model: 'claude-sonnet', input: 10 },
      { model: 'claude-opus', input: 30, cwd: '/x' },
      { model: 'claude-opus', output: 5, hour: '2026-11-20T11' },
      { engine: 'codex', model: 'gpt-5', input: 20, cacheWrite: 1 })
    const r = relatorio('24h')
    expect(r.models.map(m => [m.model, m.engine, m.totals.spent])).toEqual([
      ['claude-opus', 'claude', 35],
      ['gpt-5', 'codex', 21],
      ['claude-sonnet', 'claude', 10],
    ])
  })

  it('série por hora local em 24h, crescente e preenchida com zero', () => {
    insere({ hour: '2026-11-20T10', input: 4, cacheRead: 2 }, { hour: '2026-11-20T10', input: 1, model: 'outro' })
    const r = relatorio('24h', [], 180)
    // De 19/11 15 h UTC (12 h local) até 20/11 15:30 UTC (12 h local): 25 horas.
    expect(r.series).toHaveLength(25)
    expect(r.series[0].bucket).toBe('2026-11-19T12')
    expect(r.series.at(-1)!.bucket).toBe('2026-11-20T12')
    expect(r.series.find(s => s.bucket === '2026-11-20T07')).toEqual({ bucket: '2026-11-20T07', spent: 5, cacheRead: 2 })
    expect(r.series.reduce((n, s) => n + s.spent, 0)).toBe(5)
  })

  it('série por dia local', () => {
    insere({ hour: '2026-11-20T02', input: 9, cacheRead: 1 }, { hour: '2026-11-20T03', input: 4 })
    const r = relatorio('7d', [], 180)
    // De 13/11 15 h UTC (12 h local) até 20/11 12:30 local: 8 dias.
    expect(r.series.map(s => s.bucket)).toEqual([
      '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20',
    ])
    // 02 h UTC são 23 h do dia anterior no fuso de -3 h.
    expect(r.series[6]).toEqual({ bucket: '2026-11-19', spent: 9, cacheRead: 1 })
    expect(r.series[7]).toEqual({ bucket: '2026-11-20', spent: 4, cacheRead: 0 })
  })

  it('série de 90 dias cobre o período inteiro', () => {
    const r = relatorio('90d')
    expect(r.series).toHaveLength(91)
    expect(r.series[0].bucket).toBe('2026-08-22')
    expect(r.series.at(-1)!.bucket).toBe('2026-11-20')
  })

  it('período sem dados devolve listas vazias e cachePct 0', () => {
    insere({ hour: '2026-01-01T00', input: 50, cwd: '/p' })
    const r = relatorio('30d', [proj(1, 'P', '/p')])
    expect(r.terminals).toEqual([])
    expect(r.models).toEqual([])
    expect(r.cachePct).toBe(0)
    expect(r.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, spent: 0 })
    expect(r.series.every(s => s.spent === 0 && s.cacheRead === 0)).toBe(true)
    expect(r.oldestHour).toBe('2026-01-01T00')
  })

  it('oldestHour é null com a tabela vazia', () => {
    expect(relatorio('24h').oldestHour).toBeNull()
  })
})
