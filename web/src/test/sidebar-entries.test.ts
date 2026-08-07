import { describe, it, expect } from 'vitest'
import { isProjectActive, filterEntries, type Entry } from '../sidebarEntries'
import type { Project, SessionInfo, SessionStatus } from '../types'
import type { Group } from '../api'

const proj = (id: number, groupId?: number): Project =>
  ({ id, name: `P${id}`, path: `/tmp/${id}`, color: '#fff', icon: '📁', groupId })

const sess = (localId: string, projectId: number, status: SessionStatus): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: '2026-08-07', engine: 'claude' })

const byId = (...list: SessionInfo[]): Record<string, SessionInfo> =>
  Object.fromEntries(list.map((s) => [s.localId, s]))

const group = (id: number): Group => ({ id, name: `G${id}` })

describe('isProjectActive', () => {
  const LIVE: SessionStatus[] = ['starting', 'idle', 'working', 'needs_attention', 'in_terminal']

  for (const status of LIVE) {
    it(`considera ativo um projeto com sessão ${status}`, () => {
      expect(isProjectActive(1, byId(sess('s1', 1, status)))).toBe(true)
    })
  }

  for (const status of ['stopped', 'dead'] as SessionStatus[]) {
    it(`não considera ativo um projeto cuja única sessão está ${status}`, () => {
      expect(isProjectActive(1, byId(sess('s1', 1, status)))).toBe(false)
    })
  }

  it('não considera ativo um projeto sem nenhuma sessão', () => {
    expect(isProjectActive(1, byId(sess('s1', 2, 'working')))).toBe(false)
  })

  it('considera ativo quando UMA das engines está viva e a outra parou', () => {
    expect(isProjectActive(1, byId(sess('s1', 1, 'dead'), sess('s2', 1, 'working')))).toBe(true)
  })

  it('mantém ativo o terminal aberto mesmo com a sessão parada (pin)', () => {
    expect(isProjectActive(1, byId(sess('s1', 1, 'stopped')), 's1')).toBe(true)
  })

  it('não pina um projeto quando o localId aberto é de outro projeto', () => {
    expect(isProjectActive(1, byId(sess('s1', 1, 'stopped'), sess('s2', 2, 'stopped')), 's2')).toBe(false)
  })
})

describe('filterEntries', () => {
  it('mantém terminal solto com sessão viva e remove o parado', () => {
    const entries: Entry[] = [
      { kind: 'project', p: proj(1) },
      { kind: 'project', p: proj(2) },
    ]
    const out = filterEntries(entries, byId(sess('s1', 1, 'working'), sess('s2', 2, 'stopped')))
    expect(out).toEqual([{ kind: 'project', p: proj(1) }])
  })

  it('remove o grupo inteiro quando nenhum filho está ativo', () => {
    const entries: Entry[] = [
      { kind: 'group', g: group(10), items: [proj(1, 10), proj(2, 10)] },
    ]
    const out = filterEntries(entries, byId(sess('s1', 1, 'stopped'), sess('s2', 2, 'dead')))
    expect(out).toEqual([])
  })

  it('mantém o grupo com apenas os filhos ativos', () => {
    const entries: Entry[] = [
      { kind: 'group', g: group(10), items: [proj(1, 10), proj(2, 10), proj(3, 10)] },
    ]
    const out = filterEntries(entries, byId(sess('s1', 1, 'stopped'), sess('s2', 2, 'working'), sess('s3', 3, 'idle')))
    expect(out).toEqual([
      { kind: 'group', g: group(10), items: [proj(2, 10), proj(3, 10)] },
    ])
  })

  it('remove grupo sem nenhum filho (o vazio de admin)', () => {
    const entries: Entry[] = [{ kind: 'group', g: group(10), items: [] }]
    expect(filterEntries(entries, {})).toEqual([])
  })

  it('preserva a ordem original das entradas sobreviventes', () => {
    const entries: Entry[] = [
      { kind: 'project', p: proj(1) },
      { kind: 'group', g: group(10), items: [proj(2, 10)] },
      { kind: 'project', p: proj(3) },
    ]
    const out = filterEntries(entries, byId(sess('s1', 1, 'working'), sess('s2', 2, 'idle'), sess('s3', 3, 'working')))
    expect(out.map((e) => (e.kind === 'group' ? `g${e.g.id}` : `p${e.p.id}`))).toEqual(['p1', 'g10', 'p3'])
  })

  it('mantém visível o terminal aberto dentro de um grupo, mesmo parado (pin)', () => {
    const entries: Entry[] = [
      { kind: 'group', g: group(10), items: [proj(1, 10), proj(2, 10)] },
    ]
    const out = filterEntries(entries, byId(sess('s1', 1, 'stopped'), sess('s2', 2, 'dead')), 's1')
    expect(out).toEqual([
      { kind: 'group', g: group(10), items: [proj(1, 10)] },
    ])
  })

  it('não muta o array de entradas recebido', () => {
    const entries: Entry[] = [
      { kind: 'group', g: group(10), items: [proj(1, 10), proj(2, 10)] },
    ]
    filterEntries(entries, byId(sess('s1', 1, 'working'), sess('s2', 2, 'stopped')))
    expect(entries[0].kind === 'group' && entries[0].items).toHaveLength(2)
  })
})
