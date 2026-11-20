import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { UndoToast } from '../components/UndoToast'
import { WorkingStrip } from '../components/WorkingStrip'
import { useStore } from '../store'
import { applyTriage, reorderPins, undoTriage } from '../triageActions'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, Project, SessionInfo, TriageItem } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const project = (id: number, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, path: `/tmp/${id}`, icon: '📁', color: '#fff', ...extra })
const session = (projectId: number, status: SessionInfo['status'], extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: `s${projectId}`, projectId, status, engine: 'claude', engineSessionId: 'c', updatedAt: 'x', ...extra })
const item = (projectId: number, patch: Partial<TriageItem>): TriageItem =>
  ({ projectId, pinned: false, settled: false, snoozedUntil: null, ...patch })

// Sexta-feira, 20/11/2026, 14:00 no fuso do navegador.
const NOW = new Date(2026, 10, 20, 14, 0, 0, 0).getTime()
const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Alpha e Beta no grupo, Gama solto, Delta fixado, Eps assentado, Zeta adiado por
 * 1 h e Eta adiado até segunda às 9:00.
 */
const seed = (sessions: Record<string, SessionInfo> = {}) => {
  useStore.setState({
    projects: [
      project(1, 'Alpha', { groupId: 10 }),
      project(2, 'Beta', { groupId: 10 }),
      project(3, 'Gama'),
      project(4, 'Delta'),
      project(5, 'Eps'),
      project(6, 'Zeta'),
      project(7, 'Eta'),
    ],
    groups: [{ id: 10, name: 'Grupo' }],
    sectors: [],
    sessions,
    triage: {
      4: item(4, { pinned: true }),
      5: item(5, { settled: true }),
      6: item(6, { snoozedUntil: iso(NOW + HOUR) }),
      7: item(7, { snoozedUntil: iso(new Date(2026, 10, 23, 9, 0).getTime()) }),
    },
    chat: {}, unread: {}, streaming: {}, historyLoadedFor: {}, schedules: [],
    view: 'dashboard', activeLocalId: undefined, railMode: false,
    engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'root', isAdmin: true },
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(NOW)
  seed()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const section = (id: 'pinned' | 'snoozed' | 'settled') => screen.getByTestId(`triage-${id}`)
const tree = () => screen.getByTestId('term-tree')
const strip = () => screen.queryByTestId('working-strip')
const cardOf = (name: string) =>
  screen.getAllByTestId('term-card').find((c) => c.querySelector('.term-card__name')?.textContent === name) as HTMLElement
/** Deixa a resposta do fetch falso chegar ao store (setImmediate não é falsificado). */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) })
const setSessions = (sessions: Record<string, SessionInfo>) => act(() => { useStore.setState({ sessions }) })

describe('Sidebar — seções da triagem', () => {
  it('seções na ordem: Trabalhando, Fixados, árvore, Adiados, Assentados', () => {
    seed({ s3: session(3, 'working') })
    render(<Sidebar />)
    const order = [strip()!, section('pinned'), tree(), section('snoozed'), section('settled')]
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(within(section('pinned')).getByText('Delta')).toBeTruthy()
    expect(within(tree()).getByText('Alpha')).toBeTruthy()
    expect(within(tree()).getByText('Gama')).toBeTruthy()
    // Fixado, assentado e adiado saem da árvore: o cartão mora numa seção só.
    expect(within(tree()).queryByText('Delta')).toBeNull()
    expect(within(tree()).queryByText('Eps')).toBeNull()
    expect(within(tree()).queryByText('Zeta')).toBeNull()
  })

  it('a ⭐ fixa e o cartão vai para Fixados', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify(item(2, { pinned: body.pinned })), { status: 200 })
    })
    render(<Sidebar />)
    expect(within(tree()).getByText('Beta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fixar Beta' }))
    await settle()
    expect(within(section('pinned')).getByText('Beta')).toBeTruthy()
    expect(within(tree()).queryByText('Beta')).toBeNull()
    expect(fetcher.mock.calls.some(([url, init]) =>
      String(url) === '/api/projects/2/triage' && init?.method === 'PATCH' && JSON.parse(String(init.body)).pinned === true)).toBe(true)
    expect(useStore.getState().triage[2]?.pinned).toBe(true)
    // E a mesma ⭐ desfixa: o cartão volta ao grupo dele.
    fireEvent.click(screen.getByRole('button', { name: 'Desafixar Beta' }))
    await settle()
    expect(within(tree()).getByText('Beta')).toBeTruthy()
  })

  it('Adiados e Assentados começam recolhidos e a busca os abre', () => {
    render(<Sidebar />)
    expect(within(section('settled')).queryByText('Eps')).toBeNull()
    expect(within(section('snoozed')).queryByText('Zeta')).toBeNull()
    // Recolhida, a seção ainda diz quantos guarda.
    expect(within(section('snoozed')).getByText('2')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'eps' } })
    expect(within(section('settled')).getByText('Eps')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'eta' } })
    expect(within(section('snoozed')).getByText('Zeta')).toBeTruthy()
    expect(within(section('snoozed')).getByText('Eta')).toBeTruthy()
    // O adiado diz quando volta: hoje, a hora; outro dia, o dia da semana.
    expect(within(cardOf('Zeta')).getByText('volta às 15:00')).toBeTruthy()
    expect(within(cardOf('Eta')).getByText('volta seg. 9:00')).toBeTruthy()

    // Sem busca, volta a escolha salva.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(within(section('settled')).queryByText('Eps')).toBeNull()

    // Abrir pelo cabeçalho fica lembrado.
    fireEvent.click(within(section('settled')).getByRole('button', { name: /Assentados/ }))
    expect(within(section('settled')).getByText('Eps')).toBeTruthy()
    cleanup()
    render(<Sidebar />)
    expect(within(section('settled')).getByText('Eps')).toBeTruthy()
    expect(within(section('snoozed')).queryByText('Zeta')).toBeNull()
  })

  it('seção vazia continua montada no lugar, escondida', () => {
    seed()
    useStore.setState({ triage: {} })
    render(<Sidebar />)
    for (const id of ['pinned', 'snoozed', 'settled'] as const) expect(section(id).style.display).toBe('none')
  })

  it('faixa some vazia e lista assentado trabalhando, não adiado', () => {
    render(<Sidebar />)
    expect(strip()).toBeNull()

    setSessions({
      s1: session(1, 'idle'),
      s5: session(5, 'working'),
      s6: session(6, 'working'),
      s3: session(3, 'in_terminal', { terminalActivity: 'working' }),
      s2: session(2, 'idle', { compactingSince: 1 }),
    })
    const rows = within(strip()!).getAllByTestId('working-row')
    expect(rows.map((r) => r.querySelector('.working-strip__name')!.textContent).sort()).toEqual(['Beta', 'Eps', 'Gama'])
    expect(within(strip()!).queryByText('Zeta')).toBeNull()
    // Sem rosto: a faixa só lista, não anima nada.
    expect(strip()!.querySelector('[data-face]')).toBeNull()
    // Ícone, nome, motor e estado.
    const eps = rows.find((r) => r.textContent!.includes('Eps'))!
    expect(eps.textContent).toContain('Claude Code')
    expect(eps.textContent).toContain('trabalhando')
    // O assentado que trabalha não acorda: segue em Assentados.
    expect(useStore.getState().triage[5]?.settled).toBe(true)

    // Recolher a faixa fica lembrado.
    fireEvent.click(within(strip()!).getByRole('button', { name: /Trabalhando/ }))
    expect(within(strip()!).queryAllByTestId('working-row')).toHaveLength(0)
    cleanup()
    render(<Sidebar />)
    expect(within(strip()!).queryAllByTestId('working-row')).toHaveLength(0)
    fireEvent.click(within(strip()!).getByRole('button', { name: /Trabalhando/ }))
    expect(within(strip()!).getAllByTestId('working-row')).toHaveLength(3)

    setSessions({ s1: session(1, 'idle'), s5: session(5, 'idle') })
    expect(strip()).toBeNull()
  })

  it('clique na linha da faixa abre o chat', () => {
    seed({ s5: session(5, 'working') })
    render(<Sidebar />)
    fireEvent.click(within(strip()!).getByTestId('working-row'))
    expect(useStore.getState().view).toBe('chat')
    expect(useStore.getState().activeLocalId).toBe('s5')
  })

  it('trilho: fixados no topo, ícones da faixa, sem assentados/adiados', () => {
    seed({ s5: session(5, 'working'), s6: session(6, 'working'), s1: session(1, 'idle') })
    useStore.setState({ railMode: true })
    render(<Sidebar />)
    const rail = screen.getByTestId('rail')
    const pinned = within(rail).getByTestId('rail-pinned')
    const working = within(rail).getByTestId('rail-working')
    expect(rail.firstElementChild).toBe(pinned)
    expect(within(pinned).getByTitle('Delta')).toBeTruthy()
    expect(pinned.compareDocumentPosition(working) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Na faixa, o assentado que trabalha aparece como ícone, sem rosto.
    const icons = within(working).getAllByTestId('working-row')
    expect(icons).toHaveLength(1)
    expect(icons[0].getAttribute('title')).toMatch(/^Eps · Claude Code/)
    expect(working.querySelector('[data-face]')).toBeNull()
    // Assentados e adiados não têm linha própria no trilho; a árvore segue ali.
    expect(within(rail).queryByTitle('Eps')).toBeNull()
    expect(within(rail).queryByTitle('Zeta')).toBeNull()
    expect(within(rail).queryByTitle('Eta')).toBeNull()
    expect(within(rail).getByTitle('Alpha')).toBeTruthy()
    // O ícone da faixa abre o chat.
    fireEvent.click(icons[0])
    expect(useStore.getState().activeLocalId).toBe('s5')
  })

  it('adiado volta sozinho ao vencer', () => {
    seed({ s6: session(6, 'working') })
    render(<Sidebar />)
    expect(within(tree()).queryByText('Zeta')).toBeNull()
    expect(strip()).toBeNull()
    act(() => { vi.advanceTimersByTime(HOUR - 1000) })
    expect(within(tree()).queryByText('Zeta')).toBeNull()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(within(tree()).getByText('Zeta')).toBeTruthy()
    // A faixa também deixa de ignorá-lo.
    expect(within(strip()!).getByText('Zeta')).toBeTruthy()
    // O de segunda continua adiado.
    expect(within(tree()).queryByText('Eta')).toBeNull()
  })
})

describe('Sidebar — desempenho da triagem (AGENTS.md)', () => {
  it('mudar o status de uma sessão não remonta cartões', () => {
    seed({ s1: session(1, 'idle'), s4: session(4, 'idle') })
    render(<Sidebar />)
    const alpha = cardOf('Alpha')
    const delta = cardOf('Delta')
    const alphaFace = alpha.querySelector('[data-face]')
    expect(within(section('pinned')).getByText('Delta')).toBeTruthy()

    setSessions({ s1: session(1, 'working'), s4: session(4, 'working') })
    // A faixa apareceu, e os cartões continuam os mesmos nós no mesmo lugar.
    expect(strip()).toBeTruthy()
    expect(cardOf('Alpha')).toBe(alpha)
    expect(cardOf('Delta')).toBe(delta)
    expect(alpha.querySelector('[data-face]')).toBe(alphaFace)

    setSessions({ s1: session(1, 'idle'), s4: session(4, 'idle') })
    expect(strip()).toBeNull()
    expect(cardOf('Alpha')).toBe(alpha)
    expect(cardOf('Delta')).toBe(delta)
    expect(alpha.querySelector('[data-face]')).toBe(alphaFace)
    expect(within(section('pinned')).getByText('Delta')).toBeTruthy()
  })

  // Montada sozinha, sem pai: mede o seletor estreito. O `memo` (a faixa não
  // renderiza quando a lateral renderiza) é medido em working-strip-render.test.tsx.
  it('a faixa não renderiza com status de quem está fora dela', () => {
    seed({ s1: session(1, 'working'), s2: session(2, 'idle') })
    useStore.setState({ unread: { s2: 3 } })
    const commits = vi.fn()
    render(<Profiler id="faixa" onRender={commits}><WorkingStrip /></Profiler>)
    expect(screen.getAllByTestId('working-row')).toHaveLength(1)
    commits.mockClear()

    // Ocioso → ocioso e lido, e ainda uma volta por "esperando você": nada disso é da faixa.
    act(() => { useStore.setState({ sessions: { ...useStore.getState().sessions, s2: session(2, 'idle', { updatedAt: 'y' }) }, unread: { s2: 0 } }) })
    act(() => { useStore.setState({ sessions: { ...useStore.getState().sessions, s2: session(2, 'needs_attention') } }) })
    act(() => { useStore.setState({ sessions: { ...useStore.getState().sessions, s2: session(2, 'idle') } }) })
    expect(commits).toHaveBeenCalledTimes(0)

    // Prova de que o contador mede: mudar quem está na faixa renderiza (o React 18
    // ainda fecha um segundo commit vazio, de ~0 ms, então a conta é "ao menos um").
    act(() => { useStore.setState({ sessions: { ...useStore.getState().sessions, s1: session(1, 'working', { compactingSince: 1 }) } }) })
    expect(commits.mock.calls.length).toBeGreaterThan(0)
    expect(screen.getByTestId('working-row').textContent).toContain('compactando')
  })
})

describe('Sidebar — ordem dos Fixados', () => {
  /** Delta, Gama e Alpha fixados, nesta ordem do usuário. */
  const seedPins = () => {
    useStore.setState({
      triage: {
        ...useStore.getState().triage,
        4: item(4, { pinned: true, pinOrder: 0 }),
        3: item(3, { pinned: true, pinOrder: 1 }),
        1: item(1, { pinned: true, pinOrder: 2 }),
      },
    })
  }
  const pinnedNames = () => within(section('pinned')).getAllByTestId('term-card')
    .map((c) => c.querySelector('.term-card__name')?.textContent)
  /** A rota devolve a triagem com as posições do corpo, como o servidor. */
  const okOrder = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/triage/pin-order' && init?.method === 'PUT') {
      const ids: number[] = JSON.parse(String(init.body)).projectIds
      return new Response(JSON.stringify(ids.map((id, i) => item(id, { pinned: true, pinOrder: i }))), { status: 200 })
    }
    return new Response('[]', { status: 200 })
  })
  const putCalls = (fetcher: ReturnType<typeof okOrder>) =>
    fetcher.mock.calls.filter(([url, init]: any[]) => String(url) === '/api/triage/pin-order' && init?.method === 'PUT')

  beforeEach(() => { seedPins() })

  it('arrastar um fixado sobre outro reordena na hora, grava e não remonta o cartão', async () => {
    const fetcher = okOrder()
    render(<Sidebar />)
    expect(pinnedNames()).toEqual(['Delta', 'Gama', 'Alpha'])
    const delta = cardOf('Delta')
    const face = delta.querySelector('[data-face]')
    expect(delta.draggable).toBe(true)

    fireEvent.dragStart(delta)
    // Soltar entre os Fixados é permitido (o navegador só aceita o drop com preventDefault).
    expect(fireEvent.dragOver(cardOf('Gama'))).toBe(false)
    fireEvent.drop(cardOf('Gama'))
    // Vindo de cima, entra depois do alvo — já na tela, antes da resposta.
    expect(pinnedNames()).toEqual(['Gama', 'Delta', 'Alpha'])
    await settle()
    expect(putCalls(fetcher).map(([, init]: any[]) => JSON.parse(String(init.body)))).toEqual([{ projectIds: [3, 4, 1] }])
    expect(useStore.getState().triage[4]?.pinOrder).toBe(1)
    expect(useStore.getState().triage[3]?.pinOrder).toBe(0)
    expect(pinnedNames()).toEqual(['Gama', 'Delta', 'Alpha'])
    // O mesmo nó, com o mesmo rosto: mudou de lugar, não nasceu de novo.
    expect(cardOf('Delta')).toBe(delta)
    expect(delta.querySelector('[data-face]')).toBe(face)
  })

  it('falha ao gravar devolve a ordem de antes e avisa', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'falha' }), { status: 500 }))
    render(<><Sidebar /><UndoToast /></>)
    fireEvent.dragStart(cardOf('Alpha'))
    fireEvent.dragOver(cardOf('Delta'))
    fireEvent.drop(cardOf('Delta'))
    expect(pinnedNames()).toEqual(['Alpha', 'Delta', 'Gama'])
    await settle()
    expect(pinnedNames()).toEqual(['Delta', 'Gama', 'Alpha'])
    expect(useStore.getState().triage[1]?.pinOrder).toBe(2)
    expect(screen.getByRole('alert').textContent).toMatch(/ordem dos fixados/)
  })

  it('soltar entre Fixados e a árvore não faz nada, nos dois sentidos', async () => {
    const fetcher = okOrder()
    render(<Sidebar />)
    // Fixado sobre um cartão da árvore, sobre o grupo e no cabeçalho: nenhum aceita.
    fireEvent.dragStart(cardOf('Delta'))
    expect(fireEvent.dragOver(cardOf('Beta'))).toBe(true)
    fireEvent.drop(cardOf('Beta'))
    fireEvent.dragStart(cardOf('Delta'))
    expect(fireEvent.dragOver(screen.getByTestId('term-group'))).toBe(true)
    fireEvent.drop(screen.getByTestId('term-group'))
    fireEvent.dragEnd(cardOf('Delta'))
    // Cartão da árvore sobre um fixado: também não.
    fireEvent.dragStart(cardOf('Beta'))
    expect(fireEvent.dragOver(cardOf('Gama'))).toBe(true)
    fireEvent.drop(cardOf('Gama'))
    await settle()
    expect(fetcher.mock.calls.filter(([, init]: any[]) => init?.method === 'PUT')).toEqual([])
    expect(pinnedNames()).toEqual(['Delta', 'Gama', 'Alpha'])
    expect(within(tree()).getByText('Beta')).toBeTruthy()
  })

  it('quem não é admin também ordena os próprios Fixados (a árvore segue só do admin)', () => {
    useStore.setState({ me: { setupRequired: false, id: 2, username: 'ana', isAdmin: false } })
    render(<Sidebar />)
    expect(cardOf('Delta').draggable).toBe(true)
    expect(cardOf('Beta').draggable).toBe(false)
  })

  /** PATCH que responde como o servidor: fixar de novo usa o pinOrder do pedido, senão o fim. */
  const echoPatch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const id = Number(String(url).match(/projects\/(\d+)\/triage/)?.[1])
    const body = JSON.parse(String(init?.body ?? '{}'))
    const cur = useStore.getState().triage[id] ?? item(id, {})
    const pinned = body.pinned ?? (body.settled ? false : cur.pinned)
    return new Response(JSON.stringify(item(id, {
      pinned, settled: body.settled ?? false,
      pinOrder: pinned ? (cur.pinned ? cur.pinOrder : body.pinOrder === undefined ? 9 : body.pinOrder) : null,
    })), { status: 200 })
  })
  const patchBodies = (fetcher: ReturnType<typeof echoPatch>) =>
    fetcher.mock.calls.filter(([, init]: any[]) => init?.method === 'PATCH').map(([, init]: any[]) => JSON.parse(String(init.body)))

  it('desfazer o desafixar devolve o cartão à posição de antes', async () => {
    const fetcher = echoPatch()
    render(<><Sidebar /><UndoToast /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Desafixar Gama' }))
    await settle()
    expect(pinnedNames()).toEqual(['Delta', 'Alpha'])
    fireEvent.click(within(screen.getByTestId('undo-toast')).getByRole('button', { name: 'Desfazer' }))
    await settle()
    expect(pinnedNames()).toEqual(['Delta', 'Gama', 'Alpha'])
    expect(patchBodies(fetcher).at(-1)).toMatchObject({ pinned: true, pinOrder: 1 })
  })

  it('desfazer o assentar devolve o cartão à posição de antes', async () => {
    echoPatch()
    render(<Sidebar />)
    await act(() => applyTriage(3, { settled: true }, 'Gama assentado', null))
    expect(pinnedNames()).toEqual(['Delta', 'Alpha'])
    await act(() => undoTriage())
    expect(pinnedNames()).toEqual(['Delta', 'Gama', 'Alpha'])
  })

  it('"só fixados" ligado ainda deixa ordenar (a lista dos Fixados está inteira)', () => {
    localStorage.setItem('claudinei:favoritesOnly', '1')
    render(<Sidebar />)
    expect((screen.getByLabelText('Somente fixados') as HTMLInputElement).checked).toBe(true)
    expect(cardOf('Delta').draggable).toBe(true)
  })

  it('a resposta da ordem não passa por cima do que o WebSocket mudou no meio do caminho', async () => {
    let answer: (r: Response) => void = () => {}
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => { answer = r }))
    let done: Promise<void> = Promise.resolve()
    act(() => { done = reorderPins([3, 4, 1]) })
    expect(useStore.getState().triage[3]?.pinOrder).toBe(0)
    // Outro aparelho desafixou Gama enquanto a ordem ia e voltava.
    const woke = item(3, {})
    act(() => { useStore.getState().setTriageItem(woke) })
    answer(new Response(JSON.stringify([3, 4, 1].map((id, i) => item(id, { pinned: true, pinOrder: i }))), { status: 200 }))
    await act(() => done)
    expect(useStore.getState().triage[3]).toBe(woke)
    expect(useStore.getState().triage[4]?.pinOrder).toBe(1)
  })

  it('fixar põe o terminal no fim dos Fixados', async () => {
    let answer: (r: Response) => void = () => {}
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => { answer = r }))
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Fixar Beta' }))
    // Antes da resposta, já no fim.
    expect(pinnedNames()).toEqual(['Delta', 'Gama', 'Alpha', 'Beta'])
    answer(new Response(JSON.stringify(item(2, { pinned: true, pinOrder: 3 })), { status: 200 }))
    await settle()
    expect(pinnedNames()).toEqual(['Delta', 'Gama', 'Alpha', 'Beta'])
  })
})

// O erro de gravação da ⭐ aparece no canto do UndoToast (o desfazer: triage-actions.test.tsx).
describe('Sidebar — falha ao fixar', () => {
  it('erro de gravação devolve o cartão e avisa', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'falha' }), { status: 500 }))
    render(<><Sidebar /><UndoToast /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Fixar Beta' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível fixar/)
    expect(within(tree()).getByText('Beta')).toBeTruthy()
    expect(useStore.getState().triage[2]?.pinned ?? false).toBe(false)
  })
})
