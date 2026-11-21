import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { UsagePage } from '../components/UsagePage'
import { UsageCard } from '../components/UsageCard'
import { useUsageShortcut } from '../useUsageShortcut'
import { matchShortcut } from '../shortcuts/active'
import { useStore } from '../store'
import App from '../App'

const T = (input: number, output: number, cacheRead: number, cacheWrite: number, reasoning = 0) =>
  ({ input, output, cacheRead, cacheWrite, reasoning, spent: input + output + cacheWrite })

const IDLE = { running: false, filesDone: 10, filesTotal: 10, lastPassAt: '2026-11-20T10:00:00.000Z' }

function report(over: Record<string, unknown> = {}) {
  return {
    period: '7d',
    totals: T(1000, 2000, 6000, 1000),
    cachePct: 75,
    // Fora de ordem de propósito: a página ordena pelo gasto.
    terminals: [
      { projectIds: [], names: [], path: null, byEngine: { claude: T(100, 100, 0, 0) }, totals: T(100, 100, 0, 0) },
      { projectIds: [1, 2], names: ['Alfa', 'Beta'], path: '/a/alfa', byEngine: { claude: T(500, 1000, 0, 500), codex: T(200, 100, 0, 0) }, totals: T(700, 1100, 0, 500) },
      { projectIds: [3], names: ['Gama'], path: '/a/gama', byEngine: { codex: T(200, 600, 0, 0) }, totals: T(200, 600, 0, 0) },
    ],
    models: [
      { model: 'gpt-5-codex', engine: 'codex', totals: T(400, 700, 0, 0) },
      { model: 'claude-opus-4', engine: 'claude', totals: T(600, 1300, 0, 1000) },
    ],
    series: [
      { bucket: '2026-11-14', spent: 0, cacheRead: 0 },
      { bucket: '2026-11-15', spent: 4000, cacheRead: 6000 },
    ],
    oldestHour: '2026-01-01T00',
    index: IDLE,
    ...over,
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let reportBody: () => unknown
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  reportBody = () => report()
  fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/usage/report')) return json(reportBody())
    if (url === '/api/usage') return json({ limits: [{ kind: 'session', group: 'session', label: null, percent: 10, severity: 'normal', resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
    return json({ error: 'not_found' }, 404)
  })
  vi.stubGlobal('fetch', fetchSpy)
  useStore.setState({ view: 'dashboard', activeLocalId: undefined, sessions: {}, projects: [], engines: [] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const reportCalls = () => fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/usage/report'))

describe('UsagePage', () => {
  it('mostra totais, percentual do cache e as duas listas ordenadas', async () => {
    render(<UsagePage />)
    expect(await screen.findByText('75% da entrada veio do cache')).toBeTruthy()
    expect(reportCalls()[0]).toContain('period=7d')
    expect(reportCalls()[0]).toContain(`tz=${new Date().getTimezoneOffset()}`)
    // Gasto = entrada + saída + escrito no cache = 4000.
    expect(screen.getByTestId('usage-total-spent').textContent).toMatch(/4/)

    const terms = [...document.querySelectorAll('.usage-page__terminals .usage-page__row-name')].map((e) => e.textContent)
    expect(terms).toEqual(['Alfa / Beta', 'Gama', 'Fora do Claudinei'])
    const models = [...document.querySelectorAll('.usage-page__models .usage-page__row-name')].map((e) => e.textContent)
    expect(models).toEqual(['claude-opus-4', 'gpt-5-codex'])

    // Barra proporcional ao maior: o primeiro ocupa tudo.
    const first = document.querySelector('.usage-page__terminals .usage-page__bar') as HTMLElement
    const segs = [...first.querySelectorAll('.usage-page__seg')] as HTMLElement[]
    const total = segs.reduce((a, s) => a + parseFloat(s.style.width), 0)
    expect(Math.round(total)).toBe(100)
    expect(segs).toHaveLength(2) // divisão por motor
  })

  it('trocar o período refaz a busca com o período novo', async () => {
    render(<UsagePage />)
    await screen.findByText('75% da entrada veio do cache')
    reportBody = () => report({ period: '30d' })
    fireEvent.click(screen.getByRole('button', { name: '30 d' }))
    await waitFor(() => expect(reportCalls()).toHaveLength(2))
    expect(reportCalls()[1]).toContain('period=30d')
    expect(screen.getByRole('button', { name: '30 d' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('aviso de indexando aparece com running e some quando termina', async () => {
    vi.useFakeTimers()
    let running = true
    reportBody = () => report({ index: { running, filesDone: 3, filesTotal: 9, lastPassAt: null } })
    render(<UsagePage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('Indexando… 3 de 9 arquivos')).toBeTruthy()
    expect(reportCalls()).toHaveLength(1)

    running = false
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(reportCalls()).toHaveLength(2)
    expect(screen.queryByText(/Indexando…/)).toBeNull()

    // Terminou: não busca mais.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(reportCalls()).toHaveLength(2)
  })

  it('falha numa busca durante a indexação não congela o aviso: tenta de novo', async () => {
    vi.useFakeTimers()
    let falha = false
    let done = 3
    reportBody = () => report({ index: { running: true, filesDone: done, filesTotal: 9, lastPassAt: null } })
    const base = fetchSpy.getMockImplementation()!
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      falha && String(input).startsWith('/api/usage/report') ? json({ error: 'boom' }, 500) : base(input))
    const { unmount } = render(<UsagePage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('Indexando… 3 de 9 arquivos')).toBeTruthy()

    falha = true
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(reportCalls()).toHaveLength(2)

    // A busca seguinte volta a dar certo e o aviso anda; o erro some.
    falha = false
    done = 7
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(reportCalls()).toHaveLength(3)
    expect(screen.getByText('Indexando… 7 de 9 arquivos')).toBeTruthy()
    expect(document.querySelector('.usage-page__error')).toBeNull()

    // Sem sobreposição: um intervalo, uma busca; e desmontar para tudo.
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(reportCalls()).toHaveLength(3)
  })

  it('falha sem indexação em curso não refaz a busca', async () => {
    vi.useFakeTimers()
    const base = fetchSpy.getMockImplementation()!
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/usage/report') ? json({ error: 'boom' }, 500) : base(input))
    render(<UsagePage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(document.querySelector('.usage-page__error')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(reportCalls()).toHaveLength(1)
  })

  it('desmontar no meio da indexação para a recarga', async () => {
    vi.useFakeTimers()
    reportBody = () => report({ index: { running: true, filesDone: 1, filesTotal: 9, lastPassAt: null } })
    const { unmount } = render(<UsagePage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(reportCalls()).toHaveLength(1)
  })

  it('balde Fora do Claudinei usa o texto traduzido e não é clicável', async () => {
    render(<UsagePage />)
    const outside = await screen.findByText('Fora do Claudinei')
    expect(outside.closest('button')).toBeNull()
  })

  it('clicar num terminal abre a conversa mais recente do projeto', async () => {
    useStore.setState({
      sessions: {
        old: { localId: 'old', projectId: 2, status: 'idle', engineSessionId: null, updatedAt: '2026-11-01T00:00:00Z', engine: 'claude' },
        neu: { localId: 'neu', projectId: 1, status: 'idle', engineSessionId: null, updatedAt: '2026-11-19T00:00:00Z', engine: 'codex' },
      },
    } as never)
    render(<UsagePage />)
    fireEvent.click(await screen.findByRole('button', { name: /Alfa \/ Beta/ }))
    expect(useStore.getState().view).toBe('chat')
    expect(useStore.getState().activeLocalId).toBe('neu')
  })

  it('pasta compartilhada: sessão viva vence a morta mais recente', async () => {
    useStore.setState({
      sessions: {
        morta: { localId: 'morta', projectId: 1, status: 'dead', engineSessionId: null, updatedAt: '2026-11-19T00:00:00Z', engine: 'claude' },
        viva: { localId: 'viva', projectId: 2, status: 'working', engineSessionId: null, updatedAt: '2026-11-01T00:00:00Z', engine: 'claude' },
      },
    } as never)
    render(<UsagePage />)
    fireEvent.click(await screen.findByRole('button', { name: /Alfa \/ Beta/ }))
    expect(useStore.getState().view).toBe('chat')
    expect(useStore.getState().activeLocalId).toBe('viva')
  })

  it('só sessões paradas ou mortas: abre o painel', async () => {
    useStore.setState({
      view: 'usage',
      sessions: {
        parada: { localId: 'parada', projectId: 3, status: 'stopped', engineSessionId: null, updatedAt: '2026-11-19T00:00:00Z', engine: 'codex' },
      },
    } as never)
    render(<UsagePage />)
    fireEvent.click(await screen.findByRole('button', { name: /Gama/ }))
    expect(useStore.getState().view).toBe('dashboard')
    expect(useStore.getState().activeLocalId).toBeUndefined()
  })

  it('terminal sem sessão abre o painel', async () => {
    useStore.setState({ view: 'usage' } as never)
    render(<UsagePage />)
    fireEvent.click(await screen.findByRole('button', { name: /Gama/ }))
    expect(useStore.getState().view).toBe('dashboard')
  })

  it('aviso do histórico do Claude no período de 90 dias', async () => {
    render(<UsagePage />)
    await screen.findByText('75% da entrada veio do cache')
    expect(screen.queryByText(/O Claude apaga históricos/)).toBeNull()
    reportBody = () => report({ period: '90d' })
    fireEvent.click(screen.getByRole('button', { name: '90 d' }))
    expect(await screen.findByText('O Claude apaga históricos com mais de ~30 dias; os números mais antigos são os que o Claudinei já tinha indexado.')).toBeTruthy()
  })

  it('aviso do histórico quando o índice começa depois do início do período', async () => {
    reportBody = () => report({ oldestHour: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 13) })
    render(<UsagePage />)
    expect(await screen.findByText(/O Claude apaga históricos/)).toBeTruthy()
  })
})

function Harness({ enabled }: { enabled: boolean }) {
  useUsageShortcut(enabled)
  return <div><textarea aria-label="terminal" /><button type="button">fora</button></div>
}

describe('atalho Ctrl+U', () => {
  it('view.usage: Ctrl+U sem outro modificador', () => {
    const k = (init: KeyboardEventInit) => matchShortcut(new KeyboardEvent('keydown', init), 'view.usage')
    expect(k({ key: 'u', ctrlKey: true })).toBe(true)
    expect(k({ key: 'U', ctrlKey: true })).toBe(true)
    expect(k({ key: 'u', code: 'KeyU', ctrlKey: true })).toBe(true)
    expect(k({ key: 'U', code: 'KeyU', ctrlKey: true })).toBe(true)
    // Dvorak: a posição do U dá 'g'; Ctrl+G é do navegador (buscar o próximo), não da página.
    expect(k({ key: 'g', code: 'KeyU', ctrlKey: true })).toBe(false)
    expect(k({ key: 'é', code: 'KeyU', ctrlKey: true })).toBe(false)
    // Layouts sem letras latinas (cirílico, grego): vale a posição da tecla.
    expect(k({ key: 'г', code: 'KeyU', ctrlKey: true })).toBe(true)
    expect(k({ key: 'π', code: 'KeyU', ctrlKey: true })).toBe(true)
    // Dvorak: o 'u' fica noutra posição e continua valendo.
    expect(k({ key: 'u', code: 'KeyF', ctrlKey: true })).toBe(true)
    expect(k({ key: 'г', code: 'KeyP', ctrlKey: true })).toBe(false)
    expect(k({ key: 'u' })).toBe(false)
    expect(k({ key: 'u', ctrlKey: true, altKey: true })).toBe(false)
    expect(k({ key: 'u', ctrlKey: true, metaKey: true })).toBe(false)
  })

  it('Ctrl+U fora de campo abre a página e chama preventDefault', () => {
    render(<Harness enabled />)
    const notPrevented = fireEvent.keyDown(screen.getByText('fora'), { key: 'u', code: 'KeyU', ctrlKey: true })
    expect(notPrevented).toBe(false)
    expect(useStore.getState().view).toBe('usage')
  })

  it('Ctrl+U com foco num textarea (o do terminal) não faz nada e não chama preventDefault', () => {
    render(<Harness enabled />)
    const ta = screen.getByLabelText('terminal')
    ta.focus()
    const notPrevented = fireEvent.keyDown(ta, { key: 'u', code: 'KeyU', ctrlKey: true })
    expect(notPrevented).toBe(true)
    expect(useStore.getState().view).toBe('dashboard')
  })

  it('Ctrl+Shift+U não abre', () => {
    render(<Harness enabled />)
    const notPrevented = fireEvent.keyDown(document.body, { key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true })
    expect(notPrevented).toBe(true)
    expect(useStore.getState().view).toBe('dashboard')
  })

  it('hook desligado não reage', () => {
    render(<Harness enabled={false} />)
    const notPrevented = fireEvent.keyDown(document.body, { key: 'u', code: 'KeyU', ctrlKey: true })
    expect(notPrevented).toBe(true)
    expect(useStore.getState().view).toBe('dashboard')
  })
})

describe('atalho no App', () => {
  const bootWith = (me: Record<string, unknown>) => {
    const base = fetchSpy.getMockImplementation()!
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) =>
      String(input) === '/api/auth/me' ? json(me) : base(input))
    useStore.setState({ authStatus: 'ready', me: me as never, view: 'dashboard' })
  }

  it('não administrador não tem o atalho', async () => {
    bootWith({ setupRequired: false, id: 2, username: 'bia', isAdmin: false, projectIds: [] })
    render(<App />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/auth/me', expect.anything()))
    const notPrevented = fireEvent.keyDown(document.body, { key: 'u', code: 'KeyU', ctrlKey: true })
    expect(notPrevented).toBe(true)
    expect(useStore.getState().view).toBe('dashboard')
  })

  it('administrador abre a página com Ctrl+U', async () => {
    bootWith({ setupRequired: false, id: 1, username: 'ana', isAdmin: true, projectIds: [] })
    render(<App />)
    fireEvent.keyDown(document.body, { key: 'u', code: 'KeyU', ctrlKey: true })
    expect(useStore.getState().view).toBe('usage')
    expect(await screen.findByText('75% da entrada veio do cache')).toBeTruthy()
  })
})

describe('cartão Uso', () => {
  it('Ver detalhes no cartão Uso abre a página', async () => {
    render(<UsageCard />)
    // Antes da resposta o cartão já é o mínimo; espera o completo para clicar no botão que fica.
    await screen.findByText('Sessão atual')
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }))
    expect(useStore.getState().view).toBe('usage')
  })
})
