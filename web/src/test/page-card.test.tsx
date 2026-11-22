import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// O `viewPage` é espiado (cada chamada devolve um token novo); listPages e getPage seguem pelo fetch.
vi.mock('../pages/api', async (orig) => ({ ...(await orig<typeof import('../pages/api')>()), viewPage: vi.fn() }))

import { viewPage } from '../pages/api'
import { PageCard } from '../components/PageCard'
import { PageFullscreen, PageFullscreenHost } from '../components/PageFullscreen'
import { MessageBlock } from '../components/MessageBlock'
import { ChatView } from '../components/ChatView'
import { applyPagesWsMessage, usePagesStore } from '../pages/pagesStore'
import { useStore } from '../store'
import { useUndoStore } from '../undo/undoStore'
import { WsContext } from '../wsContext'
import { chatFollow } from '../chat/listHandle'
import { renderComJanela } from './viewport'
import { PAGE_HEIGHT_MESSAGE, type VisualPageDto } from '../../../shared/visual-pages'
import { turnKey } from '../../../shared/undo'
import type { ChatItem, EngineMeta, SessionInfo } from '../types'

const PG1 = 'pg_0000000000000001'
const PG2 = 'pg_0000000000000002'
const PG3 = 'pg_0000000000000003'

const page = (id: string, localId = 'a', over: Partial<VisualPageDto> = {}): VisualPageDto => ({
  id, projectId: 1, engine: 'claude', localId, conversationId: 'c', turnId: 1, turnKey: 'faça',
  title: 'Gráfico', height: null, bytes: 3000, source: 'html', createdAt: '2026-11-21 12:00:00', ...over,
})
const event = (p: VisualPageDto) => ({ type: 'visual_page', projectId: p.projectId, engine: p.engine, localId: p.localId, page: p })
/** O texto que o `show_page` do hermes devolve. */
const shown = (id: string) => `page shown to the operator (id ${id}, 3 KB)`
const call = (key: string, result?: string, over: Partial<Extract<ChatItem, { kind: 'tool_call' }>> = {}): ChatItem =>
  ({ kind: 'tool_call', id: `t-${key}`, key, name: 'mcp__hermes__show_page', input: { title: 'Gráfico', html: '<p>x</p>' }, result, ...over })

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const errJson = (status: number) => new Response(JSON.stringify({ error: 'x' }), { status, headers: { 'Content-Type': 'application/json' } })
const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status })

// ── IntersectionObserver dublado: só avisa quando o teste manda ──
interface FakeObs { cb: IntersectionObserverCallback; els: Set<Element> }
let observers: FakeObs[] = []
class FakeIO {
  private o: FakeObs
  constructor(cb: IntersectionObserverCallback) { this.o = { cb, els: new Set() }; observers.push(this.o) }
  observe(el: Element) { this.o.els.add(el) }
  unobserve(el: Element) { this.o.els.delete(el) }
  disconnect() { this.o.els.clear(); observers = observers.filter(x => x !== this.o) }
  takeRecords() { return [] }
  root = null
  rootMargin = ''
  thresholds: number[] = []
}
/** Os cartões observados (ou só o que contém/está em `card`) entram ou saem da tela. */
function tela(on: boolean, card?: Element) {
  act(() => {
    for (const o of [...observers]) for (const el of [...o.els]) {
      if (card && !card.contains(el) && !el.contains(card)) continue
      o.cb([{ target: el, isIntersecting: on } as unknown as IntersectionObserverEntry], o as unknown as IntersectionObserver)
    }
  })
}

const view = vi.mocked(viewPage)
let tok = 0
const urlOf = (id: string, n: number) => `/api/pages/view/${id}/t${n}`

beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
  tok = 0
  view.mockReset()
  view.mockImplementation(async (id: string) => ({ url: urlOf(id, ++tok) }))
  usePagesStore.setState({ byLocal: {}, byId: {}, livePageId: null, fullPageId: null })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const cardOf = (title: string) => screen.getByText(title).closest<HTMLElement>('.page-card')!
const frameIn = (root: ParentNode = document) => root.querySelector('iframe')
async function frameUrl(root: ParentNode = document) {
  return waitFor(() => {
    const f = frameIn(root)
    expect(f?.getAttribute('src')).toBeTruthy()
    return f!
  })
}

describe('PageCard', () => {
  it('parado por padrão no histórico: nenhum iframe, título, KB e Ver página', () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    const { container } = render(<PageCard pageId={PG1} localId="a" />)
    screen.getByText('Gráfico')
    screen.getByText('3 KB')
    screen.getByRole('button', { name: 'Ver página' })
    tela(true)
    expect(frameIn(container)).toBeNull()
    expect(view).not.toHaveBeenCalled()
  })

  it('Ver página monta o iframe com sandbox="allow-scripts", referrerpolicy no-referrer, sem allow e sem srcdoc', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    const { container } = render(<PageCard pageId={PG1} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    expect(usePagesStore.getState().livePageId).toBe(PG1)
    tela(true)
    const f = await frameUrl(container)
    expect(f.getAttribute('src')).toBe(urlOf(PG1, 1))
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(f.hasAttribute('allow')).toBe(false)
    expect(f.hasAttribute('srcdoc')).toBe(false)
    // Cabeçalho da viva.
    screen.getByRole('button', { name: 'Tela cheia' })
    screen.getByRole('button', { name: 'Nova aba' })
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(usePagesStore.getState().livePageId).toBeNull()
    expect(frameIn(container)).toBeNull()
    screen.getByRole('button', { name: 'Ver página' })
  })

  it('uma viva por vez: abrir a segunda devolve a primeira à linha estática', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1, 'a', { title: 'Um' }), [PG2]: page(PG2, 'a', { title: 'Dois' }) } })
    render(<><PageCard pageId={PG1} localId="a" /><PageCard pageId={PG2} localId="a" /></>)
    fireEvent.click(within(cardOf('Um')).getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl(cardOf('Um'))
    fireEvent.click(within(cardOf('Dois')).getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl(cardOf('Dois'))
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
    expect(frameIn(cardOf('Um'))).toBeNull()
    within(cardOf('Um')).getByRole('button', { name: 'Ver página' })
  })

  it('saiu da tela: o iframe desmonta; voltou e ainda é a viva: monta de novo com token novo (viewPage chamado duas vezes)', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1), [PG2]: page(PG2) } })
    const { container } = render(<PageCard pageId={PG1} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    expect((await frameUrl(container)).getAttribute('src')).toBe(urlOf(PG1, 1))
    tela(false)
    expect(frameIn(container)).toBeNull()
    // Ainda é a viva: o cabeçalho fica, sem iframe.
    expect(usePagesStore.getState().livePageId).toBe(PG1)
    tela(true)
    expect((await frameUrl(container)).getAttribute('src')).toBe(urlOf(PG1, 2))
    expect(view).toHaveBeenCalledTimes(2)
    // Fora da tela, outra virou a viva: na volta, nada recarrega.
    tela(false)
    act(() => usePagesStore.getState().setLive(PG2))
    tela(true)
    expect(frameIn(container)).toBeNull()
    expect(view).toHaveBeenCalledTimes(2)
  })

  it('altura: mensagem do próprio iframe ajusta; de outra janela é ignorada; NaN, negativo e "300" ignorados; 1e9 limita a 70% da janela; 50 limita a 120', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    const { container } = render(<PageCard pageId={PG1} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    const f = await frameUrl(container)
    expect(f.style.height).toBe('360px')
    const outro = document.createElement('iframe')
    document.body.appendChild(outro)
    const post = (height: unknown, source: Window | null = f.contentWindow, type = PAGE_HEIGHT_MESSAGE) =>
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type, height }, source })) })

    post(500)
    expect(f.style.height).toBe('500px')
    post(640, outro.contentWindow)
    post(640, null)
    post(640, f.contentWindow, 'outra-coisa')
    expect(f.style.height).toBe('500px')
    post(NaN)
    post(-20)
    post('300')
    post(Infinity)
    expect(f.style.height).toBe('500px')
    post(1e9)
    expect(f.style.height).toBe(`${Math.floor(window.innerHeight * 0.7)}px`)
    post(50)
    expect(f.style.height).toBe('120px')
    outro.remove()
  })

  it('altura inicial: a sugerida pela página', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1, 'a', { height: 240 }) } })
    const { container } = render(<PageCard pageId={PG1} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    expect((await frameUrl(container)).style.height).toBe('240px')
  })

  it('a viva do chat que cresce pela altura da página avisa o chat (chatFollow.grew) com quanto cresceu; encolher, a primeira altura e a da lista não avisam', async () => {
    const grew = vi.fn()
    const antes = chatFollow.grew
    chatFollow.grew = grew
    try {
      usePagesStore.setState({ byId: { [PG1]: page(PG1, 'a', { height: 200 }) } })
      const { container, unmount } = render(<PageCard pageId={PG1} localId="a" />)
      fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
      tela(true)
      const f = await frameUrl(container)
      const post = (height: number, frame = f) =>
        act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: PAGE_HEIGHT_MESSAGE, height }, source: frame.contentWindow })) })
      // Abrir (a primeira altura) não avisa: a lista virtual acompanha o item que muda.
      expect(grew).not.toHaveBeenCalled()
      post(365)
      expect(grew).toHaveBeenCalledTimes(1)
      expect(grew).toHaveBeenLastCalledWith(165)
      post(300)
      expect(grew).toHaveBeenCalledTimes(1)
      post(320)
      expect(grew).toHaveBeenLastCalledWith(20)
      unmount()

      // Na lista "Páginas desta conversa" o chat não tem nada com isso.
      grew.mockClear()
      act(() => usePagesStore.getState().setLive(null))
      const lista = render(<PageCard pageId={PG1} localId="a" place="list" />)
      fireEvent.click(within(lista.container).getByRole('button', { name: 'Ver página' }))
      tela(true)
      const g = await frameUrl(lista.container)
      post(500, g)
      expect(g.style.height).toBe('500px')
      expect(grew).not.toHaveBeenCalled()
    } finally {
      chatFollow.grew = antes
    }
  })

  it('tela cheia: token novo, o cartão volta a parado, Esc fecha', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    const { container } = render(<><PageCard pageId={PG1} localId="a" /><PageFullscreenHost /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl(container)
    fireEvent.click(screen.getByRole('button', { name: 'Tela cheia' }))
    expect(usePagesStore.getState().livePageId).toBeNull()
    const dialog = await screen.findByRole('dialog')
    expect((await frameUrl(dialog)).getAttribute('src')).toBe(urlOf(PG1, 2))
    const f = frameIn(dialog)!
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer')
    // O cartão, fora do diálogo, voltou à linha estática.
    expect(frameIn(container)).toBeNull()
    within(container).getByRole('button', { name: 'Ver página' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(usePagesStore.getState().fullPageId).toBeNull()
  })

  it('tela cheia: o ✕ fecha', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    render(<><PageCard pageId={PG1} localId="a" /><PageFullscreenHost /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl()
    fireEvent.click(screen.getByRole('button', { name: 'Tela cheia' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar tela cheia' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('tela cheia: ao fechar, o foco volta ao "Ver página" do cartão (o "Tela cheia" sumiu com a viva)', async () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    const { container } = render(<><PageCard pageId={PG1} localId="a" /><PageFullscreenHost /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl(container)
    const full = screen.getByRole('button', { name: 'Tela cheia' })
    act(() => full.focus())
    fireEvent.click(full)
    const dialog = await screen.findByRole('dialog')
    expect(full.isConnected).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar tela cheia' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(within(container).getByRole('button', { name: 'Ver página' }))

    // Esc também devolve o foco ao cartão.
    fireEvent.click(within(container).getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl(container)
    fireEvent.click(screen.getByRole('button', { name: 'Tela cheia' }))
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(within(container).getByRole('button', { name: 'Ver página' }))
  })

  it('nova aba: window.open com a url do token novo, _blank e noopener,noreferrer', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    const { container } = render(<PageCard pageId={PG1} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl(container)
    fireEvent.click(screen.getByRole('button', { name: 'Nova aba' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith(urlOf(PG1, 2), '_blank', 'noopener,noreferrer'))
    expect(view).toHaveBeenCalledTimes(2)
  })

  it('404 no view: Página apagada; 500: Não carregou com tentar de novo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    usePagesStore.setState({ byId: { [PG1]: page(PG1, 'a', { title: 'Um' }), [PG2]: page(PG2, 'a', { title: 'Dois' }) } })
    view.mockRejectedValueOnce(httpError(404))
    const { unmount } = render(<PageCard pageId={PG1} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    await screen.findByText('Página apagada')
    expect(frameIn()).toBeNull()
    unmount()

    view.mockRejectedValueOnce(httpError(500))
    render(<PageCard pageId={PG2} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    const retry = await screen.findByRole('button', { name: 'Não carregou — tentar de novo' })
    expect(frameIn()).toBeNull()
    fireEvent.click(retry)
    expect((await frameUrl()).getAttribute('src')).toMatch(/^\/api\/pages\/view\/pg_0000000000000002\//)
    // O 404 é a página apagada, sem aviso; o 500 avisa no console.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[páginas] o endereço da página não veio', PG2, expect.objectContaining({ status: 500 }))
  })

  it('nova aba que falha: "Não carregou — tentar de novo" é botão, tenta de novo e some quando a aba abre', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    usePagesStore.setState({ byId: { [PG1]: page(PG1) } })
    const { container } = render(<PageCard pageId={PG1} localId="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver página' }))
    tela(true)
    await frameUrl(container)
    view.mockRejectedValueOnce(httpError(500))
    fireEvent.click(screen.getByRole('button', { name: 'Nova aba' }))
    const retry = await within(container).findByRole('button', { name: 'Não carregou — tentar de novo' })
    expect(open).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[páginas] a nova aba não abriu', PG1, expect.objectContaining({ status: 500 }))
    fireEvent.click(retry)
    await waitFor(() => expect(open).toHaveBeenCalledWith(urlOf(PG1, 2), '_blank', 'noopener,noreferrer'))
    expect(within(container).queryByRole('button', { name: 'Não carregou — tentar de novo' })).toBeNull()
  })

  it('tela cheia prende o Tab: o foco entra no diálogo; Shift+Tab vai à página, Tab nela volta ao ✕; quem sai do fim da página cai de volta no ✕', async () => {
    const onClose = vi.fn()
    render(<><textarea aria-label="campo do chat" /><PageFullscreen page={page(PG1)} onClose={onClose} /></>)
    const dialog = screen.getByRole('dialog')
    const f = await frameUrl(dialog)
    const x = within(dialog).getByRole('button', { name: 'Fechar tela cheia' })
    expect(document.activeElement).toBe(dialog)
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(f)
    expect(fireEvent.keyDown(f, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(x)
    expect(fireEvent.keyDown(x, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(f)
    // O Tab de dentro da página não passa pelo diálogo: o foco sai do iframe
    // para o próximo da janela, a guarda logo depois do diálogo, que o devolve ao ✕.
    const guard = document.querySelector<HTMLElement>('[data-focus-guard]')
    expect(guard).not.toBeNull()
    act(() => guard!.focus())
    expect(document.activeElement).toBe(x)
    expect(screen.getByLabelText('campo do chat')).not.toBe(document.activeElement)
    fireEvent.keyDown(x, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('id fora da lista da conversa: busca por id; 404 vira Página indisponível', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url) === `/api/pages/${PG3}` ? errJson(404) : okJson(page(PG2, 'a', { title: 'Achada' })))
    render(<><PageCard pageId={PG3} localId="a" /><PageCard pageId={PG2} localId="a" /></>)
    await screen.findByText('Página indisponível')
    await screen.findByText('Achada')
    const urls = fetch.mock.calls.map(([u]) => String(u))
    expect(urls).toContain(`/api/pages/${PG3}`)
    expect(urls).toContain(`/api/pages/${PG2}`)
  })

  it('show_page de subagente também vira o cartão', () => {
    usePagesStore.setState({ byId: { [PG1]: page(PG1, 'a', { title: 'Do subagente' }) } })
    render(<MessageBlock item={call('k9', shown(PG1), { fromSubagent: true })} currentLocalId="a" />)
    screen.getByText('Do subagente')
    screen.getByRole('button', { name: 'Ver página' })
  })
})

// ── No ChatView, com os stores reais ──
const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}
const sess = (localId: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ localId, projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine: 'claude', ...over })

function setupChat(chat: Record<string, ChatItem[]>, lists: Record<string, VisualPageDto[]>, status: SessionInfo['status'] = 'idle') {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  useUndoStore.setState({ byLocal: {}, terminalOf: {} })
  const ids = Object.keys(chat)
  useStore.setState({
    projects: [{ id: 1, name: 'P', path: '/tmp', color: '#fff', icon: '📁' }],
    sessions: Object.fromEntries(ids.map(id => [id, sess(id, { status })])),
    chat, unread: {}, streaming: {},
    historyLoadedFor: Object.fromEntries(ids.map(id => [id, 'c'])),
    historyCursor: Object.fromEntries(ids.map(id => [id, { before: 0, atStart: true, conv: 'c' }])),
    view: 'chat', activeLocalId: ids[0], engines: [CLAUDE],
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const m = /^\/api\/sessions\/([^/]+)\/pages$/.exec(String(url))
    return okJson(m ? lists[m[1]] ?? [] : [])
  })
}
const renderChat = () => renderComJanela(<WsContext.Provider value={{ send: vi.fn() }}><ChatView /></WsContext.Provider>)

describe('PageCard no ChatView', () => {
  it('conversa aberta: o cartão da chamada espera a lista e não busca a página pelo id', async () => {
    setupChat(
      { a: [{ kind: 'user_text', text: 'faça', key: 'a0' }, call('a1', shown(PG1))] },
      { a: [page(PG1, 'a', { title: 'Página A' })] },
    )
    // A lista demora (como na rede): o cartão monta antes dela chegar.
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const fetch = vi.mocked(globalThis.fetch)
    const base = fetch.getMockImplementation()!
    fetch.mockImplementation(async (url, init) => {
      if (String(url) === '/api/sessions/a/pages') await gate
      return base(url, init)
    })
    renderChat()
    await screen.findByText('Carregando página…')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { release() })
    await screen.findByText('Página A')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const urls = fetch.mock.calls.map(([u]) => String(u))
    expect(urls).toContain('/api/sessions/a/pages')
    expect(urls).not.toContain(`/api/pages/${PG1}`)
  })

  it('tela cheia fora da lista virtual: o cartão sai da conversa e a tela cheia fica, com o mesmo token', async () => {
    setupChat(
      { a: [{ kind: 'user_text', text: 'faça', key: 'a0' }, call('a1', shown(PG1)), { kind: 'assistant_text', text: 'feito', key: 'a2' }] },
      { a: [page(PG1, 'a', { title: 'Página A' })] },
    )
    renderChat()
    await screen.findByText('Página A')
    fireEvent.click(within(cardOf('Página A')).getByText('Ver página'))
    tela(true)
    await frameUrl(cardOf('Página A'))
    fireEvent.click(within(cardOf('Página A')).getByText('Tela cheia'))
    expect(usePagesStore.getState().livePageId).toBeNull()
    const dialog = await screen.findByRole('dialog')
    expect((await frameUrl(dialog)).getAttribute('src')).toBe(urlOf(PG1, 2))

    // A lista virtual desmonta o cartão (aqui, a conversa troca de trecho).
    act(() => useStore.setState({ chat: { a: [{ kind: 'user_text', text: 'outra coisa', key: 'z0' }] } }))
    await waitFor(() => expect(document.querySelectorAll('.page-card')).toHaveLength(0))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(frameIn(dialog)!.getAttribute('src')).toBe(urlOf(PG1, 2))
    expect(view).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(usePagesStore.getState().fullPageId).toBeNull()
  })

  it('tela cheia aberta quando a página passa do fim do turno ao lugar da chamada: continua aberta, sem token novo', async () => {
    const items: ChatItem[] = [
      { kind: 'user_text', text: 'faça o gráfico', key: 'k0' },
      call('k1'),
      { kind: 'assistant_text', text: 'pronto, está aí', key: 'k2' },
    ]
    setupChat({ a: items }, { a: [] }, 'working')
    renderChat()
    await screen.findByText('pronto, está aí')
    await waitFor(() => expect(usePagesStore.getState().byLocal.a).toEqual([]))
    act(() => applyPagesWsMessage(event(page(PG1, 'a', { title: 'Gráfico vivo', turnId: 7, turnKey: turnKey('faça o gráfico') }))))
    await screen.findByText('Gráfico vivo')
    tela(true)
    await frameUrl(cardOf('Gráfico vivo'))
    fireEvent.click(within(cardOf('Gráfico vivo')).getByText('Tela cheia'))
    const dialog = await screen.findByRole('dialog')
    expect((await frameUrl(dialog)).getAttribute('src')).toBe(urlOf(PG1, 2))

    act(() => useStore.setState({ chat: { a: [items[0], call('k1', shown(PG1)), items[2]] } }))
    await waitFor(() => expect(document.querySelector<HTMLElement>('.page-card')!.closest<HTMLElement>('.chat-entry')!.dataset.key).toBe('k1'))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(frameIn(dialog)!.getAttribute('src')).toBe(urlOf(PG1, 2))
    expect(view).toHaveBeenCalledTimes(2)
  })

  it('trocar de terminal fecha a tela cheia', async () => {
    setupChat(
      { a: [{ kind: 'user_text', text: 'faça', key: 'a0' }, call('a1', shown(PG1))],
        b: [{ kind: 'user_text', text: 'outro', key: 'b0' }] },
      { a: [page(PG1, 'a', { title: 'Página A' })], b: [] },
    )
    renderChat()
    await screen.findByText('Página A')
    fireEvent.click(within(cardOf('Página A')).getByText('Ver página'))
    fireEvent.click(within(cardOf('Página A')).getByText('Tela cheia'))
    await screen.findByRole('dialog')
    act(() => useStore.setState({ activeLocalId: 'b' }))
    await screen.findByText('outro')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(usePagesStore.getState().fullPageId).toBeNull()
  })

  it('visual_page ao vivo do terminal ativo monta sozinho; de outro terminal fica parado; trocar de terminal descarrega', async () => {
    setupChat(
      { a: [{ kind: 'user_text', text: 'faça', key: 'a0' }, call('a1', shown(PG1))],
        b: [{ kind: 'user_text', text: 'outro', key: 'b0' }, call('b1', shown(PG2))] },
      { a: [page(PG1, 'a', { title: 'Página A' })], b: [page(PG2, 'b', { title: 'Página B' })] },
    )
    renderChat()
    await screen.findByText('Página A')
    tela(true)
    expect(frameIn()).toBeNull()

    act(() => applyPagesWsMessage(event(page(PG1, 'a', { title: 'Página A' }))))
    expect(usePagesStore.getState().livePageId).toBe(PG1)
    tela(true)
    expect((await frameUrl(cardOf('Página A'))).getAttribute('src')).toBe(urlOf(PG1, 1))

    // De outro terminal: entra parada, a viva segue a mesma.
    act(() => applyPagesWsMessage(event(page(PG2, 'b', { title: 'Página B' }))))
    expect(usePagesStore.getState().livePageId).toBe(PG1)

    act(() => useStore.setState({ activeLocalId: 'b' }))
    await screen.findByText('Página B')
    expect(usePagesStore.getState().livePageId).toBeNull()
    tela(true)
    expect(frameIn()).toBeNull()
    // A lista virtual recém-trocada ainda mede os itens (escondidos): o texto basta.
    within(cardOf('Página B')).getByText('Ver página')
  })

  it('evento antes do resultado: a página aparece no fim do turno e, quando o tool_call ganha o resultado, sai do fim do turno e aparece no lugar da chamada, viva, uma vez só', async () => {
    const items: ChatItem[] = [
      { kind: 'user_text', text: 'faça o gráfico', key: 'k0' },
      call('k1'),
      { kind: 'assistant_text', text: 'pronto, está aí', key: 'k2' },
    ]
    setupChat({ a: items }, { a: [] }, 'working')
    renderChat()
    await screen.findByText('pronto, está aí')
    await waitFor(() => expect(usePagesStore.getState().byLocal.a).toEqual([]))

    act(() => applyPagesWsMessage(event(page(PG1, 'a', { title: 'Gráfico vivo', turnId: 7, turnKey: turnKey('faça o gráfico') }))))
    expect(usePagesStore.getState().livePageId).toBe(PG1)
    await screen.findByText('Gráfico vivo')
    expect(document.querySelectorAll('.page-card')).toHaveLength(1)
    // No fim do bloco do turno: depois do último item.
    expect(cardOf('Gráfico vivo').closest<HTMLElement>('.chat-entry')!.dataset.key).toBe('k2')
    tela(true)
    await frameUrl(cardOf('Gráfico vivo'))

    // O resultado chega: o cartão passa ao lugar da chamada.
    act(() => useStore.setState({ chat: { a: [items[0], call('k1', shown(PG1)), items[2]] } }))
    await waitFor(() => expect(cardOf('Gráfico vivo').closest<HTMLElement>('.chat-entry')!.dataset.key).toBe('k1'))
    expect(document.querySelectorAll('.page-card')).toHaveLength(1)
    expect(usePagesStore.getState().livePageId).toBe(PG1)
    tela(true)
    await frameUrl(cardOf('Gráfico vivo'))
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
  })
})

describe('a viva que cresce no chat (ensaio B2)', () => {
  /** A caixa de rolagem do chat com a geometria plantada; devolve o scrollTop que ela recebeu. */
  const geometria = (scrollTop: number, scrollHeight: number, clientHeight: number) => {
    const el = screen.getByTestId('chat-scroll')
    let top = scrollTop
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v }, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true, writable: true })
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
    return () => top
  }
  const post = (f: HTMLIFrameElement, height: number) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: PAGE_HEIGHT_MESSAGE, height }, source: f.contentWindow })) })

  async function vivaNoChat() {
    setupChat(
      { a: [{ kind: 'user_text', text: 'faça', key: 'a0' }, call('a1', shown(PG1))] },
      { a: [page(PG1, 'a', { title: 'Página A', height: 200 })] },
      'working',
    )
    renderChat()
    await screen.findByText('Página A')
    act(() => applyPagesWsMessage(event(page(PG1, 'a', { title: 'Página A', height: 200 }))))
    tela(true)
    return frameUrl(cardOf('Página A'))
  }

  it('preso no fim, a página que cresce dentro do cartão puxa a tela ao fim, mesmo dentro da folga', async () => {
    const f = await vivaNoChat()
    // O chat cabia na tela; a página cresceu 165 px e ficou 50 px além do fim,
    // menos que a folga do "no fim": a lista virtual não puxa sozinha.
    const top = geometria(0, 808, 758)
    post(f, 365)
    expect(top()).toBe(808)
  })

  it('lendo mais acima, a página que cresce não puxa a tela', async () => {
    const f = await vivaNoChat()
    const top = geometria(0, 3000, 758)
    post(f, 365)
    expect(top()).toBe(0)
  })
})

describe('pages.css', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  // Sem os comentários: eles podem citar o que a regra proíbe.
  const css = readFileSync(join(here, '..', 'pages', 'pages.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('pages.css sem backdrop-filter nem animation', () => {
    expect(css).toMatch(/\.page-card\b/)
    expect(css).not.toMatch(/backdrop-filter/)
    expect(css).not.toMatch(/(^|[\s;{])animation(-name)?\s*:/)
    expect(css).not.toMatch(/@keyframes/)
    // Transição, só para desligar a do botão base; nenhuma de sombra.
    for (const m of css.matchAll(/transition[a-z-]*\s*:\s*([^;}]*)/g)) expect(m[1].trim()).toBe('none')
    expect(css).not.toMatch(/background-image\s*:\s*url/)
  })
})
