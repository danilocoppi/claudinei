import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
// A conversa é uma lista virtual: sem medidas fixas, o jsdom não montaria nada.
import { renderComJanela as render } from './viewport'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import { ChatView } from '../components/ChatView'
import { ChatInput } from '../components/ChatInput'
import { SideColumn } from '../components/SideColumn'
import { WsContext } from '../wsContext'
import { useStore } from '../store'
import { applySideMessage, useSideStore } from '../branch/sideStore'
import type { SideFiles, SideInfo } from '../branch/api'
import type { ChatItem, EngineMeta, SessionInfo } from '../types'

/**
 * A coluna da conversa lateral: no lugar da do acompanhamento enquanto a
 * lateral existe; cabeçalho com motor, corte e aviso de arquivos; a conversa;
 * o campo próprio; e o Trazer de volta, que acrescenta a última resposta ao
 * campo da principal. Sem rostinho e sem animação (frontend sem GPU).
 */

const meta = (id: string, label: string, midTurnInput: boolean): EngineMeta => ({
  id, label, icon: id, models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [], midTurnInput,
})
const ENGINES = [meta('claude', 'Claude Code', true), meta('codex', 'Codex', true), meta('opencode', 'OpenCode', false), meta('kimi', 'Kimi', false)]
const FILES: Record<string, SideFiles> = { claude: 'no_edit_tools', codex: 'read_only', opencode: 'no_edit_tools', kimi: 'can_write' }

const sess = (localId: string, o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...o })
const info = (o: Partial<SideInfo> = {}): SideInfo => {
  const engine = o.engine ?? 'claude'
  return {
    id: `side-${engine}`, projectId: 1, engine, status: 'idle', mode: 'native', cutAt: null,
    files: FILES[engine] ?? 'no_edit_tools', question: null, openedAt: '2026-11-21T12:00:00Z', ...o,
  }
}
const user = (text: string): ChatItem => ({ kind: 'user_text', text })
const agent = (text: string): ChatItem => ({ kind: 'assistant_text', text })
const put = (i: SideInfo, items: ChatItem[] = []) =>
  useSideStore.setState((s) => ({ sides: { ...s.sides, [`${i.projectId}:${i.engine}`]: { info: i, items } } }))

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Rotas falsas: a lateral do servidor por motor, o resto vazio. */
function api(server: Record<string, { side: SideInfo | null; events: unknown[] }> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('/side')) {
      if (method !== 'GET') return new Response(null, { status: 204 })
      const engine = new URL(u, 'http://x').searchParams.get('engine') ?? ''
      return json(server[engine] ?? { side: null, events: [] })
    }
    if (u.includes('/history')) return json({ events: [], before: 0, atStart: true })
    if (u.includes('/progress')) return json({ progress: null, path: '' })
    if (u === '/api/uploads') {
      const f = (init!.body as FormData).get('file') as File
      return json({ path: `/ups/${f.name}`, name: f.name }, 201)
    }
    return json([])
  })
}

/** A coluna como o ChatView a monta; ela só aparece enquanto a lateral existe no store. */
function Coluna({ engine = 'claude', localId = 'a' }: { engine?: string; localId?: string }) {
  return <SideColumn projectId={1} engine={engine} localId={localId} />
}

beforeEach(() => {
  localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null })
  useStore.setState({
    authStatus: 'ready',
    progressEpoch: 0,
    progress: {},
    progressOpen: true,
    projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁', engines: ['claude', 'codex'] }],
    terminalStates: {},
    sessions: { a: sess('a'), b: sess('b', { engine: 'codex' }) },
    chat: { a: [], b: [] },
    unread: {},
    streaming: {},
    historyLoadedFor: {},
    view: 'chat',
    activeLocalId: 'a',
    engines: ENGINES,
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('no ChatView', () => {
  it('a coluna aparece no lugar da de acompanhamento e ela volta ao fechar', async () => {
    const fetch = api()
    const { container } = render(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)
    await waitFor(() => expect(container.querySelector('aside.progress')).toBeTruthy())
    expect(container.querySelector('.side-col')).toBeNull()

    act(() => { applySideMessage({ type: 'side_state', projectId: 1, engine: 'claude', side: info() }) })
    expect(container.querySelector('.side-col')).toBeTruthy()
    expect(container.querySelector('aside.progress')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Fechar a conversa lateral' }))
    await waitFor(() => expect(container.querySelector('.side-col')).toBeNull())
    expect(container.querySelector('aside.progress')).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/api/projects/1/side?engine=claude', expect.objectContaining({ method: 'DELETE' }))
  })

  it('trocar de aba de motor mostra a lateral daquele motor', async () => {
    api({
      claude: { side: info({ question: 'do claude' }), events: [] },
      codex: { side: info({ engine: 'codex', question: 'do codex' }), events: [] },
    })
    put(info(), [user('pergunta do claude')])
    put(info({ engine: 'codex' }), [user('pergunta do codex')])
    const ui = <WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>
    const { container, rerender } = render(ui)
    await waitFor(() => expect(container.querySelector('.side-col')?.textContent).toContain('pergunta do claude'))
    expect(container.querySelector('.side-col')?.textContent).toContain('Claude Code')

    act(() => { useStore.setState({ activeLocalId: 'b' }) })
    rerender(ui)
    await waitFor(() => expect(container.querySelector('.side-col')?.textContent).toContain('pergunta do codex'))
    expect(container.querySelector('.side-col')?.textContent).not.toContain('pergunta do claude')
    expect(screen.getByText('Só leitura')).toBeTruthy()
  })
})

describe('cabeçalho', () => {
  it('aviso de arquivos por motor', () => {
    api()
    const casos: Array<[string, string]> = [
      ['codex', 'Só leitura'],
      ['claude', 'Sem ferramentas de edição — comandos de shell ainda podem alterar arquivos'],
      ['opencode', 'Sem ferramentas de edição — comandos de shell ainda podem alterar arquivos'],
      ['kimi', 'Pode alterar arquivos da pasta'],
    ]
    for (const [engine, texto] of casos) {
      put(info({ engine }))
      const { unmount } = render(<Coluna engine={engine} />)
      expect(screen.getByText(texto)).toBeTruthy()
      unmount()
    }
  })

  it('título, motor, "cópia até HH:MM" e o ponto de status estático', () => {
    api()
    const cut = new Date(2026, 10, 21, 9, 5)
    put(info({ cutAt: cut.toISOString(), status: 'working' }))
    const { container } = render(<Coluna />)
    expect(screen.getByText('Conversa lateral')).toBeTruthy()
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('cópia até 09:05')).toBeTruthy()
    const dot = container.querySelector('.side-col .status-dot')!
    expect(dot.className).toContain('status-working')
    expect(dot.className).not.toContain('status-dot--pulse')
  })

  it('sem corte, sem "cópia até"', () => {
    api()
    put(info({ cutAt: null }))
    render(<Coluna />)
    expect(screen.queryByText(/cópia até/)).toBeNull()
  })

  it('× trabalhando pede confirmação; ocioso fecha direto', async () => {
    const fetch = api()
    put(info({ status: 'working' }))
    render(<Coluna />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechar a conversa lateral' }))
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/side'), expect.objectContaining({ method: 'DELETE' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/1/side?engine=claude', expect.objectContaining({ method: 'DELETE' })))
    await waitFor(() => expect(useSideStore.getState().sides['1:claude']).toBeUndefined())

    cleanup(); fetch.mockClear()
    put(info({ status: 'idle' }))
    render(<Coluna />)
    fireEvent.click(screen.getByRole('button', { name: 'Fechar a conversa lateral' }))
    expect(screen.queryByRole('button', { name: 'Fechar' })).toBeNull()
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/1/side?engine=claude', expect.objectContaining({ method: 'DELETE' })))
  })

  it('sem rostinho: a coluna não renderiza AgentFace', () => {
    api()
    put(info({ status: 'working' }), [user('p'), agent('r')])
    const { container } = render(<Coluna />)
    expect(container.querySelector('[class*="agent-face"]')).toBeNull()
  })
})

describe('corpo', () => {
  it('a conversa da lateral, sem lápis de editar', () => {
    api()
    put(info(), [user('qual o status?'), agent('tudo certo')])
    const { container } = render(<Coluna />)
    expect(screen.getByText('qual o status?')).toBeTruthy()
    expect(screen.getByText('tudo certo')).toBeTruthy()
    expect(container.querySelector('.side-col [aria-label="Editar mensagem"], .side-col .msg-edit')).toBeNull()
  })
})

describe('pé', () => {
  it('Enviar manda o texto à lateral, com os anexos trocados pelos caminhos', async () => {
    const fetch = api()
    put(info())
    render(<Coluna />)
    const campo = screen.getByPlaceholderText('Pergunte na conversa lateral…') as HTMLTextAreaElement
    fireEvent.change(campo, { target: { value: 'e o teste?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/1/side/message', expect.objectContaining({ method: 'POST' })))
    const body = JSON.parse((fetch.mock.calls.find(([u]) => String(u).endsWith('/side/message'))![1]!.body as string))
    expect(body).toEqual({ engine: 'claude', text: 'e o teste?' })
    expect(campo.value).toBe('')

    // Anexo: o token no campo, o caminho no envio.
    const arquivo = new File(['x'], 'log.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('side-attach-input'), { target: { files: [arquivo] } })
    await waitFor(() => expect(campo.value).toContain('[📎 log.txt]'))
    fireEvent.change(campo, { target: { value: `veja ${campo.value}` } })
    fireEvent.keyDown(campo, { key: 'Enter' })
    await waitFor(() => {
      const envios = fetch.mock.calls.filter(([u]) => String(u).endsWith('/side/message'))
      expect(JSON.parse(envios[1][1]!.body as string)).toEqual({ engine: 'claude', text: 'veja /ups/log.txt' })
    })
  })

  it('campo da lateral desabilitado trabalhando no Kimi e habilitado no Claude', () => {
    api()
    put(info({ engine: 'kimi', status: 'working' }))
    put(info({ engine: 'claude', status: 'working' }))
    const { unmount } = render(<Coluna engine="kimi" />)
    expect((screen.getByPlaceholderText('Pergunte na conversa lateral…') as HTMLTextAreaElement).disabled).toBe(true)
    unmount()
    render(<Coluna engine="claude" />)
    expect((screen.getByPlaceholderText('Pergunte na conversa lateral…') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('Parar só trabalhando, e chama o interromper da lateral', async () => {
    const fetch = api()
    put(info({ status: 'idle' }))
    const { unmount } = render(<Coluna />)
    expect(screen.queryByRole('button', { name: 'Parar' })).toBeNull()
    unmount()
    put(info({ status: 'working' }))
    render(<Coluna />)
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/1/side/interrupt', expect.objectContaining({ method: 'POST' })))
  })

  it('Trazer de volta desligado trabalhando', () => {
    api()
    put(info({ status: 'working' }), [user('p'), agent('r')])
    const { unmount } = render(<Coluna />)
    expect((screen.getByRole('button', { name: 'Trazer de volta' }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    // Ocioso, mas sem resposta depois da pergunta: também desligado.
    put(info({ status: 'idle' }), [user('p')])
    const r2 = render(<Coluna />)
    expect((screen.getByRole('button', { name: 'Trazer de volta' }) as HTMLButtonElement).disabled).toBe(true)
    r2.unmount()
    put(info({ status: 'idle' }), [user('p'), agent('r')])
    render(<Coluna />)
    expect((screen.getByRole('button', { name: 'Trazer de volta' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Trazer de volta no campo da principal', () => {
  const ambos = () => render(
    <WsContext.Provider value={{ send: vi.fn() }}>
      <ChatInput localId="a" disabled={false} />
      <Coluna />
    </WsContext.Provider>,
  )
  const principal = () => screen.getByPlaceholderText(/Mensagem para o/) as HTMLTextAreaElement

  it('Trazer de volta acrescenta depois do texto que já havia, sem substituir', async () => {
    api()
    put(info(), [user('por que falhou?'), agent('faltou o import')])
    ambos()
    fireEvent.change(principal(), { target: { value: 'meu rascunho' } })
    fireEvent.click(screen.getByRole('button', { name: 'Trazer de volta' }))
    await waitFor(() => expect(principal().value).toBe('meu rascunho\n\nDa conversa lateral («por que falhou?»):\nfaltou o import'))
    // Campo vazio: entra sozinho, sem linhas em branco na frente.
    fireEvent.change(principal(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Trazer de volta' }))
    await waitFor(() => expect(principal().value).toBe('Da conversa lateral («por que falhou?»):\nfaltou o import'))
  })

  it('resposta com 101 linhas vira anexo lateral-HHMMSS.md e o campo recebe o token', async () => {
    const send = vi.fn()
    const fetch = api()
    const longa = Array.from({ length: 101 }, (_, i) => `linha ${i + 1}`).join('\n')
    put(info(), [user('o log'), agent(longa)])
    render(
      <WsContext.Provider value={{ send }}>
        <ChatInput localId="a" disabled={false} />
        <Coluna />
      </WsContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Trazer de volta' }))
    await waitFor(() => expect(principal().value).toMatch(/^\[📎 lateral-\d{6}\.md\]$/))
    expect(fetch).toHaveBeenCalledWith('/api/uploads', expect.objectContaining({ method: 'POST' }))
    const nome = /lateral-\d{6}\.md/.exec(principal().value)![0]
    // O token vira o caminho no envio, como qualquer anexo do campo.
    fireEvent.click(screen.getAllByRole('button', { name: 'Enviar' })[0])
    expect(send).toHaveBeenCalledWith({ type: 'send_message', localId: 'a', text: `/ups/${nome}` })
  })

  it('o pedido de outro terminal não entra neste campo', async () => {
    api()
    put(info(), [user('p'), agent('r')])
    render(
      <WsContext.Provider value={{ send: vi.fn() }}>
        <ChatInput localId="a" disabled={false} />
        <Coluna localId="z" />
      </WsContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Trazer de volta' }))
    await waitFor(() => expect(useSideStore.getState().appendRequest?.localId).toBe('z'))
    expect(principal().value).toBe('')
  })
})

describe('replaceAsk', () => {
  it('pergunta e, confirmado, abre outra com replace', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === '/api/projects/1/side' && init?.method === 'POST') return json(info({ id: 'side-nova', question: 'outra' }), 201)
      return json({ side: null, events: [] })
    })
    put(info())
    render(<Coluna />)
    act(() => { useSideStore.setState({ replaceAsk: { projectId: 1, engine: 'claude', text: 'outra' } }) })
    expect(screen.getByText('Fechar a conversa lateral atual e abrir outra?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir outra' }))
    await waitFor(() => expect(useSideStore.getState().sides['1:claude']?.info.id).toBe('side-nova'))
    const body = JSON.parse(fetch.mock.calls.find(([u, i]) => String(u) === '/api/projects/1/side' && i?.method === 'POST')![1]!.body as string)
    expect(body).toEqual({ engine: 'claude', text: 'outra', replace: true })
    expect(useSideStore.getState().replaceAsk).toBeNull()
  })

  it('cancelar deixa a lateral atual', () => {
    const fetch = api()
    put(info())
    render(<Coluna />)
    act(() => { useSideStore.setState({ replaceAsk: { projectId: 1, engine: 'claude', text: '' } }) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(useSideStore.getState().replaceAsk).toBeNull()
    expect(fetch).not.toHaveBeenCalledWith('/api/projects/1/side', expect.anything())
  })

  it('o pedido de outro terminal não aparece nesta coluna', () => {
    api()
    put(info())
    render(<Coluna />)
    act(() => { useSideStore.setState({ replaceAsk: { projectId: 1, engine: 'codex', text: '' } }) })
    expect(screen.queryByText('Fechar a conversa lateral atual e abrir outra?')).toBeNull()
  })
})
