import { describe, it, expect } from 'vitest'
import { isProjectActive, filterEntries, buildEntries, projectsOf, moveEntry, moveInto, flatKeys, type Entry } from '../sidebarEntries'
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
    expect(out.map((e) => (e.kind === 'group' ? `g${e.g.id}` : e.kind === 'sector' ? `s${e.s.id}` : `p${e.p.id}`))).toEqual(['p1', 'g10', 'p3'])
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

/**
 * Setor é um nível acima do grupo: contém grupos E terminais. O filtro precisa
 * entendê-lo, senão ligar "somente ativos" passaria a mostrar setores vazios —
 * o oposto do que ele existe para fazer.
 */
describe('filterEntries com setores', () => {
  const sector = (id: number): Group => ({ id, name: `S${id}` })

  const secEntry = (id: number, children: Entry[]): Entry =>
    ({ kind: 'sector', s: sector(id), children } as Entry)

  it('remove o setor inteiro quando nada dentro dele está ativo', () => {
    const entries: Entry[] = [
      secEntry(1, [
        { kind: 'group', g: group(10), items: [proj(1, 10)] },
        { kind: 'project', p: proj(2) },
      ]),
    ]
    const out = filterEntries(entries, byId(sess('s1', 1, 'stopped'), sess('s2', 2, 'dead')))
    expect(out).toEqual([])
  })

  it('mantém o setor só com o que está ativo', () => {
    const entries: Entry[] = [
      secEntry(1, [
        { kind: 'group', g: group(10), items: [proj(1, 10), proj(2, 10)] },
        { kind: 'project', p: proj(3) },
      ]),
    ]
    const out = filterEntries(entries, byId(
      sess('s1', 1, 'working'), sess('s2', 2, 'stopped'), sess('s3', 3, 'dead'),
    ))
    expect(out).toHaveLength(1)
    const sec = out[0] as Extract<Entry, { kind: 'sector' }>
    expect(sec.children).toHaveLength(1)
    const g = sec.children[0] as Extract<Entry, { kind: 'group' }>
    expect(g.items.map((p) => p.id)).toEqual([1])
  })

  it('mantém terminal solto ativo dentro do setor', () => {
    const entries: Entry[] = [secEntry(1, [{ kind: 'project', p: proj(5) }])]
    const out = filterEntries(entries, byId(sess('s5', 5, 'idle')))
    expect(out).toHaveLength(1)
  })

  it('não muta o setor recebido', () => {
    const entries: Entry[] = [secEntry(1, [
      { kind: 'project', p: proj(1) }, { kind: 'project', p: proj(2) },
    ])]
    filterEntries(entries, byId(sess('s1', 1, 'working'), sess('s2', 2, 'stopped')))
    const sec = entries[0] as Extract<Entry, { kind: 'sector' }>
    expect(sec.children).toHaveLength(2)
  })
})

/**
 * A árvore que a sidebar desenha vem de três listas planas (projects/groups/sectors).
 * Montá-la aqui, e não dentro do componente, é o que torna testável a regra que mais
 * quebra na tela: um item aparecer DUAS vezes (dentro do setor e na raiz).
 */
describe('buildEntries', () => {
  const g = (id: number, sortOrder: number, sectorId?: number): Group =>
    ({ id, name: `G${id}`, sortOrder, sectorId: sectorId ?? null })
  const s = (id: number, sortOrder: number): Group => ({ id, name: `S${id}`, sortOrder })
  const p = (id: number, sortOrder: number, opts: { groupId?: number; sectorId?: number } = {}): Project =>
    ({ id, name: `P${id}`, path: `/tmp/${id}`, color: '#fff', icon: '📁', sortOrder, ...opts })

  it('aninha grupo e terminal dentro do setor, sem repetir na raiz', () => {
    const out = buildEntries(
      [p(1, 2, { groupId: 10 }), p(2, 3, { sectorId: 100 }), p(3, 5)],
      [g(10, 1, 100)],
      [s(100, 0)],
    )
    expect(out.map((e) => (e.kind === 'sector' ? `s${e.s.id}` : e.kind === 'group' ? `g${e.g.id}` : `p${e.p.id}`)))
      .toEqual(['s100', 'p3'])
    const sec = out[0] as Extract<Entry, { kind: 'sector' }>
    expect(sec.children.map((c) => (c.kind === 'group' ? `g${c.g.id}` : `p${c.p.id}`))).toEqual(['g10', 'p2'])
    const grp = sec.children[0] as Extract<Entry, { kind: 'group' }>
    expect(grp.items.map((x) => x.id)).toEqual([1])
  })

  it('ordena cada nível pelo sortOrder unificado', () => {
    const out = buildEntries(
      [p(1, 9), p(2, 1, { sectorId: 100 }), p(3, 4, { sectorId: 100 })],
      [],
      [s(100, 5)],
    )
    // p1 (9) depois do setor (5); dentro do setor, p2 (1) antes de p3 (4)
    expect(out.map((e) => e.kind)).toEqual(['sector', 'project'])
    const sec = out[0] as Extract<Entry, { kind: 'sector' }>
    expect(sec.children.map((c) => (c.kind === 'project' ? c.p.id : 0))).toEqual([2, 3])
  })

  it('trata como raiz o item que aponta para um setor/grupo inexistente (dado órfão)', () => {
    const out = buildEntries([p(1, 1, { sectorId: 999 }), p(2, 2, { groupId: 888 })], [], [])
    expect(out.map((e) => e.kind)).toEqual(['project', 'project'])
  })

  it('o grupo dentro de um setor leva junto os terminais dele, não os deixa na raiz', () => {
    const out = buildEntries([p(1, 2, { groupId: 10 })], [g(10, 1, 100)], [s(100, 0)])
    expect(out).toHaveLength(1)
    expect(projectsOf(out[0]).map((x) => x.id)).toEqual([1])
  })
})

/**
 * Arraste em três níveis. O risco real aqui não é a inserção errada e sim a árvore
 * ficar inconsistente — item em dois lugares, ou sumido —, porque isso vira ordem
 * embaralhada gravada no banco: trabalho manual do operador perdido.
 */
describe('moveEntry / moveInto', () => {
  const g = (id: number, items: Project[] = []): Extract<Entry, { kind: 'group' }> =>
    ({ kind: 'group', g: { id, name: `G${id}` }, items })
  const pr = (id: number): Project => ({ id, name: `P${id}`, path: `/tmp/${id}`, color: '#fff', icon: '📁' })
  const pe = (id: number): Extract<Entry, { kind: 'project' }> => ({ kind: 'project', p: pr(id) })
  const sec = (id: number, children: Array<Extract<Entry, { kind: 'group' | 'project' }>>): Entry =>
    ({ kind: 'sector', s: { id, name: `S${id}` }, children })

  //  s100 ├ g10 └ p1
  //       └ p2
  //  g20 └ p3
  //  p4
  const tree = (): Entry[] => [sec(100, [g(10, [pr(1)]), pe(2)]), g(20, [pr(3)]), pe(4)]

  it('mantém cada terminal em exatamente um lugar depois de mover', () => {
    const out = moveInto(tree(), 'p-4', 's-100')
    const ids = out.flatMap(projectsOf).map((p) => p.id).sort()
    expect(ids).toEqual([1, 2, 3, 4])
  })

  it('solta terminal da raiz dentro do setor, no fim', () => {
    const out = moveInto(tree(), 'p-4', 's-100')
    expect(flatKeys(out)).toEqual(['s-100', 'g-10', 'p-1', 'p-2', 'p-4', 'g-20', 'p-3'])
  })

  it('solta terminal dentro de um grupo que está num setor', () => {
    const out = moveInto(tree(), 'p-4', 'g-10')
    expect(flatKeys(out)).toEqual(['s-100', 'g-10', 'p-1', 'p-4', 'p-2', 'g-20', 'p-3'])
  })

  it('aninha um grupo da raiz no setor, levando os filhos junto', () => {
    const out = moveInto(tree(), 'g-20', 's-100')
    expect(flatKeys(out)).toEqual(['s-100', 'g-10', 'p-1', 'p-2', 'g-20', 'p-3', 'p-4'])
  })

  it('tira o grupo do setor ao soltá-lo numa entrada da raiz', () => {
    // g-10 vem de cima de p-4 → entra DEPOIS dele, já fora do setor
    const out = moveEntry(tree(), 'g-10', 'p-4')
    expect(flatKeys(out)).toEqual(['s-100', 'p-2', 'g-20', 'p-3', 'p-4', 'g-10', 'p-1'])
  })

  it('grupo solto sobre terminal agrupado vai para o lado do grupo dele, não para dentro', () => {
    const out = moveEntry(tree(), 'g-20', 'p-1')
    // p-1 mora em g-10 (dentro de s-100); grupo não entra em grupo → entra no setor
    const sector = out[0] as Extract<Entry, { kind: 'sector' }>
    expect(sector.children.map((c) => (c.kind === 'group' ? `g${c.g.id}` : `p${c.p.id}`))).toEqual(['g20', 'g10', 'p2'])
  })

  it('setor nunca entra em setor: soltar sobre outro setor reposiciona na raiz', () => {
    const t: Entry[] = [sec(100, [pe(1)]), sec(200, [pe(2)])]
    const out = moveInto(t, 's-200', 's-100')
    expect(flatKeys(out)).toEqual(['s-200', 'p-2', 's-100', 'p-1'])
  })

  it('soltar um grupo dentro de si mesmo não muda nada', () => {
    const t = tree()
    expect(moveInto(t, 'g-10', 'g-10')).toEqual(t)
    expect(moveEntry(t, 'g-10', 'p-1')).toEqual(t)
  })

  it('arrastar de cima insere DEPOIS do alvo (senão soltar no vizinho seria no-op)', () => {
    const t: Entry[] = [pe(1), pe(2), pe(3)]
    expect(flatKeys(moveEntry(t, 'p-1', 'p-2'))).toEqual(['p-2', 'p-1', 'p-3'])
    expect(flatKeys(moveEntry(t, 'p-3', 'p-2'))).toEqual(['p-1', 'p-3', 'p-2'])
  })

  it('alvo nulo manda para o fim da raiz, tirando de onde estava', () => {
    const out = moveEntry(tree(), 'p-1', null)
    expect(flatKeys(out)).toEqual(['s-100', 'g-10', 'p-2', 'g-20', 'p-3', 'p-4', 'p-1'])
  })
})
