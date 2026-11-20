import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../speech/recorder', () => ({ micSupported: () => false, startMicCapture: vi.fn() }))

import { Sidebar } from '../components/Sidebar'
import { UndoToast } from '../components/UndoToast'
import { ChatInput } from '../components/ChatInput'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { applyTriage } from '../triageActions'
import { snoozeUntil } from '../triageSections'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta, Project, SessionInfo, TriageItem } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const project = (id: number, name: string): Project => ({ id, name, path: `/tmp/${id}`, icon: '📁', color: '#fff' })
const session = (localId: string, projectId: number, status: SessionInfo['status'], engine = 'claude'): SessionInfo =>
  ({ localId, projectId, status, engine, engineSessionId: 'c', updatedAt: 'x' })
const item = (projectId: number, patch: Partial<TriageItem> = {}): TriageItem =>
  ({ projectId, pinned: false, settled: false, snoozedUntil: null, ...patch })

// Sexta-feira, 20/11/2026, 14:00 no fuso do navegador.
const NOW = new Date(2026, 10, 20, 14, 0, 0, 0).getTime()

type Patch = { pinned?: boolean; settled?: boolean; snoozedUntil?: string | null }
/** O servidor de mentira: aplica as combinações na mesma ordem da rota de verdade. */
let server: Record<number, TriageItem> = {}
let failTriage = false
const patches: Array<{ projectId: number; body: Patch }> = []

const stubFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
  const m = /\/api\/projects\/(\d+)\/triage$/.exec(String(url))
  if (m && init?.method === 'PATCH') {
    const projectId = Number(m[1])
    const body = JSON.parse(String(init.body)) as Patch
    patches.push({ projectId, body })
    if (failTriage) return new Response(JSON.stringify({ error: 'falha' }), { status: 500 })
    const cur = { ...(server[projectId] ?? item(projectId)) }
    if (body.settled !== undefined) { cur.settled = body.settled; if (body.settled) { cur.pinned = false; cur.snoozedUntil = null } }
    if (body.snoozedUntil !== undefined) { cur.snoozedUntil = body.snoozedUntil; if (body.snoozedUntil !== null) cur.settled = false }
    if (body.pinned !== undefined) { cur.pinned = body.pinned; if (body.pinned) cur.settled = false }
    server[projectId] = cur
    return new Response(JSON.stringify(cur), { status: 200 })
  }
  const empty = String(url).includes('/actions') ? [] : {}
  return new Response(JSON.stringify(empty), { status: 200 })
})

/** Deixa as promessas (fetch, json, setState) andarem sem mexer no relógio falso. */
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) })

beforeEach(() => {
  localStorage.clear()
  // Adiados e Assentados abertos, para ver o cartão chegar lá.
  localStorage.setItem('claudinei:collapsedTriage', '[]')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(NOW)
  server = {}
  failTriage = false
  patches.length = 0
  useStore.setState({
    projects: [project(1, 'Alpha'), project(2, 'Beta')],
    groups: [], sectors: [], schedules: [],
    sessions: {
      a1: session('a1', 1, 'needs_attention'),
      a2: session('a2', 1, 'idle', 'codex'),
      a3: session('a3', 1, 'stopped', 'kimi'),
      b1: session('b1', 2, 'needs_attention'),
    },
    unread: { a1: 3, a2: 1, a3: 2, b1: 4 },
    triage: {},
    undo: null, triageError: null,
    chat: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined, railMode: false,
    engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'root', isAdmin: true },
  })
  stubFetch()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const renderApp = (extra: React.ReactNode = null) => {
  const send = vi.fn()
  render(
    <WsContext.Provider value={{ send }}>
      <Sidebar />
      <UndoToast />
      {extra}
    </WsContext.Provider>,
  )
  return send
}
/** Abre as três bolinhas do cartão de um terminal e devolve o popover. */
const openMenu = (name: string) => {
  const card = screen.getAllByTestId('term-card').find((c) => c.textContent?.includes(name)) as HTMLElement
  fireEvent.click(within(card).getByTitle('Opções'))
  return within(document.querySelector('.sess-pop') as HTMLElement)
}
const toast = () => screen.queryByTestId('undo-toast')
const ctrlZ = (target: Element = document.body, extra: Partial<KeyboardEventInit> = { ctrlKey: true }) =>
  fireEvent.keyDown(target, { key: 'z', code: 'KeyZ', ...extra })

describe('triagem pelo menu do cartão', () => {
  it('menu mostra Fixar/Assentar/Adiar e chama setTriage com o horário absoluto', async () => {
    renderApp()
    let pop = openMenu('Alpha')
    expect(pop.getByText('Fixar')).toBeTruthy()
    expect(pop.getByText('Assentar')).toBeTruthy()
    // O submenu só abre no clique, e "cancelar" só existe para quem está adiado.
    expect(pop.queryByText('Até amanhã às 9:00')).toBeNull()
    fireEvent.click(pop.getByText('Adiar'))
    expect(pop.getByText('1 h')).toBeTruthy()
    expect(pop.getByText('Até segunda às 9:00')).toBeTruthy()
    expect(pop.queryByText('Cancelar o adiamento')).toBeNull()
    fireEvent.click(pop.getByText('Até amanhã às 9:00'))
    await settle()

    // Sábado, 21/11, às 9:00 no fuso do navegador, mandado como horário absoluto.
    const tomorrow = new Date(2026, 10, 21, 9, 0, 0, 0)
    expect(snoozeUntil('tomorrow', new Date(NOW)).getTime()).toBe(tomorrow.getTime())
    expect(patches).toEqual([{ projectId: 1, body: { snoozedUntil: tomorrow.toISOString() } }])
    expect(document.querySelector('.sess-pop')).toBeNull()
    expect(within(screen.getByTestId('triage-snoozed')).getByText('Alpha')).toBeTruthy()

    // Adiado e fixado: o menu oferece Desafixar e o cancelamento do adiamento.
    act(() => { useStore.getState().setTriageItem(item(1, { pinned: true, snoozedUntil: tomorrow.toISOString() })) })
    pop = openMenu('Alpha')
    expect(pop.getByText('Desafixar')).toBeTruthy()
    fireEvent.click(pop.getByText('Adiar'))
    fireEvent.click(pop.getByText('Cancelar o adiamento'))
    await settle()
    expect(patches[1]).toEqual({ projectId: 1, body: { snoozedUntil: null } })

    // Assentado: "Tirar dos assentados".
    pop = openMenu('Beta')
    fireEvent.click(pop.getByText('Fixar'))
    await settle()
    expect(patches[2]).toEqual({ projectId: 2, body: { pinned: true } })
    act(() => { useStore.getState().setTriageItem(item(2, { settled: true })) })
    pop = openMenu('Beta')
    fireEvent.click(pop.getByText('Tirar dos assentados'))
    await settle()
    expect(patches[3]).toEqual({ projectId: 2, body: { settled: false } })
  })

  it('"1 h" conta de quando se clicou, não de quando o menu abriu', async () => {
    renderApp()
    const pop = openMenu('Alpha')
    fireEvent.click(pop.getByText('Adiar'))
    vi.setSystemTime(NOW + 600_000) // o menu ficou aberto 10 min
    fireEvent.click(pop.getByText('1 h'))
    await settle()
    expect(patches).toEqual([{ projectId: 1, body: { snoozedUntil: new Date(NOW + 600_000 + 3_600_000).toISOString() } }])
  })

  it('assentar marca como lido (unread zerado e mark_read enviado por sessão viva)', async () => {
    const send = renderApp()
    fireEvent.click(openMenu('Alpha').getByText('Assentar'))
    await settle()
    expect(patches).toEqual([{ projectId: 1, body: { settled: true } }])
    expect(useStore.getState().triage[1]).toEqual(item(1, { settled: true }))
    const { unread } = useStore.getState()
    expect([unread.a1, unread.a2, unread.a3]).toEqual([0, 0, 0])
    expect(unread.b1).toBe(4) // outro projeto: intocado
    // A sessão parada não está viva: nada a marcar no servidor.
    expect(send.mock.calls.map(([m]) => m)).toEqual([
      { type: 'mark_read', localId: 'a1' },
      { type: 'mark_read', localId: 'a2' },
    ])

    // Adiar também marca; fixar não.
    send.mockClear()
    await act(() => applyTriage(2, { pinned: true }, 'Beta fixado', { send }))
    expect(send).not.toHaveBeenCalled()
    expect(useStore.getState().unread.b1).toBe(4)
    await act(() => applyTriage(2, { snoozedUntil: new Date(NOW + 3_600_000).toISOString() }, 'Beta adiado', { send }))
    expect(send.mock.calls.map(([m]) => m)).toEqual([{ type: 'mark_read', localId: 'b1' }])
    expect(useStore.getState().unread.b1).toBe(0)
  })

  it('Desfazer no aviso restaura o estado anterior', async () => {
    useStore.setState({ triage: { 1: item(1, { pinned: true }) } })
    server = { 1: item(1, { pinned: true }) }
    renderApp()
    fireEvent.click(openMenu('Alpha').getByText('Assentar'))
    await settle()
    // Assentar tirou o pin.
    expect(useStore.getState().triage[1]).toEqual(item(1, { settled: true }))
    expect(within(screen.getByTestId('triage-settled')).getByText('Alpha')).toBeTruthy()
    expect(toast()?.textContent).toContain('Alpha assentado')

    fireEvent.click(within(toast() as HTMLElement).getByRole('button', { name: 'Desfazer' }))
    await settle()
    // Volta os três campos, inclusive o pin que o assentar tinha tirado.
    expect(patches[1]).toEqual({ projectId: 1, body: { pinned: true, settled: false, snoozedUntil: null } })
    expect(useStore.getState().triage[1]).toEqual(item(1, { pinned: true }))
    expect(within(screen.getByTestId('triage-pinned')).getByText('Alpha')).toBeTruthy()
    expect(toast()).toBeNull()
    expect(useStore.getState().undo).toBeNull()
  })

  it('a ⭐ também entra no desfazer', async () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Fixar Beta' }))
    await settle()
    expect(useStore.getState().triage[2]?.pinned).toBe(true)
    expect(toast()?.textContent).toContain('Beta fixado')
    ctrlZ()
    await settle()
    expect(patches.at(-1)).toEqual({ projectId: 2, body: { pinned: false, settled: false, snoozedUntil: null } })
    expect(useStore.getState().triage[2]?.pinned).toBe(false)
  })

  it('Ctrl+Z desfaz em até 5 s; depois de 5 s não faz nada', async () => {
    renderApp()
    fireEvent.click(openMenu('Alpha').getByText('Assentar'))
    await settle()
    act(() => { vi.advanceTimersByTime(4_900) })
    expect(toast()).toBeTruthy()
    expect(ctrlZ()).toBe(false) // false = preventDefault
    await settle()
    expect(patches).toHaveLength(2)
    expect(useStore.getState().triage[1]).toEqual(item(1))
    // O desfazer não se desfaz: sem entrada nova, o segundo Ctrl+Z não é nosso.
    expect(ctrlZ()).toBe(true)
    await settle()
    expect(patches).toHaveLength(2)

    // Cmd+Z (Mac) vale o mesmo; passados os 5 s, o aviso some e o atalho volta a ser do navegador.
    fireEvent.click(openMenu('Beta').getByText('Assentar'))
    await settle()
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(toast()).toBeNull()
    expect(ctrlZ(document.body, { metaKey: true })).toBe(true)
    await settle()
    expect(patches).toHaveLength(3)
    expect(useStore.getState().triage[2]).toEqual(item(2, { settled: true }))
  })

  it('Ctrl+Z com foco no campo do chat, na busca ou no terminal não desfaz a triagem', async () => {
    renderApp(
      <>
        <ChatInput localId="a1" disabled={false} />
        {/* O DOM do xterm: o teclado do terminal entra por esta textarea escondida. */}
        <div className="xterm"><textarea className="xterm-helper-textarea" aria-label="Terminal input" /></div>
      </>,
    )
    fireEvent.click(openMenu('Alpha').getByText('Assentar'))
    await settle()
    const chat = screen.getByPlaceholderText(/Mensagem para o Claude/)
    const search = screen.getByRole('searchbox', { name: 'Buscar terminais' })
    const terminal = screen.getByLabelText('Terminal input')
    for (const field of [chat, search, terminal]) {
      field.focus()
      expect(ctrlZ(field), field.tagName).toBe(true) // o desfazer do próprio campo segue
      await settle()
    }
    expect(patches).toHaveLength(1)
    expect(useStore.getState().triage[1]).toEqual(item(1, { settled: true }))
    // Fora dos campos, o mesmo atalho desfaz.
    ctrlZ(document.body)
    await settle()
    expect(useStore.getState().triage[1]).toEqual(item(1))
  })

  it('falha da rota volta o estado e mostra o aviso', async () => {
    useStore.setState({ triage: { 1: item(1, { pinned: true }) } })
    failTriage = true
    const send = renderApp()
    fireEvent.click(openMenu('Alpha').getByText('Assentar'))
    await settle()
    expect(useStore.getState().triage[1]).toEqual(item(1, { pinned: true }))
    expect(within(screen.getByTestId('triage-pinned')).getByText('Alpha')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível mudar a triagem/)
    // Nada a desfazer, e o terminal não foi marcado como lido.
    expect(toast()).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(useStore.getState().unread.a1).toBe(3)

    // A próxima ação que dá certo tira o aviso.
    failTriage = false
    fireEvent.click(openMenu('Alpha').getByText('Desafixar'))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
