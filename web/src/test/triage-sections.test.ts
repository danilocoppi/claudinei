import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { buildEntries, filterEntries, flatKeys, projectsOf, type Entry } from '../sidebarEntries'
import { isWorking, nextExpiry, snoozeUntil, splitSections, triageStateOf } from '../triageSections'
import { useStore } from '../store'
import { useTriageSync } from '../useTriageSync'
import type { Project, SessionInfo, SessionStatus, TriageItem } from '../types'
import type { Group } from '../api'

/**
 * Triagem da lista na web: o estado por usuário (fixado, assentado, adiado) e a
 * divisão da árvore da lateral nas seções Fixados, árvore, Adiados e Assentados.
 */
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000

const proj = (id: number, extra: Partial<Project> = {}): Project =>
  ({ id, name: `P${id}`, path: `/tmp/${id}`, color: '#fff', icon: '📁', ...extra })
const grp = (id: number, extra: Partial<Group> = {}): Group => ({ id, name: `G${id}`, ...extra })
const item = (projectId: number, extra: Partial<TriageItem> = {}): TriageItem =>
  ({ projectId, pinned: false, settled: false, snoozedUntil: null, ...extra })
const byProject = (...list: TriageItem[]): Record<number, TriageItem> =>
  Object.fromEntries(list.map((t) => [t.projectId, t]))
const sess = (localId: string, projectId: number, status: SessionStatus, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId, status, engineSessionId: 'c', updatedAt: '2026-11-20', engine: 'claude', ...extra })
const byId = (...list: SessionInfo[]): Record<string, SessionInfo> =>
  Object.fromEntries(list.map((s) => [s.localId, s]))
const ids = (list: Project[]) => list.map((p) => p.id)

/**
 * Setor 100 (ordem 0) com o grupo 10 (P1, P2) e o solto P3; grupo 20 na raiz
 * (ordem 1) com P4 e P5; P6 solto na raiz (ordem 2).
 */
const tree = (): Entry[] => buildEntries(
  [
    proj(1, { groupId: 10, sortOrder: 0 }),
    proj(2, { groupId: 10, sortOrder: 1 }),
    proj(3, { sectorId: 100, sortOrder: 1 }),
    proj(4, { groupId: 20, sortOrder: 0 }),
    proj(5, { groupId: 20, sortOrder: 1 }),
    proj(6, { sortOrder: 2 }),
  ],
  [grp(10, { sectorId: 100, sortOrder: 0 }), grp(20, { sortOrder: 1 })],
  [grp(100, { sortOrder: 0 })],
)

describe('triageStateOf', () => {
  it('lê o estado e o adiado vencido volta ao pin ou ao normal', () => {
    expect(triageStateOf(undefined, NOW)).toBe('none')
    expect(triageStateOf(item(1, { pinned: true }), NOW)).toBe('pinned')
    expect(triageStateOf(item(1, { settled: true }), NOW)).toBe('settled')
    expect(triageStateOf(item(1, { pinned: true, snoozedUntil: iso(NOW + HOUR) }), NOW)).toBe('snoozed')
    expect(triageStateOf(item(1, { pinned: true, snoozedUntil: iso(NOW - 1) }), NOW)).toBe('pinned')
    expect(triageStateOf(item(1, { snoozedUntil: iso(NOW) }), NOW)).toBe('none')
  })
})

describe('splitSections', () => {
  it('splitSections tira fixados, assentados e adiados da árvore e esvazia o grupo que sobrou vazio', () => {
    const out = splitSections(tree(), byProject(
      item(4, { pinned: true }),
      item(5, { settled: true }),
      item(6, { snoozedUntil: iso(NOW + HOUR) }),
    ), NOW)
    expect(ids(out.pinned)).toEqual([4])
    expect(ids(out.settled)).toEqual([5])
    expect(ids(out.snoozed)).toEqual([6])
    // O grupo 20 perdeu os dois terminais e some; o setor fica intacto.
    expect(flatKeys(out.tree)).toEqual(['s-100', 'g-10', 'p-1', 'p-2', 'p-3'])
  })

  it('setor cujo único grupo esvaziou também some; contêiner que já era vazio fica', () => {
    const entries = buildEntries(
      [proj(1, { groupId: 10 }), proj(2, { sortOrder: 2 })],
      [grp(10, { sectorId: 100, sortOrder: 0 }), grp(30, { sortOrder: 1 })],
      [grp(100, { sortOrder: 0 })],
    )
    const out = splitSections(entries, byProject(item(1, { settled: true })), NOW)
    // O grupo 30 nasceu vazio (alvo de arraste) e continua; o setor 100 só tinha o grupo 10.
    expect(flatKeys(out.tree)).toEqual(['g-30', 'p-2'])
  })

  it('sem nada aplicado, devolve as mesmas entradas', () => {
    const entries = tree()
    const out = splitSections(entries, {}, NOW)
    expect(out.tree).toEqual(entries)
    out.tree.forEach((e, i) => expect(e).toBe(entries[i]))
    expect(out.pinned).toEqual([])
    expect(out.snoozed).toEqual([])
    expect(out.settled).toEqual([])
  })

  it('adiado fixado fica só em Adiados até vencer', () => {
    const out = splitSections(tree(), byProject(item(2, { pinned: true, snoozedUntil: iso(NOW + HOUR) })), NOW)
    expect(ids(out.snoozed)).toEqual([2])
    expect(ids(out.pinned)).toEqual([])
    expect(out.tree.flatMap(projectsOf).map((p) => p.id)).not.toContain(2)
  })

  it('adiado vencido volta aos Fixados', () => {
    const triage = byProject(item(2, { pinned: true, snoozedUntil: iso(NOW + HOUR) }))
    const out = splitSections(tree(), triage, NOW + HOUR)
    expect(ids(out.pinned)).toEqual([2])
    expect(ids(out.snoozed)).toEqual([])
  })

  it('adiado vencido sem pin volta à árvore no lugar de antes', () => {
    const out = splitSections(tree(), byProject(item(2, { snoozedUntil: iso(NOW - 1) })), NOW)
    expect(ids(out.snoozed)).toEqual([])
    expect(flatKeys(out.tree)).toEqual(flatKeys(tree()))
  })

  it('ordem de Fixados segue o sortOrder global', () => {
    // P6 solto na raiz com ordem -1 vem antes do setor 100 (ordem 0); dentro do setor,
    // o grupo 10 (P1) vem antes do solto P3; o grupo 20 (P4) fecha. É a ordem visual
    // da lateral, não o id.
    const entries = buildEntries(
      [
        proj(1, { groupId: 10, sortOrder: 0 }),
        proj(3, { sectorId: 100, sortOrder: 1 }),
        proj(4, { groupId: 20, sortOrder: 0 }),
        proj(6, { sortOrder: -1 }),
      ],
      [grp(10, { sectorId: 100, sortOrder: 0 }), grp(20, { sortOrder: 1 })],
      [grp(100, { sortOrder: 0 })],
    )
    const out = splitSections(entries, byProject(
      item(1, { pinned: true }),
      item(3, { pinned: true }),
      item(4, { pinned: true }),
      item(6, { pinned: true }),
    ), NOW)
    expect(ids(out.pinned)).toEqual([6, 1, 3, 4])
    expect(out.tree).toEqual([])
  })

  it('Adiados: volta mais cedo primeiro', () => {
    const out = splitSections(tree(), byProject(
      item(1, { snoozedUntil: iso(NOW + 3 * HOUR) }),
      item(4, { snoozedUntil: iso(NOW + HOUR) }),
      item(6, { snoozedUntil: iso(NOW + 2 * HOUR) }),
    ), NOW)
    expect(ids(out.snoozed)).toEqual([4, 6, 1])
  })

  it('assentado trabalhando continua em settled (não acorda no cliente)', () => {
    const sessions = byId(sess('s5', 5, 'working'))
    expect(isWorking(5, sessions)).toBe(true)
    const out = splitSections(tree(), byProject(item(5, { settled: true })), NOW)
    expect(ids(out.settled)).toEqual([5])
    expect(out.tree.flatMap(projectsOf).map((p) => p.id)).not.toContain(5)
  })
})

describe('filterEntries com o pin', () => {
  it('só fixados usa o pin, não projects.favorite', () => {
    const entries: Entry[] = [
      { kind: 'project', p: proj(1, { favorite: true }) },
      { kind: 'project', p: proj(2) },
    ]
    const pins = byProject(item(2, { pinned: true }))
    const out = filterEntries(entries, {}, false, true, '', (id) => !!pins[id]?.pinned)
    expect(out.flatMap(projectsOf).map((p) => p.id)).toEqual([2])
  })
})

describe('snoozeUntil', () => {
  // Horas LOCAIS: o adiamento é no fuso do navegador, então os testes também.
  it('1 h', () => {
    const now = new Date(2026, 10, 20, 15, 30)
    expect(snoozeUntil('1h', now).getTime()).toBe(now.getTime() + HOUR)
  })

  it('amanhã às 9:00', () => {
    expect(snoozeUntil('tomorrow', new Date(2026, 10, 20, 15, 30))).toEqual(new Date(2026, 10, 21, 9, 0))
  })

  it('às 02:00 vira hoje às 9:00', () => {
    expect(snoozeUntil('tomorrow', new Date(2026, 10, 20, 2, 0))).toEqual(new Date(2026, 10, 20, 9, 0))
  })

  it('amanhã às 9:00 no último dia do mês', () => {
    expect(snoozeUntil('tomorrow', new Date(2026, 10, 30, 22, 0))).toEqual(new Date(2026, 11, 1, 9, 0))
  })

  it('segunda às 9:00, numa sexta', () => {
    const friday = new Date(2026, 10, 20, 15, 0)
    expect(friday.getDay()).toBe(5)
    expect(snoozeUntil('monday', friday)).toEqual(new Date(2026, 10, 23, 9, 0))
  })

  it('segunda às 9:00 numa segunda às 10:00 vira a próxima segunda', () => {
    const monday = new Date(2026, 10, 23, 10, 0)
    expect(monday.getDay()).toBe(1)
    expect(snoozeUntil('monday', monday)).toEqual(new Date(2026, 10, 30, 9, 0))
  })

  it('segunda às 9:00 numa segunda de madrugada é hoje às 9:00', () => {
    expect(snoozeUntil('monday', new Date(2026, 10, 23, 2, 0))).toEqual(new Date(2026, 10, 23, 9, 0))
  })
})

describe('nextExpiry', () => {
  it('nextExpiry ignora vencidos e devolve o menor', () => {
    const triage = byProject(
      item(1, { snoozedUntil: iso(NOW - HOUR) }),
      item(2, { snoozedUntil: iso(NOW + 2 * HOUR) }),
      item(3, { snoozedUntil: iso(NOW + HOUR), pinned: true }),
      item(4, { settled: true }),
    )
    expect(nextExpiry(triage, NOW)).toBe(NOW + HOUR)
    expect(nextExpiry(byProject(item(1, { snoozedUntil: iso(NOW) }), item(2, { pinned: true })), NOW)).toBeNull()
    expect(nextExpiry({}, NOW)).toBeNull()
  })
})

describe('isWorking', () => {
  it('isWorking: working, compactando e in_terminal processando sim; idle e needs_attention não', () => {
    expect(isWorking(1, byId(sess('a', 1, 'working')))).toBe(true)
    expect(isWorking(1, byId(sess('a', 1, 'idle', { compactingSince: NOW })))).toBe(true)
    expect(isWorking(1, byId(sess('a', 1, 'in_terminal', { terminalActivity: 'working' })))).toBe(true)
    expect(isWorking(1, byId(sess('a', 1, 'in_terminal', { terminalActivity: 'waiting' })))).toBe(false)
    expect(isWorking(1, byId(sess('a', 1, 'in_terminal')))).toBe(false)
    expect(isWorking(1, byId(sess('a', 1, 'idle')))).toBe(false)
    expect(isWorking(1, byId(sess('a', 1, 'needs_attention')))).toBe(false)
    // Outro projeto trabalhando não conta; basta uma engine trabalhando no projeto.
    expect(isWorking(1, byId(sess('a', 2, 'working')))).toBe(false)
    expect(isWorking(1, byId(sess('a', 1, 'idle'), sess('b', 1, 'working', { engine: 'codex' })))).toBe(true)
  })
})

describe('estado de triagem no store', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    useStore.setState({ triage: {}, authStatus: 'ready', me: null })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('mensagem WS triage atualiza o store', () => {
    useStore.getState().applyWsMessage({ type: 'triage', userId: 7, item: item(3, { pinned: true }) })
    expect(useStore.getState().triage[3]).toEqual(item(3, { pinned: true }))
    useStore.getState().applyWsMessage({ type: 'triage', userId: 7, item: item(3, { settled: true }) })
    expect(useStore.getState().triage[3]).toEqual(item(3, { settled: true }))
  })

  it('bloqueio limpa a triagem', () => {
    useStore.getState().setTriageItem(item(3, { pinned: true }))
    useStore.getState().setAuth('locked')
    expect(useStore.getState().triage).toEqual({})
  })

  it('lê ao ficar pronto e de novo a cada reconexão; a lista substitui o mapa', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json([item(1, { pinned: true })]))
    renderHook(() => useTriageSync())
    await waitFor(() => expect(useStore.getState().triage[1]?.pinned).toBe(true))
    expect(fetch).toHaveBeenCalledWith('/api/triage', expect.anything())
    fetch.mockImplementation(async () => json([]))
    act(() => useStore.getState().resyncOnReconnect())
    await waitFor(() => expect(useStore.getState().triage[1]).toBeUndefined())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('o que o WebSocket trouxe durante a leitura vence a resposta', async () => {
    let solta!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => { solta = r }))
    renderHook(() => useTriageSync())
    act(() => useStore.getState().applyWsMessage({ type: 'triage', userId: 1, item: item(1, { settled: true }) }))
    await act(async () => { solta(json([item(1, { pinned: true }), item(2, { pinned: true })])) })
    await waitFor(() => expect(useStore.getState().triage[2]?.pinned).toBe(true))
    expect(useStore.getState().triage[1]).toEqual(item(1, { settled: true }))
  })

  it('sem login não lê', () => {
    useStore.setState({ authStatus: 'login' })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json([]))
    renderHook(() => useTriageSync())
    expect(fetch).not.toHaveBeenCalled()
  })
})
