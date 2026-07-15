import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { ChatView } from '../components/ChatView'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo, ClaudeEvent } from '../types'

const sess = (localId: string, overrides: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId: 1, status: 'needs_attention', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...overrides })

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: '✳',
  models: ['', 'fable', 'opus', 'sonnet', 'haiku'], efforts: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  permissions: ['bypassPermissions', 'default', 'auto', 'acceptEdits', 'plan'], slashSource: 'protocol', slashCommands: [],
}
const CODEX: EngineMeta = {
  id: 'codex', label: 'Codex', icon: '◆',
  models: ['', 'gpt-5.6-sol'], efforts: ['low', 'medium', 'high', 'xhigh'], permissions: [],
  slashSource: 'curated', slashCommands: ['model', 'approvals', 'init', 'compact', 'review', 'diff', 'mcp', 'undo'],
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  useStore.setState({
    projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁' }],
    sessions: { a: sess('a'), b: sess('b') },
    chat: { a: [], b: [] },
    unread: {},
    streaming: {},
    historyLoadedFor: {},
    view: 'chat',
    activeLocalId: 'a',
    engines: [CLAUDE, CODEX],
  })
})

afterEach(() => cleanup())

it('troca entre duas sessões needs_attention envia mark_read para a segunda', async () => {
  const send = vi.fn()
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  )
  const { rerender } = render(
    <WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>,
  )
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'mark_read', localId: 'a' }))
  useStore.setState({ activeLocalId: 'b' })
  rerender(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'mark_read', localId: 'b' }))
  spy.mockRestore()
})

it('mostra "Abrir no terminal" quando idle e ao clicar abre a view de terminal', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  useStore.setState({ sessions: { a: sess('a', { status: 'idle' }) }, activeLocalId: 'a', view: 'chat' })
  render(<ChatView />)
  fireEvent.click(await screen.findByText(/Abrir no terminal/i))
  await vi.waitFor(() => expect(useStore.getState().view).toBe('terminal'))
  expect(useStore.getState().activeLocalId).toBe('a')
  spy.mockRestore()
})

it('durante working o botão "Abrir no terminal" fica habilitado mas abre um diálogo de confirmação em vez de ir direto', async () => {
  useStore.setState({ sessions: { a: sess('a', { status: 'working' }), b: sess('b') } })
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
  const btn = screen.getByText(/Abrir no terminal/i, { selector: 'button' }) as HTMLButtonElement
  expect(btn.disabled).toBe(false)
  fireEvent.click(btn)
  expect(screen.getByText('O turno em andamento será interrompido para abrir esta conversa no terminal.')).toBeTruthy()
  expect(useStore.getState().view).toBe('chat')
  spy.mockRestore()
})

it('durante working o campo NÃO fica desabilitado (adendo/enfileirar) e o Enviar dispara', async () => {
  useStore.setState({ sessions: { a: sess('a', { status: 'working' }) }, activeLocalId: 'a', view: 'chat' })
  const send = vi.fn()
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  render(<WsContext.Provider value={{ send }}><ChatView /></WsContext.Provider>)
  const ta = screen.getByPlaceholderText(/processando|Mensagem para o Claude/) as HTMLTextAreaElement
  expect(ta.disabled).toBe(false)
  fireEvent.change(ta, { target: { value: 'adendo no meio' } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 'a', text: 'adendo no meio' })
  spy.mockRestore()
})

it('sessão parada (stopped) mantém o campo desabilitado', () => {
  useStore.setState({ sessions: { a: sess('a', { status: 'stopped' }) }, activeLocalId: 'a', view: 'chat' })
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
  const ta = screen.queryByPlaceholderText(/Mensagem para o Claude|processando/) as HTMLTextAreaElement | null
  if (ta) expect(ta.disabled).toBe(true)
  spy.mockRestore()
})

it('quando status é in_terminal, mostra o aviso e esconde a entrada de mensagem', async () => {
  useStore.setState({ sessions: { a: sess('a', { status: 'in_terminal' }), b: sess('b') } })
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)

  expect(await screen.findByText(/aberta no terminal/)).toBeTruthy()
  expect(screen.queryByPlaceholderText('Mensagem para o Claude Code…')).toBeNull()
  expect(screen.queryByText('Enviar')).toBeNull()
  const btn = screen.getByText(/Abrir no terminal/i, { selector: 'button' }) as HTMLButtonElement
  expect(btn.disabled).toBe(true)
  expect(btn.title).toBe('Disponível quando a sessão estiver ativa.')
  spy.mockRestore()
})

describe('D4: carrega conversa anterior ao abrir/retomar sessão', () => {
  const events: ClaudeEvent[] = [
    { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'oi, sou eu de volta' }] }, raw: {} },
  ]

  it('carrega histórico quando a sessão ativa tem engineSessionId e o chat está vazio', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/history')) return Promise.resolve(jsonResponse(events))
      return Promise.resolve(jsonResponse([]))
    })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)

    expect(await screen.findByText('oi, sou eu de volta')).toBeTruthy()
    expect(spy.mock.calls.some((c) => c[0] === '/api/sessions/a/history')).toBe(true)
    expect(useStore.getState().historyLoadedFor['a']).toBe('c')
    spy.mockRestore()
  })

  it('recarrega o histórico quando o engineSessionId muda (retomada)', async () => {
    useStore.setState({
      chat: { a: [{ kind: 'assistant_text', text: 'texto antigo, de outra sessão' }] },
      historyLoadedFor: { a: 'c' },
    })
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/history')) return Promise.resolve(jsonResponse(events))
      return Promise.resolve(jsonResponse([]))
    })
    const { rerender } = render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)

    // ainda não deve recarregar: mesmo engineSessionId já carregado
    await new Promise((r) => setTimeout(r, 0))
    expect(spy.mock.calls.some((c) => c[0] === '/api/sessions/a/history')).toBe(false)

    useStore.setState({ sessions: { a: sess('a', { engineSessionId: 'c2' }), b: sess('b') } })
    rerender(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)

    expect(await screen.findByText('oi, sou eu de volta')).toBeTruthy()
    expect(useStore.getState().historyLoadedFor['a']).toBe('c2')
    spy.mockRestore()
  })
})

describe('item 20: preview de streaming token-a-token (efêmero, fora do chat[])', () => {
  it('mostra o texto parcial de streaming[activeLocalId] quando presente', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    useStore.setState({ streaming: { a: 'respondendo aos pouc' } })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)

    expect(await screen.findByText(/respondendo aos pouc/)).toBeTruthy()
    spy.mockRestore()
  })

  it('não mostra nada quando streaming[activeLocalId] está vazio ou ausente', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    await new Promise((r) => setTimeout(r, 0))

    expect(screen.queryByTestId('streaming-preview')).toBeNull()
    spy.mockRestore()
  })

  it('some quando streaming[activeLocalId] é limpo (turno terminou)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    useStore.setState({ streaming: { a: 'meio caminho' } })
    render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    expect(await screen.findByText(/meio caminho/)).toBeTruthy()

    useStore.setState({ streaming: { a: '' } })
    await vi.waitFor(() => expect(screen.queryByTestId('streaming-preview')).toBeNull())
    spy.mockRestore()
  })
})

it('sessão nova em starting (sem engineSessionId) busca e mostra o preview da conversa anterior', async () => {
  const previewEvents: ClaudeEvent[] = [
    { kind: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'conversa anterior da pasta' }] }, raw: {} },
  ]
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse(previewEvents)))
  useStore.setState({
    sessions: { a: sess('a', { status: 'starting', engineSessionId: null }) },
    activeLocalId: 'a', view: 'chat',
  })
  render(<ChatView />)
  expect(await screen.findByText(/conversa anterior da pasta/)).toBeTruthy()
  expect(spy).toHaveBeenCalledWith('/api/sessions/a/history', expect.anything())
  spy.mockRestore()
})

describe('abas de engine no header (engine-tabs)', () => {
  it('mostra uma aba por engine registrada; a aba da engine da sessão aberta fica ativa', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    render(<ChatView />)
    await vi.waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy())
    const tabs = document.querySelectorAll('.engine-tab')
    expect(tabs.length).toBe(2)
    const claudeTab = Array.from(tabs).find((el) => el.textContent?.includes('Claude Code'))!
    const codexTab = Array.from(tabs).find((el) => el.textContent?.includes('Codex'))!
    expect(claudeTab.className).toContain('active')
    expect(codexTab.className).not.toContain('active')
    // sessão 'a' (aberta) está needs_attention; a engine Codex não tem sessão no projeto
    expect(claudeTab.querySelector('.engine-tab__status')?.textContent).toBe('aguardando você')
    expect(codexTab.querySelector('.engine-tab__status')?.textContent).toBe('sem sessão')
    spy.mockRestore()
  })

  it('sessão Codex aberta ativa a aba Codex, não a Claude', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    useStore.setState({ sessions: { a: sess('a', { engine: 'codex' }), b: sess('b') } })
    render(<ChatView />)
    await vi.waitFor(() => expect(screen.getByText('Codex')).toBeTruthy())
    const tabs = document.querySelectorAll('.engine-tab')
    const claudeTab = Array.from(tabs).find((el) => el.textContent?.includes('Claude Code'))!
    const codexTab = Array.from(tabs).find((el) => el.textContent?.includes('Codex'))!
    expect(codexTab.className).toContain('active')
    expect(claudeTab.className).not.toContain('active')
    spy.mockRestore()
  })

  it('clicar numa aba com sessão viva abre aquela sessão (openSession)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    useStore.setState({
      sessions: {
        a: sess('a', { engine: 'claude' }),
        c: sess('c', { engine: 'codex', status: 'idle' }),
      },
    })
    render(<ChatView />)
    const codexTab = await screen.findByText('Codex')
    fireEvent.click(codexTab.closest('.engine-tab__main')!)
    await vi.waitFor(() => expect(useStore.getState().activeLocalId).toBe('c'))
    spy.mockRestore()
  })

  it('▶ numa engine sem sessão inicia uma sessão nova com essa engine e a abre', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const u = String(url)
      if (u.includes('/history')) return Promise.resolve(jsonResponse([]))
      if (u === '/api/projects/1/sessions') {
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({ engine: 'codex' })
        return Promise.resolve(jsonResponse({ localId: 'novo-codex', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x', engine: 'codex' }))
      }
      return Promise.resolve(jsonResponse([]))
    })
    render(<ChatView />)
    const codexTab = (await screen.findByText('Codex')).closest('.engine-tab')!
    fireEvent.click(codexTab.querySelector('.engine-tab__play')!)
    await vi.waitFor(() => expect(useStore.getState().activeLocalId).toBe('novo-codex'))
    spy.mockRestore()
  })

  it('▶ numa engine com sessão stopped/dead revive essa sessão em vez de iniciar outra', async () => {
    useStore.setState({
      sessions: {
        a: sess('a', { engine: 'claude' }),
        c: sess('c', { engine: 'codex', status: 'stopped' }),
      },
    })
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url)
      if (u.includes('/history')) return Promise.resolve(jsonResponse([]))
      if (u === '/api/sessions/c/revive') return Promise.resolve(jsonResponse({ localId: 'c', projectId: 1, status: 'starting', engineSessionId: null, updatedAt: 'x', engine: 'codex' }))
      return Promise.resolve(jsonResponse([]))
    })
    render(<ChatView />)
    const codexTab = (await screen.findByText('Codex')).closest('.engine-tab')!
    fireEvent.click(codexTab.querySelector('.engine-tab__play')!)
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('/api/sessions/c/revive', expect.objectContaining({ method: 'POST' })))
    await vi.waitFor(() => expect(useStore.getState().activeLocalId).toBe('c'))
    spy.mockRestore()
  })
})

describe('placeholder engine-aware do input (SP-C Task 7)', () => {
  it('sessão Claude mostra "Mensagem para o Claude Code…"', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    useStore.setState({ sessions: { a: sess('a', { status: 'idle' }), b: sess('b') } })
    render(<ChatView />)
    expect(await screen.findByPlaceholderText('Mensagem para o Claude Code… (arraste ou cole arquivos)')).toBeTruthy()
    spy.mockRestore()
  })

  it('sessão Codex mostra "Mensagem para o Codex…"', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
    useStore.setState({ sessions: { a: sess('a', { status: 'idle', engine: 'codex' }), b: sess('b') } })
    render(<ChatView />)
    expect(await screen.findByPlaceholderText('Mensagem para o Codex… (arraste ou cole arquivos)')).toBeTruthy()
    spy.mockRestore()
  })
})

it('1ª mensagem otimista NÃO some quando o init chega com o transcript ainda vazio (corrida)', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  useStore.setState({
    sessions: { a: sess('a', { status: 'starting', engineSessionId: null }) },
    chat: { a: [{ kind: 'user_text', text: 'primeira mensagem' }] },
    historyLoadedFor: { a: '(preview)' },
    activeLocalId: 'a',
  })
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
  // init chega: engineSessionId setado, status vira working — mas o transcript da
  // engine ainda não gravou a mensagem (fetchHistory devolve []).
  act(() => {
    useStore.setState((s) => ({ sessions: { a: { ...s.sessions.a, status: 'working', engineSessionId: 'real-1' } as SessionInfo } }))
  })
  await waitFor(() => expect(useStore.getState().historyLoadedFor.a).toBe('real-1'))
  // a mensagem otimista sobreviveu (a re-busca vazia NÃO encolheu a conversa)
  expect(useStore.getState().chat.a.some((i) => i.kind === 'user_text' && (i as { text: string }).text === 'primeira mensagem')).toBe(true)
})

it('engine com CLI não instalada: aba mostra "não instalada" e NÃO oferece o ▶', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse([])))
  useStore.setState({
    engines: [CLAUDE, { ...CODEX, available: false, installHint: 'npm install -g @openai/codex' }],
    sessions: { a: sess('a', { status: 'idle' }) }, // só claude vivo
    activeLocalId: 'a',
  })
  render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
  const badge = await screen.findByText('não instalada')
  expect(badge).toBeTruthy()
  expect(badge.getAttribute('title')).toContain('npm install -g @openai/codex')
  // nenhum botão de iniciar o Codex
  expect(screen.queryByTitle('Iniciar Codex')).toBeNull()
})
