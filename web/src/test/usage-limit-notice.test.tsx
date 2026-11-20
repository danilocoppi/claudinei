import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Profiler } from 'react'
import { render, cleanup, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return {
    ...real,
    fetchAutoCompact: vi.fn(async () => ({ pct: 0 })),
    setTerminalRestart: vi.fn(),
    usageLimitAction: vi.fn(),
  }
})

import * as api from '../api'
import { UsageLimitNotice, formatLimitTime } from '../components/UsageLimitNotice'
import { SessionControls } from '../components/SessionControls'
import { MessageBlock } from '../components/MessageBlock'
import { Sidebar } from '../components/Sidebar'
import { WsContext } from '../wsContext'
import { useStore, progressKey } from '../store'
import type { ChatItem, SessionInfo, TerminalState } from '../types'

/**
 * Bateu o limite, na interface: o aviso acima do campo, a marca do cartão da
 * lateral, o interruptor do ⚙ e o cartão da mensagem de retomada. Ver
 * docs/superpowers/specs/2026-11-20-bateu-o-limite-design.md.
 */

// Hora local: o teste vale em qualquer fuso. "Agora" é 12:50; a janela reabre às 15:00.
const AGORA = new Date(2026, 10, 20, 12, 50, 0)
const REABRE = new Date(2026, 10, 20, 15, 0, 0).getTime() / 1000 // epoch SEGUNDOS

type Limite = NonNullable<TerminalState['usageLimit']>
const estado = (o: Partial<TerminalState> = {}): TerminalState => ({
  projectId: 1, engine: 'claude', autostart: false, autoResume: false, interruption: null,
  autoResumeLimit: false, usageLimit: null, ...o,
})
const limitado = (o: Partial<Limite> = {}, extra: Partial<TerminalState> = {}): TerminalState =>
  estado({ usageLimit: { hitAt: '2026-11-20 15:50:00', resetsAt: REABRE, action: 'none', origin: 'operator', ...o }, ...extra })

const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', model: 'opus', permissionMode: 'bypassPermissions', engine: 'claude', ...o })

const poe = (s: TerminalState) => useStore.setState({ terminalStates: { [progressKey(s.projectId, s.engine)]: s } })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(AGORA)
  vi.mocked(api.setTerminalRestart).mockReset()
  vi.mocked(api.usageLimitAction).mockReset()
  useStore.setState({ terminalStates: {}, projects: [] })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('cartão da mensagem do Claudinei', () => {
  it('cartão do Claudinei do limite mostra o texto traduzido', () => {
    const item: ChatItem = { kind: 'claudinei_message', reason: 'limit', text: 'The usage limit window reopened.' }
    const { container } = render(<MessageBlock item={item} />)
    expect(screen.getByText(/A janela do limite de uso reabriu/)).toBeTruthy()
    expect(screen.queryByText(/The usage limit window reopened/)).toBeNull()
    expect(screen.queryByText(/reiniciou no meio do seu turno/)).toBeNull()
    expect(container.querySelector('.msg-bubble--claudinei')).toBeTruthy()
  })

  it('o do reinício segue com o próprio texto', () => {
    render(<MessageBlock item={{ kind: 'claudinei_message', reason: 'restart', text: 'x' }} />)
    expect(screen.getByText(/O serviço do Claudinei reiniciou/)).toBeTruthy()
  })

  it('o texto completo enviado pelo servidor vira o cartão do limite', async () => {
    const { applyEvent } = await import('../chat/applyEvent')
    const text = '[Claudinei: resume after usage limit]: The usage limit window reopened. Continue where you left off; check the current state of the files before redoing anything.'
    const items = applyEvent([], { kind: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, raw: {} })
    render(<>{items.map((it, i) => <MessageBlock key={i} item={it} />)}</>)
    expect(screen.getByText(/A janela do limite de uso reabriu/)).toBeTruthy()
  })
})

describe('hora da reabertura', () => {
  it('24 h no pt-BR e no es; no en, o formato do idioma', () => {
    const tarde = new Date(2026, 10, 20, 15, 5, 0).getTime() / 1000
    expect(formatLimitTime(tarde, 'pt-BR')).toBe('15:05')
    expect(formatLimitTime(tarde, 'es')).toBe('15:05')
    expect(formatLimitTime(tarde, 'en')).toMatch(/^3:05\sPM$/)
  })
})

describe('aviso do limite de uso', () => {
  it('sem limite não desenha nada', () => {
    poe(estado())
    const { container } = render(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(container.innerHTML).toBe('')
  })

  it('aviso com horário: três botões e ×; cada um chama usageLimitAction com a ação certa', async () => {
    vi.mocked(api.usageLimitAction).mockImplementation(async () => limitado())
    poe(limitado())
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(screen.getByText('O Claude bateu no limite de uso. A janela reabre às 15:00 (daqui a 2 h 10 min).')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(4)
    const casos = [
      ['Continuar quando reabrir', 'arm'],
      ['Adiar até reabrir', 'snooze'],
      ['Continuar agora', 'continue'],
      ['Fechar aviso', 'cancel'],
    ] as const
    for (const [nome, acao] of casos) {
      fireEvent.click(screen.getByRole('button', { name: nome }))
      await waitFor(() => expect(api.usageLimitAction).toHaveBeenLastCalledWith(1, 'claude', acao))
      await waitFor(() => expect((screen.getByRole('button', { name: nome }) as HTMLButtonElement).disabled).toBe(false))
    }
  })

  it('o × tira o aviso sem esperar o WebSocket', async () => {
    vi.mocked(api.usageLimitAction).mockResolvedValue(estado())
    poe(limitado())
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechar aviso' }))
    await waitFor(() => expect(screen.queryByText(/bateu no limite/)).toBeNull())
  })

  it('aviso sem horário: só Continuar agora e ×', () => {
    poe(limitado({ resetsAt: null }))
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(screen.getByText('O Claude bateu no limite de uso.')).toBeTruthy()
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent))
      .toEqual(['Fechar aviso', 'Continuar agora'])
  })

  it('horário que já passou vale como desconhecido: só Continuar agora e ×', () => {
    poe(limitado({ resetsAt: AGORA.getTime() / 1000 - 60 }))
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(screen.getByText('O Claude bateu no limite de uso.')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('armado: mostra a hora e Cancelar', async () => {
    vi.mocked(api.usageLimitAction).mockResolvedValue(limitado())
    poe(limitado({ action: 'armed' }))
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    // A retomada sai 60 s depois da reabertura.
    expect(screen.getByText('Retomada armada para 15:01')).toBeTruthy()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancelar', 'Continuar agora'])
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(api.usageLimitAction).toHaveBeenCalledWith(1, 'claude', 'cancel'))
    // Cancelar volta ao aviso, com as opções de novo.
    expect(await screen.findByRole('button', { name: 'Continuar quando reabrir' })).toBeTruthy()
  })

  it('snoozed: sem aviso', () => {
    poe(limitado({ action: 'snoozed' }))
    const { container } = render(<UsageLimitNotice projectId={1} engine="claude" />)
    expect(container.innerHTML).toBe('')
  })

  it('erro da ação aparece no aviso', async () => {
    const real = await vi.importActual<typeof import('../api')>('../api')
    vi.mocked(api.usageLimitAction).mockImplementation(real.usageLimitAction)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'sessão está trabalhando; aguarde o turno terminar', code: 'session_busy' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ))
    poe(limitado())
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continuar agora' }))
    expect(await screen.findByText('A sessão está trabalhando; aguarde o turno terminar.')).toBeTruthy()
    expect(screen.getByText(/bateu no limite/)).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/api/projects/1/terminals/claude/limit',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'continue' }) }))
  })

  it('sem limite para agir (409) tira o aviso', async () => {
    vi.mocked(api.usageLimitAction).mockRejectedValue(Object.assign(new Error('nada'), { code: 'no_usage_limit', status: 409 }))
    poe(limitado())
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continuar agora' }))
    await waitFor(() => expect(screen.queryByText(/bateu no limite/)).toBeNull())
  })

  it('mensagem WS terminal_state traz e tira o aviso', () => {
    render(<UsageLimitNotice projectId={1} engine="claude" />)
    act(() => useStore.getState().applyWsMessage({ type: 'terminal_state', state: limitado() }))
    expect(screen.getByText(/bateu no limite/)).toBeTruthy()
    act(() => useStore.getState().applyWsMessage({ type: 'terminal_state', state: estado() }))
    expect(screen.queryByText(/bateu no limite/)).toBeNull()
  })
})

describe('interruptor no ⚙', () => {
  const abre = (session: SessionInfo) => {
    render(<WsContext.Provider value={{ send: vi.fn() }}><SessionControls session={session} /></WsContext.Provider>)
    fireEvent.click(screen.getByTestId('session-controls-pill'))
  }
  const ROTULO = 'Continuar sozinho quando o limite reabrir'

  it('interruptor só no Claude; chama setTerminalRestart com autoResumeLimit', async () => {
    vi.mocked(api.setTerminalRestart).mockImplementation(async (projectId, engine, p) =>
      estado({ projectId, engine, autoResumeLimit: p.autoResumeLimit ?? false }))
    abre(sess())
    const sw = screen.getByLabelText(ROTULO) as HTMLInputElement
    expect(sw.checked).toBe(false)
    expect(sw.closest('label')?.getAttribute('title')).toBeTruthy()
    fireEvent.click(sw)
    await waitFor(() => expect(api.setTerminalRestart).toHaveBeenCalledWith(1, 'claude', { autoResumeLimit: true }))
    await waitFor(() => expect((screen.getByLabelText(ROTULO) as HTMLInputElement).checked).toBe(true))
    cleanup()
    abre(sess({ engine: 'codex', model: '' }))
    expect(screen.queryByLabelText(ROTULO)).toBeNull()
  })
})

describe('marca no cartão da lateral', () => {
  const projetos = () => useStore.setState({
    projects: [
      { id: 1, name: 'Alpha', path: '/tmp/a', color: '#ff0000', icon: '📁' },
      { id: 2, name: 'Beta', path: '/tmp/b', color: '#00ff00', icon: '📁' },
    ],
    groups: [], sectors: [], schedules: [],
    sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', activeLocalId: undefined,
  })
  const cartao = (nome: string) => screen.getAllByTestId('term-card').find((c) => within(c).queryByText(nome))!
  beforeEach(() => {
    projetos()
    localStorage.removeItem('claudinei:collapsedCards')
  })

  it('snoozed: marca no cartão com a hora; o outro cartão sem marca', () => {
    poe(limitado({ action: 'snoozed' }))
    render(<Sidebar />)
    const marca = within(cartao('Alpha')).getByTestId('limit-marker')
    expect(marca.textContent).toBe('limite até 15:00')
    expect(marca.getAttribute('title')).toBe('limite até 15:00')
    expect(within(cartao('Beta')).queryByTestId('limit-marker')).toBeNull()
  })

  it.each([
    // Em none, sem hora sempre: a marca não se atualiza quando a janela reabre (R11).
    ['none com hora', { action: 'none' as const }, 'limite de uso'],
    ['none sem hora', { action: 'none' as const, resetsAt: null }, 'limite de uso'],
    ['armado', { action: 'armed' as const }, 'retoma às 15:01'],
  ])('%s: %s', (_nome, o, texto) => {
    poe(limitado(o))
    render(<Sidebar />)
    expect(within(cartao('Alpha')).getByTestId('limit-marker').textContent).toBe(texto)
  })

  it('marca não redesenha a lateral em mudanças sem relação', () => {
    let commits = 0
    render(<Profiler id="lateral" onRender={() => { commits++ }}><Sidebar /></Profiler>)
    expect(screen.queryByTestId('limit-marker')).toBeNull()

    act(() => useStore.getState().setTerminalState(limitado()))
    expect(within(cartao('Alpha')).getByTestId('limit-marker').textContent).toBe('limite de uso')

    const antes = commits
    // Interruptor, origem, hora do bate e (em none) a reabertura mudados; outro
    // terminal mudado: a marca continua a mesma.
    act(() => useStore.getState().setTerminalState(limitado({ origin: 'schedule', hitAt: '2026-11-20 15:51:00' }, { autoResumeLimit: true })))
    act(() => useStore.getState().setTerminalState(limitado({ origin: 'schedule', resetsAt: REABRE + 3600 }, { autoResumeLimit: true })))
    act(() => useStore.getState().setTerminalState(estado({ projectId: 2, autostart: true })))
    expect(commits).toBe(antes)

    act(() => useStore.getState().setTerminalState(limitado({ action: 'armed' })))
    expect(within(cartao('Alpha')).getByTestId('limit-marker').textContent).toBe('retoma às 15:01')

    act(() => useStore.getState().setTerminalState(estado()))
    expect(screen.queryByTestId('limit-marker')).toBeNull()
  })
})
