import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return {
    ...real,
    fetchAutoCompact: vi.fn(async () => ({ pct: 0 })),
    setTerminalRestart: vi.fn(),
    continueTerminal: vi.fn(async () => ({ ok: true })),
    dismissInterruption: vi.fn(async () => ({ ok: true })),
  }
})

import * as api from '../api'
import { InterruptedNotice } from '../components/InterruptedNotice'
import { SessionControls } from '../components/SessionControls'
import { MessageBlock } from '../components/MessageBlock'
import { useTerminalStatesSync } from '../useTerminalStatesSync'
import { WsContext } from '../wsContext'
import { useStore, progressKey } from '../store'
import type { ChatItem, SessionInfo, TerminalState } from '../types'

/**
 * Reinício sem prejuízo, na interface: os dois interruptores do ⚙, o aviso de
 * trabalho interrompido acima do campo e o cartão da mensagem de retomada. Ver
 * docs/superpowers/specs/2026-11-20-reinicio-sem-prejuizo-design.md.
 */
const RESUME_TEXT = '[Claudinei: resume after restart]: The Claudinei service restarted in the middle of your turn. Continue where you left off; check the current state of the files before redoing anything.'

const estado = (o: Partial<TerminalState> = {}): TerminalState =>
  ({ projectId: 1, engine: 'claude', autostart: false, autoResume: false, interruption: null, ...o })
const interrompido = (reason: NonNullable<TerminalState['interruption']>['reason'], extra: object = {}): TerminalState =>
  estado({ interruption: { at: '2026-11-20T10:00:00.000Z', reason, ...extra } })

const sess = (o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId: 's1', projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', model: 'opus', permissionMode: 'bypassPermissions', engine: 'claude', ...o })

const poe = (s: TerminalState) => useStore.setState({ terminalStates: { [progressKey(s.projectId, s.engine)]: s } })

beforeEach(() => {
  vi.mocked(api.setTerminalRestart).mockReset()
  vi.mocked(api.continueTerminal).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(api.dismissInterruption).mockReset().mockResolvedValue({ ok: true })
  useStore.setState({ terminalStates: {}, projects: [] })
})
afterEach(() => { cleanup() })

describe('cartão da mensagem do Claudinei', () => {
  it('cartão do Claudinei mostra o texto traduzido, não o inglês', () => {
    const item: ChatItem = { kind: 'claudinei_message', text: 'The Claudinei service restarted in the middle of your turn.' }
    const { container } = render(<MessageBlock item={item} />)
    expect(screen.getByText(/O serviço do Claudinei reiniciou no meio do seu turno/)).toBeTruthy()
    expect(screen.queryByText(/The Claudinei service restarted/)).toBeNull()
    expect(container.querySelector('.msg-bubble--claudinei')).toBeTruthy()
    expect(screen.queryByTitle(/editar/i)).toBeNull()
  })
})

describe('interruptores no ⚙', () => {
  const abre = (session: SessionInfo) => {
    render(<WsContext.Provider value={{ send: vi.fn() }}><SessionControls session={session} /></WsContext.Provider>)
    fireEvent.click(screen.getByTestId('session-controls-pill'))
  }

  it('interruptores chamam setTerminalRestart com o motor da aba', async () => {
    vi.mocked(api.setTerminalRestart).mockImplementation(async (projectId, engine, p) =>
      estado({ projectId, engine, autostart: p.autostart ?? false, autoResume: p.autoResume ?? false }))
    abre(sess({ engine: 'codex', model: '' }))
    const autostart = screen.getByLabelText('Iniciar com o Claudinei') as HTMLInputElement
    const autoResume = screen.getByLabelText('Retomar trabalho interrompido') as HTMLInputElement
    expect(autostart.checked).toBe(false)
    expect(autoResume.checked).toBe(false)
    fireEvent.click(autostart)
    await waitFor(() => expect(api.setTerminalRestart).toHaveBeenCalledWith(1, 'codex', { autostart: true }))
    await waitFor(() => expect((screen.getByLabelText('Iniciar com o Claudinei') as HTMLInputElement).checked).toBe(true))
    fireEvent.click(autoResume)
    await waitFor(() => expect(api.setTerminalRestart).toHaveBeenCalledWith(1, 'codex', { autoResume: true }))
  })

  it('mostram o estado do terminal e têm dica', () => {
    poe(estado({ autostart: true, autoResume: true }))
    abre(sess())
    const autostart = screen.getByLabelText('Iniciar com o Claudinei') as HTMLInputElement
    expect(autostart.checked).toBe(true)
    expect((screen.getByLabelText('Retomar trabalho interrompido') as HTMLInputElement).checked).toBe(true)
    expect(autostart.closest('label')?.getAttribute('title')).toBeTruthy()
  })

  it('erro ao salvar aparece no ⚙', async () => {
    vi.mocked(api.setTerminalRestart).mockRejectedValue(new Error('falhou de verdade'))
    abre(sess())
    fireEvent.click(screen.getByLabelText('Iniciar com o Claudinei'))
    expect(await screen.findByText(/falhou de verdade/)).toBeTruthy()
  })
})

describe('aviso de trabalho interrompido', () => {
  it('sem interrupção não desenha nada', () => {
    poe(estado())
    const { container } = render(<InterruptedNotice projectId={1} engine="claude" />)
    expect(container.innerHTML).toBe('')
  })

  it('aviso off mostra Continuar e chama continueTerminal', async () => {
    poe(interrompido('off'))
    render(<InterruptedNotice projectId={1} engine="claude" />)
    expect(screen.getByText('O trabalho foi interrompido pelo reinício do Claudinei.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    await waitFor(() => expect(api.continueTerminal).toHaveBeenCalledWith(1, 'claude'))
  })

  it('aviso question lista a pergunta perdida', () => {
    poe(interrompido('question', {
      question: [{ question: 'Qual banco usar?', header: 'Banco', options: [{ label: 'Postgres', description: '' }], multiSelect: false }],
    }))
    render(<InterruptedNotice projectId={1} engine="claude" />)
    expect(screen.getByText('O trabalho foi interrompido pelo reinício do Claudinei.')).toBeTruthy()
    expect(screen.getByText(/A pergunta abaixo se perdeu/)).toBeTruthy()
    expect(screen.getByText('Qual banco usar?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy()
  })

  it('aviso queued não tem botões', () => {
    poe(interrompido('queued'))
    render(<InterruptedNotice projectId={1} engine="claude" />)
    expect(screen.getByText('Retomando o trabalho interrompido…')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it.each([
    ['limit', 'Retomado 3 vezes sem concluir; esperando você.'],
    ['failed', 'Não foi possível retomar sozinho.'],
  ] as const)('aviso %s tem o texto próprio, Continuar e ×', (reason, texto) => {
    poe(interrompido(reason))
    render(<InterruptedNotice projectId={1} engine="claude" />)
    expect(screen.getByText(texto)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fechar aviso' })).toBeTruthy()
  })

  it('× chama dismissInterruption', async () => {
    poe(interrompido('off'))
    render(<InterruptedNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechar aviso' }))
    await waitFor(() => expect(api.dismissInterruption).toHaveBeenCalledWith(1, 'claude'))
    // O servidor não precisa responder pelo WebSocket para o aviso sair.
    await waitFor(() => expect(screen.queryByText(/interrompido pelo reinício/)).toBeNull())
  })

  it('Continuar que falha mostra o erro devolvido pela chamada e mantém o aviso', async () => {
    vi.mocked(api.continueTerminal).mockRejectedValue(new Error('CLI não encontrada'))
    poe(interrompido('off'))
    render(<InterruptedNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(await screen.findByText(/CLI não encontrada/)).toBeTruthy()
    expect(screen.getByText('O trabalho foi interrompido pelo reinício do Claudinei.')).toBeTruthy()
  })

  it('mensagem WS terminal_state atualiza o store e o aviso some quando interruption vira null', async () => {
    render(<InterruptedNotice projectId={1} engine="claude" />)
    expect(screen.queryByText(/interrompido pelo reinício/)).toBeNull()
    act(() => useStore.getState().applyWsMessage({ type: 'terminal_state', state: interrompido('off') }))
    expect(useStore.getState().terminalStates[progressKey(1, 'claude')]?.interruption?.reason).toBe('off')
    expect(screen.getByText('O trabalho foi interrompido pelo reinício do Claudinei.')).toBeTruthy()
    act(() => useStore.getState().applyWsMessage({ type: 'terminal_state', state: estado() }))
    expect(screen.queryByText(/interrompido pelo reinício/)).toBeNull()
  })

  it('Continuar sem nada a continuar (409) tira o aviso', async () => {
    vi.mocked(api.continueTerminal).mockRejectedValue(Object.assign(new Error('nada'), { code: 'nothing_to_continue', status: 409 }))
    poe(interrompido('off'))
    render(<InterruptedNotice projectId={1} engine="claude" />)
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    await waitFor(() => expect(screen.queryByText(/interrompido pelo reinício/)).toBeNull())
  })

  it('aviso é do terminal da aba: outro motor do mesmo projeto não o mostra', () => {
    poe(interrompido('off'))
    const { container } = render(<InterruptedNotice projectId={1} engine="codex" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('mensagem de retomada no chat', () => {
  it('o texto completo enviado pelo servidor vira o cartão traduzido', async () => {
    const { applyEvent } = await import('../chat/applyEvent')
    const items = applyEvent([], { kind: 'user', message: { role: 'user', content: RESUME_TEXT }, raw: {} })
    render(<>{items.map((it, i) => <MessageBlock key={i} item={it} />)}</>)
    expect(screen.getByText(/O serviço do Claudinei reiniciou/)).toBeTruthy()
  })
})

describe('leitura do estado (useTerminalStatesSync)', () => {
  const responde = (list: TerminalState[]) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  beforeEach(() => useStore.setState({ authStatus: 'ready', progressEpoch: 0 }))
  afterEach(() => { vi.restoreAllMocks(); useStore.setState({ authStatus: 'loading' }) })

  it('lê ao entrar e de novo a cada reconexão', async () => {
    const fetch = responde([interrompido('off')])
    renderHook(() => useTerminalStatesSync())
    await waitFor(() => expect(useStore.getState().terminalStates[progressKey(1, 'claude')]?.interruption?.reason).toBe('off'))
    expect(fetch).toHaveBeenCalledWith('/api/terminals/state', expect.anything())
    fetch.mockImplementation(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    act(() => useStore.getState().resyncOnReconnect())
    // Terminal que sumiu da lista voltou ao padrão.
    await waitFor(() => expect(useStore.getState().terminalStates[progressKey(1, 'claude')]).toBeUndefined())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('o que o WebSocket trouxe durante a leitura vence a resposta', async () => {
    let solta!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => { solta = r }))
    renderHook(() => useTerminalStatesSync())
    act(() => useStore.getState().applyWsMessage({ type: 'terminal_state', state: estado() }))
    await act(async () => {
      solta(new Response(JSON.stringify([interrompido('off')]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })
    await waitFor(() => expect(useStore.getState().terminalStates[progressKey(1, 'claude')]).toBeDefined())
    expect(useStore.getState().terminalStates[progressKey(1, 'claude')]?.interruption).toBeNull()
  })

  it('sem login não lê', () => {
    useStore.setState({ authStatus: 'login' })
    const fetch = responde([])
    renderHook(() => useTerminalStatesSync())
    expect(fetch).not.toHaveBeenCalled()
  })
})
